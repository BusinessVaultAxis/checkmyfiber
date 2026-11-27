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
if (stats.v !== 2) stats = { v: 2, days: {}, recent: [] };
stats.sessions ||= []; // v2: only real (JS-running, non-owner) visitors counted
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
// PREVIEW=1: isolated redesign preview. Never indexed, never delivers leads.
const PREVIEW = process.env.PREVIEW === '1';
if (PREVIEW) app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
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
  if (PREVIEW) { console.log('PREVIEW lead (not delivered):', lead.name); return res.json({ ok: true, preview: true }); }
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


// ---------- visitor sessions (from /t.js) ----------
const STEPS = [['view','Landed on the site'],['engaged','Scrolled or interacted'],['addr_focus','Clicked the address box'],['addr_typed','Typed an address'],['check_submit','Pressed "Check my address"'],['check_result','Saw their result'],['name_focus','Started the contact form'],['phone_focus','Clicked the phone field'],['consent_on','Checked the consent box'],['lead_submit','Pressed "Text me my options"'],['lead_ok','Became a lead']];
const sessIdx = new Map(stats.sessions.map(x => [x.id, x]));
function uaInfo(ua) {
  const os = /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /mac os x/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  const br = /FBAN|FBAV|FB_IAB/i.test(ua) ? 'Facebook app' : /Instagram/i.test(ua) ? 'Instagram app' : /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Other';
  return { os, br, headless: /headless|phantom|puppeteer|playwright|lighthouse/i.test(ua) };
}
app.post('/api/e', express.text({ type: '*/*', limit: '4kb' }), (req, res) => {
  res.status(204).end();
  if (isOwner(req)) return;
  const ua = req.get('user-agent') || ''; if (BOT.test(ua)) return;
  let b; try { b = JSON.parse(req.body || '{}'); } catch { return; }
  const id = String(b.sid || '').slice(0, 16), e = String(b.e || '').slice(0, 24); if (!id || !e) return;
  const now = Date.now(), page = pageKey(b.page), d = b.d && typeof b.d === 'object' ? b.d : {};
  let x = sessIdx.get(id);
  if (!x) {
    if (e !== 'view') return;
    const u = uaInfo(ua);
    x = { id, start: now, last: now, page, pages: [page], source: String(d.source || 'direct').slice(0, 60), refHost: String(d.refHost || '').slice(0, 80), ref: String(d.ref || '').slice(0, 200),
      utm: d.utm || {}, tz: String(d.tz || '').slice(0, 40), lang: String(d.lang || '').slice(0, 12), scr: String(d.scr || '').slice(0, 12), vp: String(d.vp || '').slice(0, 12),
      device: device(req), os: u.os, br: u.br, auto: !!d.wd || u.headless, newVisit: !!d.newVisit,
      loc: [req.get('cf-ipcity'), req.get('cf-region-code') || req.get('cf-region'), req.get('cf-ipcountry')].filter(Boolean).join(', '),
      ev: [], secs: 0, scroll: 0 };
    stats.sessions.unshift(x); sessIdx.set(id, x);
    if (stats.sessions.length > 600) sessIdx.delete(stats.sessions.pop().id);
    bump('views', page, x.source, req);
  } else if (e === 'view' && !x.pages.includes(page)) { x.pages.push(page); bump('views', page, x.source, req); }
  x.last = now;
  if (e === 'leave') { x.secs = Math.max(x.secs, Math.min(+d.secs || 0, 7200), Math.round((now - x.start) / 1000)); x.scroll = Math.max(x.scroll, Math.min(+d.scroll || 0, 100)); }
  else if (e !== 'view' && x.ev.length < 60) {
    const extra = d.level ? ':' + d.level : d.why ? ':' + d.why : d.msg ? ':' + String(d.msg).slice(0, 40) : '';
    x.ev.push([Math.round((now - x.start) / 1000), e + extra]);
  }
  dirty = true;
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
  if (/gptbot|oai-searchbot|chatgpt-user/i.test(ua)) return 'AI: ChatGPT (OpenAI)';
  if (/claudebot|claude-searchbot|claude-user|anthropic/i.test(ua)) return 'AI: Claude (Anthropic)';
  if (/perplexity/i.test(ua)) return 'AI: Perplexity';
  if (/google-extended|gemini/i.test(ua)) return 'AI: Google Gemini';
  if (/amazonbot/i.test(ua)) return 'AI: Amazon';
  if (/ccbot|bytespider|meta-externalagent|cohere|diffbot|youbot/i.test(ua)) return 'AI: other';
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
    STATES: STATES_HTML, REPNAME: esc(process.env.REP_NAME || 'Aidan'), REPTITLE: esc(process.env.REP_TITLE || 'Founder, MyFiberCheck'),
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

  // ----- funnel + journeys -----
  const since = Date.now() - 30 * 864e5;
  const ss = stats.sessions.filter(x => x.start >= since);
  const evHas = (x, k) => x.ev.some(([, n]) => n.split(':')[0] === k);
  const reached = (x, k) => { if (k === 'view') return true; const i = STEPS.findIndex(s => s[0] === k); return STEPS.slice(i).some(([kk]) => evHas(x, kk)) || (k === 'engaged' && x.ev.length > 0); };
  const human = x => !x.auto && (x.ev.length > 0 || x.secs >= 5);
  const hs = ss.filter(human);
  const funnelRows = STEPS.map(([k, l], i) => { const n = hs.filter(x => reached(x, k)).length; return { k, l, n }; });
  const funnel = funnelRows.map((r, i) => { const prev = i ? funnelRows[i - 1].n : r.n; const drop = i && prev ? Math.round(100 * (prev - r.n) / prev) : 0;
    return `<tr${drop >= 50 && prev >= 3 ? ' class="warn"' : ''}><td>${i + 1}. ${r.l}</td><td><b>${r.n}</b></td><td>${pct(r.n, funnelRows[0].n)}</td><td>${i ? (drop ? '−' + drop + '%' : '0%') : ''}</td></tr>`; }).join('');
  const stepLabel = Object.fromEntries(STEPS);
  const furthest = x => { let f = 'Landed on the site'; for (const [k, l] of STEPS) if (reached(x, k)) f = l; return f; };
  const dur = s => s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's';
  const tzName = tz => ({ 'America/New_York': 'Eastern', 'America/Detroit': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Boise': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii' }[tz] || tz || '?');
  const journeys = stats.sessions.slice(0, 50).map(x => `<tr class="${x.ev.some(([, n]) => n === 'lead_ok') ? 'lead' : ''}">
<td>${fmtT(x.start)}</td><td>${human(x) ? '<span class="h">Person</span>' : x.auto ? '<span class="b">Automated</span>' : '<span class="u">Unconfirmed</span>'}</td>
<td>${esc(x.pages.join(' → '))}</td><td>${esc(x.utm && x.utm.c ? x.source + ' / ' + x.utm.c : x.source)}${x.refHost && x.refHost !== x.source ? `<br><small>${esc(x.refHost)}</small>` : ''}</td>
<td>${esc(x.loc || tzName(x.tz))}<br><small>${esc(x.lang)}</small></td><td>${x.device} · ${esc(x.br)} · ${esc(x.os)}<br><small>${esc(x.scr)}${x.newVisit ? ' · new' : ' · returning'}</small></td>
<td>${dur(x.secs)}<br><small>${x.scroll}% scrolled</small></td><td>${esc(furthest(x))}</td>
<td><small>${x.ev.map(([t, n]) => `${dur(t)} ${esc(n)}`).join('<br>') || '–'}</small></td></tr>`).join('');
  const srcRows = (() => { const m = {}; for (const x of hs) { const k = x.source; const t = (m[k] ||= { v: 0, c: 0, l: 0, secs: 0 }); t.v++; t.secs += x.secs; if (reached(x, 'check_submit')) t.c++; if (reached(x, 'lead_ok')) t.l++; } return Object.entries(m).sort((a, b) => b[1].l - a[1].l || b[1].v - a[1].v).map(([k, t]) => `<tr><td>${esc(k)}</td><td>${t.v}</td><td>${t.c}</td><td>${t.l}</td><td>${pct(t.l, t.v)}</td><td>${dur(Math.round(t.secs / t.v))}</td></tr>`).join(''); })();
  const devRows = (() => { const m = {}; for (const x of hs) { const k = x.device + ' · ' + x.br; const t = (m[k] ||= { v: 0, c: 0, l: 0 }); t.v++; if (reached(x, 'check_submit')) t.c++; if (reached(x, 'lead_ok')) t.l++; } return Object.entries(m).sort((a, b) => b[1].v - a[1].v).map(([k, t]) => `<tr><td>${esc(k)}</td><td>${t.v}</td><td>${t.c}</td><td>${t.l}</td></tr>`).join(''); })();
  const issues = (() => { const m = {}; for (const x of hs) for (const [, n] of x.ev) { const k = n.split(':')[0]; if (['check_notfound','check_error','check_too_short','lead_invalid','lead_error'].includes(k)) m[n] = (m[n] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join(''); })();
  const owner = isOwner(req);
  const sumMap = key => { const m = {}; for (const d of days) for (const [k, v] of Object.entries(stats.days[d][key] || {})) m[k] = (m[k] || 0) + v; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 25); };
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>MyFiberCheck stats</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;color:#0B1B2B;background:#F5F7FA}main{max-width:980px;margin:0 auto;padding:24px 18px 60px}h1{margin:0;font-size:26px}h2{margin:30px 0 10px;font-size:17px}.note{color:#4A5D70;font-size:14px;margin:4px 0 0}.ok{display:inline-block;margin-top:10px;background:#E7F6EE;color:#0E5E36;font-size:13px;font-weight:600;padding:5px 10px;border-radius:999px}.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.tile{background:#fff;border:1px solid #E3E8EF;border-radius:14px;padding:16px;font-size:13px;color:#4A5D70}.tile b{display:block;font-size:30px;color:#0B1B2B;line-height:1.1;margin-bottom:4px}.tile span{display:block;margin-top:4px;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #E3E8EF;border-radius:12px;overflow:hidden;font-size:14px}td,th{text-align:left;padding:9px 12px;border-bottom:1px solid #EEF1F5}th{font-size:12px;text-transform:uppercase;color:#4A5D70;background:#FAFBFC}tr:last-child td{border-bottom:0}.warn td{background:#FDECEA}.h{color:#0E5E36;font-weight:700}.u{color:#7A5B00}.b{color:#B3261E}small{color:#4A5D70}.j td{vertical-align:top;font-size:13px}.lead td{background:#E7F6EE;font-weight:600}@media(max-width:700px){.tiles{grid-template-columns:repeat(2,1fr)}}</style>
<main><h1>MyFiberCheck stats</h1><p class="note">Only real people are counted: browsers that load the page. Bots, crawlers and your own devices are excluded. Times are Eastern.</p>
${owner ? '<span class="ok">✓ This device is excluded from the stats</span>' : '<span class="ok">✓ This device is now excluded (refresh to confirm)</span>'}
<h2>Today</h2><div class="tiles">${tile(U(td), 'Real visitors', `${td.mobile || 0} on phones`)}${tile(td.checks, 'Address checks', pct(td.checks, U(td)) + ' of visitors')}${tile(td.leads, 'Leads', pct(td.leads, td.checks) + ' of checks')}${tile(pct(td.leads, U(td)), 'Visitor → lead')}</div>
<h2>Last 30 days</h2><div class="tiles">${tile(tot.u, 'Real visitors')}${tile(tot.c, 'Address checks')}${tile(tot.l, 'Leads')}${tile(pct(tot.l, tot.u), 'Visitor → lead')}</div>
<h2>Where people drop off (last 30 days, real people only)</h2><p class="note" style="margin-bottom:10px">Each step counts people who got at least that far. Red rows lose half or more of the people from the step before; that's what to fix first.</p><table><tr><th>Step</th><th>People</th><th>Of all visitors</th><th>Lost from previous step</th></tr>${funnel}</table>
<h2>Problems people hit</h2><table><tr><th>What went wrong</th><th>Times</th></tr>${issues || '<tr><td colspan="2">None yet</td></tr>'}</table>
<h2>Visitor journeys (latest 50)</h2><p class="note" style="margin-bottom:10px"><b>Person</b> = scrolled, clicked or stayed 5+ seconds. <b>Unconfirmed</b> = loaded the page but never interacted (often a link preview or scanner). <b>Automated</b> = the browser reported itself as automated. Location is the visitor's time zone unless Cloudflare location headers are on.</p><div style="overflow-x:auto"><table class="j"><tr><th>When</th><th>Who</th><th>Pages</th><th>Came from</th><th>Where</th><th>Device</th><th>Time</th><th>Got as far as</th><th>Step by step</th></tr>${journeys || '<tr><td colspan="9">No visitors yet.</td></tr>'}</table></div>
<h2>Sources (real people, 30 days)</h2><table><tr><th>Source</th><th>People</th><th>Checked</th><th>Leads</th><th>Visitor → lead</th><th>Avg time</th></tr>${srcRows || '<tr><td colspan="6">–</td></tr>'}</table>
<h2>Devices and apps (real people, 30 days)</h2><table><tr><th>Device · browser</th><th>People</th><th>Checked</th><th>Leads</th></tr>${devRows || '<tr><td colspan="4">–</td></tr>'}</table>
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

app.get('/robots.txt', (req, res) => PREVIEW ? res.type('text/plain').send('User-agent: *\nDisallow: /\n') : res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /stats\nSitemap: ${origin(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const o = origin(req), d = '2026-11-19';
  const urls = [`${o}/`, `${o}/about`, ...[...byState.keys()].filter(st => STATES[st]).map(st => `${o}/fiber-internet/${st.toLowerCase()}`),
    ...cities.filter(c => c.homes >= INDEX_MIN && STATES[c.st]).map(c => `${o}/fiber-internet/${c.st.toLowerCase()}/${c.slug}`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${u}</loc><lastmod>${d}</lastmod></url>`).join('\n')}\n</urlset>`);
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h', index: false }));
app.use((req, res) => res.status(404).send(render(req, {
  title: 'Page not found | MyFiberCheck', desc: 'Check fiber availability at your address.', noindex: true, noCount: true,
  h1: "That page doesn't exist, but your fiber check does.", lede: 'Enter your address to see which fiber providers report service on your block.',
})));
app.listen(PORT, () => console.log('listening on ' + PORT));
