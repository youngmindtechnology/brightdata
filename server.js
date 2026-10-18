require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const {
  PORT = 3000,
  PAYSTACK_SECRET_KEY,
  PAYSTACK_PUBLIC_KEY,
  DATAMART_API_KEY,
  DATAMART_BASE_URL = 'https://api.datamartgh.shop/api/developer',
  DATAMART_REF_PREFIX = '',
  MARKUP_PERCENT = '25',
  PACKAGE_CACHE_SECONDS = '300',
  ADMIN_TOKEN,
  FALLBACK_EMAIL = 'atomnharnhar97@gmail.com',
} = process.env;

for (const [k, v] of Object.entries({ PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY, DATAMART_API_KEY })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const MARKUP = Number(MARKUP_PERCENT) / 100;
const CACHE_MS = Number(PACKAGE_CACHE_SECONDS) * 1000;

// Site network key -> DataMart network code
const NETWORKS = { mtn: 'YELLO', telecel: 'TELECEL', airteltigo: 'AT_PREMIUM' };
const CHECKERS = {
  bece: { label: 'BECE Results Checker', price: 20 },
  wassce: { label: 'WASSCE Results Checker', price: 25 },
};

/* ---------------- tiny JSON "database" ---------------- */
const DB_FILE = path.join(__dirname, 'data', 'orders.json');
let orders = {};
let writeChain = Promise.resolve();

async function loadDb() {
  try { orders = JSON.parse(await fs.readFile(DB_FILE, 'utf8')); } catch { orders = {}; }
}
function save() {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(orders, null, 2));
    await fs.rename(tmp, DB_FILE);
  }).catch(e => console.error('DB save failed:', e));
  return writeChain;
}

/* ---------------- helpers ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sellPrice = cost => Math.ceil(cost * (1 + MARKUP) * 100 - 1e-9) / 100; // round UP to the pesewa
const normPhone = p => String(p || '').replace(/[\s\-()]/g, '').replace(/^\+233/, '0').replace(/^233/, '0');
const validPhone = p => /^0\d{9}$/.test(p);
const maskPhone = p => (p && p.length >= 7 ? p.slice(0, 3) + '****' + p.slice(-3) : p);

/* ---------------- DataMart packages (cached, markup applied) ---------------- */
let pkgCache = { at: 0, data: null }; // data: { mtn: [{capacity,size,cost,price}], ... }

