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
let dirty = false;
setInterval(() => { if (!dirty) return; try { fs.mkdirSync(STATS_DIR, { recursive: true }); fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); dirty = false; } catch (e) { console.error('stats save', e.message); } }, 30000).unref();
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse/i;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
function bump(kind, page, source) {
  const d = (stats.days[today()] ||= { views: 0, checks: 0, leads: 0, pages: {}, sources: {}, results: {} });
  d[kind]++;
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
    bump('checks', pageKey(req.body?.page), String(req.body?.source || 'direct').slice(0, 60));
    const d = stats.days[today()]; d.results[level] = (d.results[level] || 0) + 1;
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
    bump('leads', pageKey(b.page), String(b.source || 'direct').slice(0, 60));
    res.json({ ok: true });
  } catch (e) {
    console.error('LEAD NOT SAVED', e.message, JSON.stringify({ ...lead, secret: undefined }));
    res.status(502).json({ error: 'Something went wrong saving your request. Please call or text us.' });
  }
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
function render(req, o) {
  if (!o.noCount && !BOT.test(req.get('user-agent') || '')) bump('views', pageKey(req.path), srcOf(req));
  const v = {
    TITLE: o.title, DESC: o.desc, H1: o.h1, LEDE: o.lede,
    CANON: origin(req) + (o.path || req.path), ROBOTS: o.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    CITY: o.city || '', STRIP: stripHtml(o.strip || ALL_KEYS, o.stripLabel || 'Providers we check'), SCHEMA: o.schema ? `<script type="application/ld+json">${JSON.stringify(o.schema).replace(/</g, '\\u003c')}</script>` : '',
    STATES: STATES_HTML,
  };
  return TPL.replace(/\{\{(TITLE|DESC|H1|LEDE|CANON|ROBOTS|CITY|SCHEMA|STATES|STRIP)\}\}/g, (_, k) => (k === 'TITLE' || k === 'DESC' || k === 'H1' || k === 'LEDE' || k === 'CANON') ? esc(v[k]) : v[k]);
}

app.get('/', (req, res) => res.send(render(req, {
  path: '/',
  title: 'Is Fiber Available at My Address? Free Check | CheckMyFiber',
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
    title: `Fiber Internet in ${STATES[st]}: Providers by City (2026) | CheckMyFiber`,
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
    title: `Fiber Internet in ${place}: Providers & Availability (2026) | CheckMyFiber`,
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
  const days = Object.keys(stats.days).sort().reverse().slice(0, 30);
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '–';
  const agg = key => { const m = {}; for (const day of days) for (const [k, v] of Object.entries(stats.days[day][key])) { const t = (m[k] ||= { views: 0, checks: 0, leads: 0 }); t.views += v.views; t.checks += v.checks; t.leads += v.leads; } return Object.entries(m).sort((a, b) => b[1].leads - a[1].leads || b[1].views - a[1].views).slice(0, 40); };
  const tot = days.reduce((t, d) => (['views', 'checks', 'leads'].forEach(k => t[k] += stats.days[d][k]), t), { views: 0, checks: 0, leads: 0 });
  const row = (name, v) => `<tr><td>${esc(name)}</td><td>${v.views}</td><td>${v.checks}</td><td>${v.leads}</td><td>${pct(v.checks, v.views)}</td><td>${pct(v.leads, v.checks)}</td><td><b>${pct(v.leads, v.views)}</b></td></tr>`;
  const head = first => `<tr><th>${first}</th><th>Visits</th><th>Checks</th><th>Leads</th><th>Visit→Check</th><th>Check→Lead</th><th>Visit→Lead</th></tr>`;
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>CheckMyFiber stats</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#0B1B2B}h1{margin:0 0 4px}h2{margin:28px 0 8px;font-size:18px}table{border-collapse:collapse;width:100%;max-width:900px;font-size:14px}td,th{text-align:left;padding:7px 10px;border-bottom:1px solid #E3E8EF}th{font-size:12px;text-transform:uppercase;color:#4A5D70}.k{display:flex;gap:28px;margin:12px 0}.k div{font-size:13px;color:#4A5D70}.k b{display:block;font-size:28px;color:#0B1B2B}</style>
<h1>CheckMyFiber stats</h1><p style="color:#4A5D70;margin:0">Last 30 days · visits exclude bots · times in Eastern</p>
<div class="k"><div><b>${tot.views}</b>Visits</div><div><b>${tot.checks}</b>Address checks</div><div><b>${tot.leads}</b>Leads</div><div><b>${pct(tot.leads, tot.views)}</b>Visit→Lead</div></div>
<h2>By day</h2><table>${head('Day')}${days.map(d => row(d, stats.days[d])).join('')}</table>
<h2>By source</h2><table>${head('Source')}${agg('sources').map(([k, v]) => row(k, v)).join('')}</table>
<h2>By page</h2><table>${head('Page')}${agg('pages').map(([k, v]) => row(k, v)).join('')}</table>`);
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
  title: 'Page not found | CheckMyFiber', desc: 'Check fiber availability at your address.', noindex: true, noCount: true,
  h1: "That page doesn't exist, but your fiber check does.", lede: 'Enter your address to see which fiber providers report service on your block.',
})));
app.listen(PORT, () => console.log('listening on ' + PORT));
