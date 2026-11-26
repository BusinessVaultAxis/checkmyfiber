// MyFiberCheck first-party analytics: no cookies, no third parties.
(function () {
  try {
    var ss = window.sessionStorage, sid = ss.getItem('mfc_sid');
    if (!sid) { sid = Math.random().toString(36).slice(2, 12); ss.setItem('mfc_sid', sid); }
    var q = new URLSearchParams(location.search), ref = document.referrer || '';
    var refHost = ''; try { refHost = ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch (e) {}
    if (refHost === location.hostname.replace(/^www\./, '')) refHost = '';
    var source = q.get('src') || q.get('utm_source') || refHost || 'direct';
    var t0 = Date.now(), maxScroll = 0, sent = {};
    function send(e, d, once) {
      if (once) { if (sent[e]) return; sent[e] = 1; }
      var body = JSON.stringify({ sid: sid, e: e, d: d || null, page: location.pathname });
      try { navigator.sendBeacon('/api/e', body); } catch (x) { fetch('/api/e', { method: 'POST', body: body, keepalive: true }); }
    }
    window.mfc = { track: send, source: source, sid: sid };
    send('view', {
      source: source, ref: ref.slice(0, 200), refHost: refHost,
      utm: { s: q.get('utm_source'), m: q.get('utm_medium'), c: q.get('utm_campaign') },
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), lang: navigator.language || '',
      scr: screen.width + 'x' + screen.height, vp: innerWidth + 'x' + innerHeight,
      touch: 'ontouchstart' in window, wd: !!navigator.webdriver,
      newVisit: !localStorage.getItem('mfc_seen')
    });
    try { localStorage.setItem('mfc_seen', '1'); } catch (x) {}
    // engagement: first real interaction after the page settles
    var engage = function () { if (Date.now() - t0 > 800) send('engaged', null, true); };
    ['scroll', 'mousemove', 'touchstart', 'keydown', 'click'].forEach(function (ev) { addEventListener(ev, engage, { passive: true }); });
    addEventListener('scroll', function () {
      var h = document.documentElement, p = Math.round(100 * (scrollY + innerHeight) / h.scrollHeight);
      if (p > maxScroll) maxScroll = Math.min(p, 100);
    }, { passive: true });
    // phone / text taps
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="tel:"],a[href^="sms:"]');
      if (a) send(a.href.indexOf('sms:') === 0 ? 'text_tap' : 'call_tap', { where: a.textContent.trim().slice(0, 30) });
    });
    // leaving: time on page + how far they scrolled
    var left = false;
    function leave() { if (left) return; left = true; send('leave', { secs: Math.round((Date.now() - t0) / 1000), scroll: maxScroll }); }
    addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') leave(); else left = false; });
  } catch (e) {}
})();
