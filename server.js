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


// ---------- built-in stats (no cookies, no IPs) ----------
const STATS_DIR = process.env.STATS_DIR || '/data';
const STATS_FILE = path.join(STATS_DIR, 'stats.json');
let stats = { days: {} };
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch {}
if (stats.v !== 2) stats = { v: 2, days: {}, recent: [] }; // v2: only real (JS-running, non-owner) visitors counted
let dirty = false;
setInterval(() => { if (!dirty) return; try { fs.mkdirSync(STATS_DIR, { recursive: true }); fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); dirty = false; } catch (e) { console.error('stats save', e.message); } }, 30000).unref();
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse|facebookexternalhit|google|bing|yandex|ahrefs|semrush|uptime|scan|httpclient|axios|node-fetch|go-http|java|okhttp/i;
const isOwner = req => /(?:^|;\s*)mfc_owner=1/.test(req.get('cookie') || '');
const device = req => /mobile|iphone|android/i.test(req.get('user-agent') || '') ? 'mobile' : 'desktop';
const crypto = await import('node:crypto');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function bump(kind, page, source, req) {
  if (req && (isOwner(req) || BOT.test(req.get('user-agent') || ''))) return;
  const d = (stats.days[today()] ||= { views: 0, checks: 0, leads: 0, uniq: [], mobile: 0, pages: {}, sources: {}, results: {} });
  d[kind]++;
  if (req) {
    if (kind === 'views') {
      const h = crypto.createHash('sha256').update(today() + (req.ip || '') + (req.get('user-agent') || '') + (process.env.STATS_KEY || '')).digest('hex').slice(0, 10);
      if (!d.uniq.includes(h)) { d.uniq.push(h); if (device(req) === 'mobile') d.mobile++; }
    }
    stats.recent.unshift({ t: Date.now(), kind, page, source, device: device(req) });
    stats.recent.length = Math.min(stats.recent.length, 60);
  }
  const pg = (d.pages[page] ||= { views: 0, checks: 0, leads: 0 }); pg[kind]++;
  const sr = (d.sources[source] ||= { views: 0, checks: 0, leads: 0 }); sr[kind]++;
  dirty = true;
}
function srcOf(req) {
  const q = req.query.src || req.query.utm_source;
  if (q) return String(q).slice(0, 60);
  try { const h = new URL(req.get('referer')).hostname; if (!h.endsWith(req.hostname)) return h.replace(/^www\./, '').slice(0, 60); } catch {}
  return 'direct';
}
const pageKey = p => String(p || '/').split('?')[0].slice(0, 120);

const app = express();
app.disable('x-powered-by');
// www → apex
app.use((req, res, next) => req.hostname?.startsWith('www.') ? res.redirect(301, `https://${req.hostname.slice(4)}${req.originalUrl}`) : next());
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
    bump('checks', pageKey(req.body?.page), String(req.body?.source || 'direct').slice(0, 60), req);
    const d = stats.days[today()]; if (d && !isOwner(req)) { d.results[level] = (d.results[level] || 0) + 1; d.states ||= {}; if (g.state) d.states[g.state] = (d.states[g.state] || 0) + 1; d.provs ||= {}; for (const p of providers) d.provs[p.name] = (d.provs[p.name] || 0) + 1; }
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
    source: clean(b.source, 80) + (b.page && b.page !== '/' ? ' · ' + clean(b.page, 100) : ''),
    consent: b.consent === true ? 'yes' : 'no',
    page: clean(b.page, 200),
  };
  if (!lead.name || lead.phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please add your name and a 10-digit phone number.' });
  if (lead.consent !== 'yes') return res.status(400).json({ error: 'Please check the box so we can text you.' });
  if (b.website) return res.json({ ok: true }); // honeypot
  try {
    if (!SHEET_WEBHOOK) throw new Error('SHEET_WEBHOOK not set');
    const r = await fetch(SHEET_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    // Apps Script runs doPost, then answers 302 to its output page
    if (!(r.ok || r.status === 302)) throw new Error('sheet ' + r.status);
    bump('leads', pageKey(b.page), String(b.source || 'direct').slice(0, 60), req);
    res.json({ ok: true });
  } catch (e) {
    console.error('LEAD NOT SAVED', e.message, JSON.stringify({ ...lead, secret: undefined }));
    res.status(502).json({ error: 'Something went wrong saving your request. Please call or text us.' });
  }
});

