import express from 'express';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latLngToCell, gridDisk } from 'h3-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SHEET_WEBHOOK = process.env.SHEET_WEBHOOK || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';

// coverage: { asOf, isps: {key: displayName}, hex: { h3: [[ispKey, maxDown, homes], ...] } }
const cov = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data/coverage.json.gz'))));
const hexMap = new Map(Object.entries(cov.hex));
console.log(`coverage loaded: ${hexMap.size} hexes, as of ${cov.asOf}`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

function lookup(lat, lng) {
  const cell = latLngToCell(lat, lng, 8);
  const exact = hexMap.get(cell) || [];
  if (exact.length) return { level: 'exact', rows: exact };
  const near = new Map();
  for (const c of gridDisk(cell, 1)) {
    for (const [k, down, homes] of hexMap.get(c) || []) {
      const p = near.get(k);
      if (!p || down > p[1]) near.set(k, [k, down, homes]);
    }
  }
  return { level: near.size ? 'nearby' : 'none', rows: [...near.values()] };
}

async function geocode(address) {
  const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  u.searchParams.set('address', address);
  u.searchParams.set('benchmark', 'Public_AR_Current');
  u.searchParams.set('format', 'json');
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('geocoder ' + r.status);
  const m = (await r.json())?.result?.addressMatches?.[0];
  if (!m) return null;
  return { matched: m.matchedAddress, lat: m.coordinates.y, lng: m.coordinates.x, zip: m.addressComponents?.zip, state: m.addressComponents?.state, city: m.addressComponents?.city };
}

app.post('/api/check', async (req, res) => {
  const address = String(req.body?.address || '').trim().slice(0, 200);
  if (address.length < 5) return res.status(400).json({ error: 'Please enter your street address.' });
  try {
    const g = await geocode(address);
    if (!g) return res.json({ found: false });
    const { level, rows } = lookup(g.lat, g.lng);
    const providers = rows
      .sort((a, b) => b[1] - a[1])
      .map(([k, down]) => ({ name: cov.isps[k], down }));
    res.json({ found: true, matched: g.matched, zip: g.zip, state: g.state, level, providers });
  } catch (e) {
    console.error('check failed', e.message);
    res.status(502).json({ error: 'We could not look that up right now. Please try again.' });
  }
});

app.post('/api/lead', async (req, res) => {
  const b = req.body || {};
  const clean = (v, n = 120) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  const lead = {
    secret: SHEET_SECRET,
    name: clean(b.name, 60),
    phone: clean(b.phone, 30),
    email: clean(b.email, 120),
    address: clean(b.address, 200),
    matched: clean(b.matched, 200),
    zip: clean(b.zip, 10),
    state: clean(b.state, 4),
    status: clean(b.status, 40),
    providers: clean(b.providers, 300),
    source: clean(b.source, 120),
    consent: b.consent === true ? 'yes' : 'no',
    page: clean(b.page, 200),
  };
  if (!lead.name || lead.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please add your name and a 10-digit phone number.' });
  if (lead.consent !== 'yes') return res.status(400).json({ error: 'Please check the box so we can text you.' });
  if (b.website) return res.json({ ok: true }); // honeypot
  try {
    if (!SHEET_WEBHOOK) throw new Error('SHEET_WEBHOOK not set');
    const r = await fetch(SHEET_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead), redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('sheet ' + r.status);
    res.json({ ok: true });
  } catch (e) {
    console.error('LEAD NOT SAVED', e.message, JSON.stringify({ ...lead, secret: undefined }));
    res.status(502).json({ error: 'Something went wrong saving your request. Please call or text us.' });
  }
});

app.get('/healthz', (_q, r) => r.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((_q, r) => r.status(404).sendFile(path.join(__dirname, 'public/index.html')));
app.listen(PORT, () => console.log('listening on ' + PORT));