async function getPackages() {
  if (pkgCache.data && Date.now() - pkgCache.at < CACHE_MS) return pkgCache.data;
  try {
    const r = await fetch(`${DATAMART_BASE_URL}/data-packages`, {
      headers: { 'X-API-Key': DATAMART_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (!r.ok || j.status !== 'success') throw new Error(j.message || `DataMart ${r.status}`);

    const out = {};
    for (const [siteKey, dmCode] of Object.entries(NETWORKS)) {
      out[siteKey] = (j.data[dmCode] || [])
        .filter(p => Number(p.capacity) > 0 && Number(p.price) > 0)
        .map(p => ({
          capacity: Number(p.capacity),
          size: `${Number(p.capacity)}GB`,
          cost: Number(p.price),
          price: sellPrice(Number(p.price)),
        }))
        .sort((a, b) => a.capacity - b.capacity);
    }
    pkgCache = { at: Date.now(), data: out };
    return out;
  } catch (e) {
    console.error('Package fetch failed:', e.message);
    if (pkgCache.data) return pkgCache.data; // serve stale rather than nothing
    throw e;
  }
}

/* ---------------- Paystack ---------------- */
async function paystackVerify(ref) {
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok || !j.status) throw new Error(j.message || `Paystack ${r.status}`);
  return j.data;
}

const confirming = new Set();

// Idempotent: safe to call from webhook AND the browser's verify poll.
async function confirmPayment(ref) {
  const o = orders[ref];
  if (!o || o.status !== 'pending_payment' || confirming.has(ref)) return;
  confirming.add(ref);
  try {
    const tx = await paystackVerify(ref);
    if (tx.status !== 'success') return;
    if (tx.currency !== 'GHS' || tx.amount < o.amountPesewas) {
      o.status = 'failed';
      o.error = `Amount mismatch (paid ${tx.amount} ${tx.currency}, expected ${o.amountPesewas} GHS pesewas)`;
      console.error(`[${ref}] ${o.error}`);
      await save();
      return;
    }
    o.status = 'paid';
    o.paidAt = Date.now();
    await save();
    fulfill(ref).catch(e => console.error(`[${ref}] fulfil crashed:`, e));
  } finally {
    confirming.delete(ref);
  }
}

/* ---------------- Fulfilment ---------------- */
async function fulfill(ref) {
  const o = orders[ref];
  if (!o || o.status !== 'paid') return; // claim happens synchronously below
  o.status = 'processing';
  await save();

  if (o.product === 'checker') {
    // No checker endpoint is documented in what you shared, so these are delivered by you.
    o.manual = true;
    o.message = 'Payment confirmed. Your checker PIN will be sent to your phone shortly.';
    console.log(`[${ref}] MANUAL: send ${o.item} PIN to ${o.phone}`);
    await save();
    return;
  }

  let lastErr = 'Unknown error';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${DATAMART_BASE_URL}/purchase`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': DATAMART_API_KEY,
          'X-Idempotency-Key': ref, // same key on every retry => never double-charged
        },
        body: JSON.stringify({
          phoneNumber: o.phone,
          network: o.dmNetwork,
          capacity: String(o.capacity),
          gateway: 'wallet',
          ref: DATAMART_REF_PREFIX + ref,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await r.json().catch(() => ({}));

      if (r.ok && j.status === 'success') {
        o.status = j.data?.orderStatus === 'completed' ? 'completed' : 'processing';
        o.dmOrderRef = j.data?.orderReference;
        o.dmStatus = j.data?.orderStatus;
        o.message = o.status === 'completed' ? 'Delivered.' : 'Payment confirmed. Delivery in progress.';
        await save();
        return;
      }
      lastErr = j.message || `DataMart ${r.status}`;
      if (r.status === 409 || r.status >= 500) { await sleep(3000 * attempt); continue; } // retry
      break; // 4xx (insufficient balance, bad rule, etc.) won't fix itself
    } catch (e) {
      lastErr = e.message;
      await sleep(3000 * attempt); // timeout/network: retry with SAME idempotency key
    }
  }
  o.status = 'failed_fulfilment';
  o.error = lastErr;
  o.message = 'Payment received but delivery hit a problem. We are on it — contact support with your reference.';
  console.error(`[${ref}] Fulfilment failed after retries: ${lastErr}`);
  await save();
}

/* ---------------- App ---------------- */
const app = express();
app.set('trust proxy', 1);

// Webhook MUST get the raw body (before express.json) for signature checking.
app.post('/api/webhooks/paystack', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const sig = String(req.get('x-paystack-signature') || '');
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  const ok = sig.length === hash.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash));
  if (!ok) return res.sendStatus(401);
  res.sendStatus(200); // ack fast; Paystack retries on non-200
  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success' && event.data?.reference) {
      confirmPayment(event.data.reference).catch(e => console.error('webhook confirm failed:', e));
    }
  } catch (e) { console.error('Bad webhook body', e); }
});

app.use(express.json({ limit: '20kb' }));

// naive per-IP limiter
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ status: 'error', message: 'Too many requests, slow down.' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// Everything the page needs to render. Wholesale cost is never exposed.
app.get('/api/catalog', limit(60, 60000), async (req, res) => {
  try {
    const pk = await getPackages();
    const packages = {};
    for (const [net, list] of Object.entries(pk)) {
      packages[net] = list.map(({ capacity, size, price }) => ({ capacity, size, price }));
    }
    res.json({ status: 'success', publicKey: PAYSTACK_PUBLIC_KEY, packages, checkers: CHECKERS });
  } catch (e) {
    res.status(502).json({ status: 'error', message: 'Could not load bundles right now. Please try again shortly.' });
  }
});

// Create a pending order. PRICE IS COMPUTED HERE — the browser's price is never trusted.
app.post('/api/orders', limit(15, 60000), async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = normPhone(b.phone);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email || '').trim()) ? b.email.trim() : FALLBACK_EMAIL;
    if (name.length < 2) return res.status(400).json({ status: 'error', message: 'Please enter your name.' });
    if (!validPhone(phone)) return res.status(400).json({ status: 'error', message: 'Enter a valid 10-digit phone number.' });

    const ref = 'BP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const order = { ref, name, phone, email, status: 'pending_payment', placedAt: Date.now() };

    if (b.product === 'data') {
      if (!NETWORKS[b.network]) return res.status(400).json({ status: 'error', message: 'Unknown network.' });
      const pk = await getPackages();
      const pkg = pk[b.network].find(p => p.capacity === Number(b.capacity));
      if (!pkg) return res.status(400).json({ status: 'error', message: 'That bundle is not available.' });
      Object.assign(order, {
        product: 'data', network: b.network, dmNetwork: NETWORKS[b.network],
        capacity: pkg.capacity, item: `${pkg.size} ${b.network.toUpperCase()}`,
        amount: pkg.price, cost: pkg.cost,
      });
    } else if (b.product === 'checker') {
      const c = CHECKERS[b.checkerType];
      const qty = Math.min(10, Math.max(1, parseInt(b.qty, 10) || 1));
      if (!c) return res.status(400).json({ status: 'error', message: 'Unknown checker type.' });
      Object.assign(order, {
        product: 'checker', checkerType: b.checkerType, qty,
        item: qty > 1 ? `${c.label} × ${qty}` : c.label, amount: c.price * qty,
      });
    } else {
      return res.status(400).json({ status: 'error', message: 'Invalid product.' });
    }

    order.amountPesewas = Math.round(order.amount * 100);
    orders[ref] = order;
    await save();
    res.json({ status: 'success', ref, email, item: order.item, amount: order.amount, amountPesewas: order.amountPesewas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: 'Could not create order.' });
  }
});

// Public order status (for the confirmation screen + tracker). ?verify=1 also asks Paystack directly.
app.get('/api/orders/:ref', limit(60, 60000), async (req, res) => {
  const ref = String(req.params.ref || '').trim().toUpperCase();
  let o = orders[ref];
  if (!o) return res.status(404).json({ status: 'error', message: 'Order not found.' });
  if (req.query.verify === '1' && o.status === 'pending_payment') {
    await confirmPayment(ref).catch(e => console.error('verify failed:', e.message));
    o = orders[ref];
  }
  res.json({
    status: 'success',
    order: {
      ref: o.ref, item: o.item, amount: o.amount, phone: maskPhone(o.phone),
      state: o.status, message: o.message || '', placedAt: o.placedAt,
    },
  });
});

/* ---- admin (set ADMIN_TOKEN in .env, send as x-admin-token) ---- */
function admin(req, res, next) {
  if (!ADMIN_TOKEN || req.get('x-admin-token') !== ADMIN_TOKEN) return res.sendStatus(401);
  next();
}
app.get('/api/admin/orders', admin, (req, res) => {
  const list = Object.values(orders).sort((a, b) => b.placedAt - a.placedAt).slice(0, 200);
  const profit = list.filter(o => o.status === 'completed' && o.cost).reduce((s, o) => s + (o.amount - o.cost), 0);
  res.json({ count: list.length, grossProfitGHS: Number(profit.toFixed(2)), orders: list });
});
app.post('/api/admin/orders/:ref/retry', admin, async (req, res) => {
  const o = orders[req.params.ref];
  if (!o || o.status !== 'failed_fulfilment') return res.status(400).json({ message: 'Not retryable.' });
  o.status = 'paid'; o.error = null; await save();
  fulfill(o.ref).catch(console.error);
  res.json({ ok: true });
});
app.post('/api/admin/orders/:ref/complete', admin, async (req, res) => {
  const o = orders[req.params.ref];
  if (!o) return res.sendStatus(404);
  o.status = 'completed'; o.message = 'Delivered.'; await save();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

loadDb().then(() => app.listen(PORT, () => console.log(`BrightPath running on http://localhost:${PORT}`)));