// ---------- customer referrals ----------
const REFER_TPL = fs.readFileSync(path.join(__dirname, 'views/refer.html'), 'utf8');
// $100 holiday reward through Dec 31, 2026 (Eastern), then $50. The page itself switches on its own too.
const promoOn = () => Date.now() < Date.parse('2027-01-01T00:00:00-05:00');
app.get(['/refer', '/refer/:rep'], (req, res) => {
  const html = promoOn() ? REFER_TPL : REFER_TPL
    .replace('content="Get $100 for every friend who gets fiber"', 'content="Get $50 for every friend who gets fiber"')
    .replace('<title>Get $100', '<title>Get $50');
  res.set('Cache-Control', 'no-cache').send(html.replace('https://myfibercheck.com/refer-card.png', `${origin(req)}/refer-card-${promoOn() ? 100 : 50}.png`));
});

app.post('/api/referral', async (req, res) => {
  const b = req.body || {}, f = b.friend || {}, me = b.referrer || {};
  const clean = (v, n = 120) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
  if (b.website) return res.json({ ok: true }); // honeypot
  const friendName = clean(f.name, 60), friendPhone = clean(f.phone, 30);
  const refName = clean(me.name, 60), refPhone = clean(me.phone, 30);
  if (!friendName || friendPhone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: "Please add your friend's name and a 10-digit phone number." });
  if (!refName || refPhone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Please add your name and a 10-digit phone number.' });
  const rep = clean(b.rep, 40);
  const extras = [
    f.interest?.length && 'Wants: ' + clean([].concat(f.interest).join(', '), 80),
    f.time && 'Best time: ' + clean(f.time, 30),
    f.rel && 'Relationship: ' + clean(f.rel, 30),
    f.notes && 'Notes: ' + clean(f.notes, 300),
  ].filter(Boolean).join(' | ');
  const lead = {
    secret: SHEET_SECRET,
    name: friendName,
    phone: friendPhone,
    email: clean(f.email, 120),
    address: clean(f.addr, 200),
    matched: '', zip: '', state: '',
    status: 'Referral',
    providers: extras,
    source: `Referral from ${refName} ${refPhone}` + (rep ? ` · rep ${rep}` : '') + (b.reward ? ` · reward ${clean(b.reward, 8)}` : ''),
    consent: 'via referrer',
    page: clean(b.page, 100) || '/refer',
    // extra fields for a Referrals tab, if the sheet script uses them
    type: 'referral', referrer_name: refName, referrer_phone: refPhone, rep, reward: clean(b.reward, 8),
  };
  try {
    if (!SHEET_WEBHOOK) throw new Error('SHEET_WEBHOOK not set');
    const r = await fetch(SHEET_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!(r.ok || r.status === 302)) throw new Error('sheet ' + r.status);
    bump('leads', '/refer', 'referral' + (rep ? ':' + rep : ''), req);
    res.json({ ok: true });
  } catch (e) {
    console.error('REFERRAL NOT SAVED', e.message, JSON.stringify({ ...lead, secret: undefined }));
    res.status(502).json({ error: 'Something went wrong saving your referral.' });
  }
});

// page-view beacon: sent by the page's own script, so only real browsers are counted
app.post('/api/v', express.text({ type: '*/*', limit: '2kb' }), (req, res) => {
  let b = {}; try { b = JSON.parse(req.body || '{}'); } catch {}
  bump('views', pageKey(b.page), String(b.source || 'direct').slice(0, 60), req);
  res.status(204).end();
});

app.get('/healthz', (_q, r) => r.send('ok'));

// ---------- pages ----------
const TPL = fs.readFileSync(path.join(__dirname, 'views/page.html'), 'utf8');
const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/cities.json'), 'utf8'));
const INDEX_MIN = 2000; // homes with fiber needed for a city page to be indexed
const STATES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
const byState = new Map();
for (const c of cities) { if (!byState.has(c.st)) byState.set(c.st, new Map()); byState.get(c.st).set(c.slug, c); }
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = n => n.toLocaleString('en-US');
const spd = d => d >= 1000 ? (Math.round(d / 100) / 10) + ' Gig' : d + ' Mbps';
const pname = k => cov.isps[k];
const stateLinks = [...byState.keys()].sort().map(st => `<a href="/fiber-internet/${st.toLowerCase()}">${STATES[st] || st}</a>`).join(' ');
const STATES_HTML = `<p style="color:#0B1B2B;font-weight:700;margin-top:14px">Fiber internet by state</p><p class="states">${stateLinks}</p>`;
const origin = req => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
app.set('trust proxy', true);

const ALL_KEYS = ['kn','bs','vz','att','fr','qf','fi','bp','tg','rp','w3','pb'];
const SHORT = { kn: ['Kinetic'], bs: ['Brightspeed'], vz: ['Verizon Fios'], att: ['AT&T Fiber'], fr: ['Frontier'], qf: ['Quantum Fiber'], fi: ['Fidium'], bp: ['Bluepeak'], tg: ['Ting'], rp: ['Ripple'], w3: ['Wire3'], pb: ['Point Broadband', 'Clearwave'] };
const stripHtml = (keys, label) => `<p class="stripl">${esc(label)}</p>\n<ul class="strip">${keys.flatMap(k => SHORT[k] || [pname(k)]).map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
function botName(ua) {
  if (/googlebot|google-inspectiontool|adsbot-google/i.test(ua)) return 'Google';
  if (/bingbot|msnbot/i.test(ua)) return 'Bing';
  if (/facebookexternalhit|meta-externalagent/i.test(ua)) return 'Facebook link preview';
  if (/applebot/i.test(ua)) return 'Apple';
  if (/ahrefs|semrush|mj12|dotbot|rogerbot|screaming/i.test(ua)) return 'SEO tools';
  if (/gptbot|claudebot|perplexity|oai-searchbot|ccbot/i.test(ua)) return 'AI search';
  if (BOT.test(ua)) return 'Other bots';
  return null;
}
function render(req, o) {
  const bn = botName(req.get('user-agent') || '');
  if (bn) { const d = (stats.days[today()] ||= { views: 0, checks: 0, leads: 0, uniq: [], mobile: 0, pages: {}, sources: {}, results: {} }); d.bots ||= {}; d.bots[bn] = (d.bots[bn] || 0) + 1; if (bn === 'Google') { d.gpages ||= {}; d.gpages[pageKey(req.path)] = 1; } dirty = true; }
  const v = {
    TITLE: o.title, DESC: o.desc, H1: o.h1, LEDE: o.lede,
    CANON: origin(req) + (o.path || req.path), ROBOTS: o.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    CITY: o.city || '', STRIP: stripHtml(o.strip || ALL_KEYS, o.stripLabel || 'Providers we check'), SCHEMA: o.schema ? `<script type="application/ld+json">${JSON.stringify(o.schema).replace(/</g, '\\u003c')}</script>` : '',
    STATES: STATES_HTML, REPNAME: esc(process.env.REP_NAME || 'Aidan'), REPTITLE: esc(process.env.REP_TITLE || 'Founder, Quota'),
  };
  return TPL.replace(/\{\{(TITLE|DESC|H1|LEDE|CANON|ROBOTS|CITY|SCHEMA|STATES|STRIP|REPNAME|REPTITLE)\}\}/g, (_, k) => (k === 'TITLE' || k === 'DESC' || k === 'H1' || k === 'LEDE' || k === 'CANON') ? esc(v[k]) : v[k]);
}

app.get('/', (req, res) => res.send(render(req, {
  path: '/',
  title: 'Is Fiber Available at My Address? Free Check | MyFiberCheck',
  desc: 'Free fiber availability check. Enter your address to see which fiber internet providers report service on your block, then get your options by text.',
  h1: 'Is fiber available at your address?',
  lede: "Check every fiber provider we sell in about 5 seconds. Free, and we'll text you your exact options.",
})));

app.get('/fiber-internet/:st', (req, res, next) => {
  const st = req.params.st.toUpperCase(), m = byState.get(st);
  if (!m || !STATES[st]) return next();
  const list = [...m.values()].sort((a, b) => b.homes - a.homes);
  const provs = new Map();
  for (const c of list) for (const [k, n, d] of c.providers) { const p = provs.get(k) || [0, 0]; p[0] += n; p[1] = Math.max(p[1], d); provs.set(k, p); }
  const top = list.slice(0, 120);
  const city = `<section class="city">
<h2>Fiber internet in ${esc(STATES[st])}</h2>
<p class="body">Fiber providers we sell report service in ${num(list.length)} ${esc(STATES[st])} cities and towns. Here's where coverage is strongest, based on FCC National Broadband Map data. Pick your city for details, or check your exact address above.</p>
<table><thead><tr><th>Provider</th><th>Top speed in ${esc(st)}</th></tr></thead><tbody>${[...provs.entries()].sort((a, b) => b[1][0] - a[1][0]).map(([k, p]) => `<tr><td><strong>${esc(pname(k))}</strong></td><td>up to ${spd(p[1])}</td></tr>`).join('')}</tbody></table>
<h3 style="font-size:20px;margin:24px 0 8px">Cities with fiber in ${esc(STATES[st])}</h3>
<ul class="links">${top.map(c => `<li><a href="/fiber-internet/${st.toLowerCase()}/${c.slug}">${esc(c.name)}</a></li>`).join('')}</ul>
</section>`;
  res.send(render(req, {
    title: `Fiber Internet in ${STATES[st]}: Providers by City (2026) | MyFiberCheck`,
    desc: `See which fiber internet providers serve ${STATES[st]} cities, top speeds by provider, and check fiber availability at your exact address for free.`,
    h1: `Is fiber available at your ${STATES[st]} address?`,
    lede: `We check ${provs.size} fiber providers across ${num(list.length)} ${STATES[st]} communities. Free, and we'll text you your exact options.`,
    city, strip: [...provs.entries()].sort((a, b) => b[1][0] - a[1][0]).map(e => e[0]), stripLabel: `Fiber providers in ${STATES[st]}`,
    schema: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: origin(req) + '/' },
      { '@type': 'ListItem', position: 2, name: STATES[st], item: origin(req) + req.path }] },
  }));
});

app.get('/fiber-internet/:st/:slug', (req, res, next) => {
  const st = req.params.st.toUpperCase(), c = byState.get(st)?.get(req.params.slug);
  if (!c) return next();
  const S = STATES[st], place = `${c.name}, ${st}`;
  const [k0, n0, d0] = c.providers[0];
  const fastest = c.providers.reduce((a, b) => b[2] > a[2] ? b : a);
  const names = c.providers.map(p => pname(p[0]));
  const listStr = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  const nearby = c.nearby.map(s => byState.get(st).get(s)).filter(Boolean);
  const faq = [
    [`Is fiber internet available in ${place}?`, `Yes, in many parts of ${c.name}. Fiber providers we sell report service to at least ${num(c.homes)} homes in and around ${c.name}, according to FCC National Broadband Map data. Coverage changes street by street, so check your exact address.`],
    [`Which fiber providers serve ${c.name}?`, `${listStr} ${names.length > 1 ? 'report' : 'reports'} fiber service in the ${c.name} area. ${pname(k0)} covers the most homes (about ${num(n0)}).`],
    [`What is the fastest fiber internet in ${c.name}?`, `${pname(fastest[0])} reports plans up to ${spd(fastest[2])} in the ${c.name} area. Actual speeds and pricing depend on your address and the plan you choose.`],
  ];
  const city = `<section class="city">
<h2>Fiber internet in ${esc(place)}</h2>
<p class="body">Fiber providers we sell report service to at least <strong>${num(c.homes)} homes</strong> in and around ${esc(c.name)}. ${esc(pname(k0))} covers the most, and ${esc(pname(fastest[0]))} offers the fastest plans, up to ${spd(fastest[2])}. Availability changes from one street to the next, so the only way to know for sure is to check your address.</p>
<table><thead><tr><th>Provider</th><th>Homes with fiber reported</th><th>Top speed</th></tr></thead><tbody>${c.providers.map(([k, n, d]) => `<tr><td><strong>${esc(pname(k))}</strong></td><td>${num(n)}</td><td>up to ${spd(d)}</td></tr>`).join('')}</tbody></table>
<p class="src" style="color:#4A5D70">Source: FCC National Broadband Map, June 2026 data. Counts are homes in and near ${esc(c.name)} where each provider reports fiber.</p>
${faq.map(([q, a]) => `<div class="q"><h3>${esc(q)}</h3><p>${esc(a)}</p></div>`).join('')}
${nearby.length ? `<h3 style="font-size:20px;margin:28px 0 8px">Fiber near ${esc(c.name)}</h3><ul class="links">${nearby.map(n => `<li><a href="/fiber-internet/${st.toLowerCase()}/${n.slug}">${esc(n.name)}</a></li>`).join('')}<li><a href="/fiber-internet/${st.toLowerCase()}">All ${esc(S)} cities</a></li></ul>` : ''}
</section>`;
  res.send(render(req, {
    title: `Fiber Internet in ${place}: Providers & Availability (2026) | MyFiberCheck`,
    desc: `${names.length} fiber provider${names.length > 1 ? 's' : ''} report service in ${place}, with plans up to ${spd(fastest[2])}. Check fiber availability at your exact ${c.name} address for free.`,
    h1: `Is fiber available at your ${c.name} address?`,
    lede: `${names.length > 1 ? `${names.length} fiber providers report` : `${names[0]} reports`} service in ${c.name}. Check your exact address in about 5 seconds, and we'll text you your options.`,
    city, noindex: c.homes < INDEX_MIN, strip: c.providers.map(p => p[0]), stripLabel: `Fiber providers in ${c.name}`,
    schema: [
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin(req) + '/' },
        { '@type': 'ListItem', position: 2, name: S, item: `${origin(req)}/fiber-internet/${st.toLowerCase()}` },
        { '@type': 'ListItem', position: 3, name: c.name, item: origin(req) + req.path }] },
    ],
  }));
});


app.get('/stats', (req, res) => {
  if (!process.env.STATS_KEY || req.query.key !== process.env.STATS_KEY) return res.status(404).send('Not found');
  // opening this page marks the device as yours so your own visits stop counting
  res.cookie('mfc_owner', '1', { maxAge: 365 * 864e5, httpOnly: true, sameSite: 'lax', secure: true });
  const days = Object.keys(stats.days).sort().reverse().slice(0, 30);
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
  const U = d => (d.uniq || []).length;
  const agg = key => { const m = {}; for (const day of days) for (const [k, v] of Object.entries(stats.days[day][key])) { const t = (m[k] ||= { views: 0, checks: 0, leads: 0 }); t.views += v.views; t.checks += v.checks; t.leads += v.leads; } return Object.entries(m).sort((a, b) => b[1].leads - a[1].leads || b[1].checks - a[1].checks || b[1].views - a[1].views).slice(0, 30); };
  const td = stats.days[today()] || { views: 0, checks: 0, leads: 0, uniq: [], mobile: 0, results: {} };
  const tot = days.reduce((t, d) => { const x = stats.days[d]; t.u += U(x); t.c += x.checks; t.l += x.leads; return t; }, { u: 0, c: 0, l: 0 });
  const tile = (n, label, sub = '') => `<div class="tile"><b>${n}</b>${label}${sub ? `<span>${sub}</span>` : ''}</div>`;
  const row = (name, v) => `<tr><td>${esc(name)}</td><td>${v.views}</td><td>${v.checks}</td><td>${v.leads}</td></tr>`;
  const fmtT = t => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const label = { views: 'Visited', checks: 'Checked an address', leads: 'Became a lead' };
  const owner = isOwner(req);
  const sumMap = key => { const m = {}; for (const d of days) for (const [k, v] of Object.entries(stats.days[d][key] || {})) m[k] = (m[k] || 0) + v; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25); };
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MyFiberCheck stats</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;color:#0B1B2B;background:#F5F7FA}main{max-width:980px;margin:0 auto;padding:24px 18px 60px}h1{margin:0;font-size:26px}h2{margin:30px 0 10px;font-size:17px}.note{color:#4A5D70;font-size:14px;margin:4px 0 0}.ok{display:inline-block;margin-top:10px;background:#E7F6EE;color:#0E5E36;font-size:13px;font-weight:600;padding:5px 10px;border-radius:999px}.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.tile{background:#fff;border:1px solid #E3E8EF;border-radius:14px;padding:16px;font-size:13px;color:#4A5D70}.tile b{display:block;font-size:30px;color:#0B1B2B;line-height:1.1;margin-bottom:4px}.tile span{display:block;margin-top:4px;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #E3E8EF;border-radius:12px;overflow:hidden;font-size:14px}td,th{text-align:left;padding:9px 12px;border-bottom:1px solid #EEF1F5}th{font-size:12px;text-transform:uppercase;color:#4A5D70;background:#FAFBFC}tr:last-child td{border-bottom:0}.lead td{background:#E7F6EE;font-weight:600}@media(max-width:700px){.tiles{grid-template-columns:repeat(2,1fr)}}</style>
<main><h1>MyFiberCheck stats</h1><p class="note">Only real people are counted: browsers that load the page. Bots, crawlers and your own devices are excluded. Times are Eastern.</p>
${owner ? '<span class="ok">✓ This device is excluded from the stats</span>' : '<span class="ok">✓ This device is now excluded (refresh to confirm)</span>'}
<h2>Today</h2><div class="tiles">${tile(U(td), 'Real visitors', `${td.mobile || 0} on phones`)}${tile(td.checks, 'Address checks', pct(td.checks, U(td)) + ' of visitors')}${tile(td.leads, 'Leads', pct(td.leads, td.checks) + ' of checks')}${tile(pct(td.leads, U(td)), 'Visitor → lead')}</div>
<h2>Last 30 days</h2><div class="tiles">${tile(tot.u, 'Real visitors')}${tile(tot.c, 'Address checks')}${tile(tot.l, 'Leads')}${tile(pct(tot.l, tot.u), 'Visitor → lead')}</div>
<h2>Live activity (latest 60)</h2><table><tr><th>When</th><th>What happened</th><th>Page</th><th>Came from</th><th>Device</th></tr>${(stats.recent || []).map(e => `<tr class="${e.kind === 'leads' ? 'lead' : ''}"><td>${fmtT(e.t)}</td><td>${label[e.kind]}</td><td>${esc(e.page)}</td><td>${esc(e.source)}</td><td>${e.device}</td></tr>`).join('') || '<tr><td colspan="5">No real visitors yet.</td></tr>'}</table>
<h2>By day</h2><table><tr><th>Day</th><th>Visitors</th><th>Checks</th><th>Leads</th><th>Visitor → lead</th></tr>${days.map(d => { const x = stats.days[d]; return `<tr><td>${d}</td><td>${U(x)}</td><td>${x.checks}</td><td>${x.leads}</td><td>${pct(x.leads, U(x))}</td></tr>`; }).join('') || '<tr><td colspan="5">–</td></tr>'}</table>
<h2>Where visitors come from</h2><table><tr><th>Source</th><th>Page views</th><th>Checks</th><th>Leads</th></tr>${agg('sources').map(([k, v]) => row(k, v)).join('') || '<tr><td colspan="4">–</td></tr>'}</table>
<h2>Which pages they land on</h2><table><tr><th>Page</th><th>Page views</th><th>Checks</th><th>Leads</th></tr>${agg('pages').map(([k, v]) => row(k, v)).join('') || '<tr><td colspan="4">–</td></tr>'}</table>
<h2>What people's checks found</h2><table><tr><th>Result</th><th>Checks (30 days)</th></tr>${[['exact','Fiber reported at the address'],['nearby','Fiber reported next door'],['none','Nothing on the map (manual check)']].map(([k,l]) => `<tr><td>${l}</td><td>${days.reduce((n, d) => n + ((stats.days[d].results || {})[k] || 0), 0)}</td></tr>`).join('')}</table>
<h2>Providers found in checks</h2><table><tr><th>Provider</th><th>Times found (30 days)</th></tr>${sumMap('provs').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">–</td></tr>'}</table>
<h2>Checks by state</h2><table><tr><th>State</th><th>Checks (30 days)</th></tr>${sumMap('states').map(([k, v]) => `<tr><td>${esc(STATES[k] || k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">–</td></tr>'}</table>
<h2>Crawlers (not counted as visitors)</h2><p class="note" style="margin-bottom:10px">Google and Bing reading your pages is how search traffic starts. ${days.reduce((n, d) => n + Object.keys(stats.days[d].gpages || {}).length, 0)} page-visits by Google in the last 30 days.</p><table><tr><th>Crawler</th><th>Page hits (30 days)</th><th>Today</th></tr>${sumMap('bots').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td><td>${(td.bots || {})[k] || 0}</td></tr>`).join('') || '<tr><td colspan="3">–</td></tr>'}</table>
</main>`);
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /stats\nSitemap: ${origin(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const o = origin(req), d = '2026-11-19';
  const urls = [`${o}/`, ...[...byState.keys()].filter(st => STATES[st]).map(st => `${o}/fiber-internet/${st.toLowerCase()}`),
    ...cities.filter(c => c.homes >= INDEX_MIN && STATES[c.st]).map(c => `${o}/fiber-internet/${c.st.toLowerCase()}/${c.slug}`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${u}</loc><lastmod>${d}</lastmod></url>`).join('\n')}\n</urlset>`);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', index: false }));
app.use((req, res) => res.status(404).send(render(req, {
  title: 'Page not found | MyFiberCheck', desc: 'Check fiber availability at your address.', noindex: true, noCount: true,
  h1: "That page doesn't exist, but your fiber check does.", lede: 'Enter your address to see which fiber providers report service on your block.',
})));
app.listen(PORT, () => console.log('listening on ' + PORT));
