/* JinVoice homepage: latest-release links + light motion. No dependencies. */
(function () {
  'use strict';

  var API = 'https://api.github.com/repos/kjh964-creator/JinVoice/releases/latest';
  var FALLBACK = 'https://github.com/kjh964-creator/JinVoice/releases/latest';
  var CACHE_KEY = 'jv-release-v1';
  var CACHE_MS = 10 * 60 * 1000;
  var WIN_RE = /^JinVoice-.*-win-x64\.exe$/i;
  var APK_NAME = 'jinvoice.apk';

  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    var mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(1) + 'GB';
    return (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + 'MB';
  }

  function cleanVersion(tag) {
    if (!tag) return '';
    return String(tag).trim().replace(/^v(?=\d)/i, '');
  }

  function apply(rel) {
    if (!rel || !Array.isArray(rel.assets)) return false;
    var win = null, apk = null;
    rel.assets.forEach(function (a) {
      if (!a || !a.name || !a.browser_download_url) return;
      if (!win && WIN_RE.test(a.name)) win = a;
      if (!apk && a.name.toLowerCase() === APK_NAME) apk = a;
    });

    var ver = cleanVersion(rel.tag_name || rel.name);
    if (!ver && win) {
      var m = win.name.match(/^JinVoice-(.+)-win-x64\.exe$/i);
      if (m) ver = m[1];
    }
    if (ver) {
      $all('[data-version]').forEach(function (el) { el.textContent = '최신 버전 v' + ver; });
    }

    var map = { win: win, apk: apk };
    Object.keys(map).forEach(function (k) {
      var a = map[k];
      if (!a) return;
      $all('[data-dl="' + k + '"]').forEach(function (el) {
        el.href = a.browser_download_url;
        el.setAttribute('data-file', a.name);
      });
      var size = fmtSize(a.size);
      if (size) {
        $all('[data-size="' + k + '"]').forEach(function (el) {
          el.textContent = (k === 'win' ? 'Windows 10 · 11 · ' : 'APK · ') + size;
        });
        $all('[data-size-inline="' + k + '"]').forEach(function (el) { el.textContent = '· ' + size; });
      }
    });
    document.documentElement.setAttribute('data-release', (win || apk) ? 'ok' : 'partial');
    return true;
  }

  function fallback() {
    $all('[data-dl]').forEach(function (el) {
      if (!el.getAttribute('data-file')) el.href = FALLBACK;
    });
    document.documentElement.setAttribute('data-release', 'fallback');
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (Date.now() - c.t > CACHE_MS) return null;
      return c.d;
    } catch (e) { return null; }
  }

  function writeCache(d) {
    try {
      var slim = { tag_name: d.tag_name, name: d.name, assets: (d.assets || []).map(function (a) {
        return { name: a.name, size: a.size, browser_download_url: a.browser_download_url };
      }) };
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), d: slim }));
    } catch (e) { /* storage may be blocked */ }
  }

  function loadRelease() {
    var cached = readCache();
    if (cached && apply(cached)) return;
    if (!window.fetch) { fallback(); return; }

    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 7000);
    fetch(API, { headers: { 'Accept': 'application/vnd.github+json' }, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        clearTimeout(timer);
        if (apply(d)) writeCache(d); else fallback();
      })
      .catch(function () { clearTimeout(timer); fallback(); });
  }

  /* sticky nav border */
  function navShadow() {
    var nav = document.querySelector('.nav');
    if (!nav) return;
    var on = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    on();
    window.addEventListener('scroll', on, { passive: true });
  }

  /* reveal on scroll */
  function reveal() {
    var els = $all('.reveal');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) {
        el.style.transitionDelay = Math.min(i, 6) * 60 + 'ms';
      }
      io.observe(el);
    });
  }

  window.JinVoiceSite = { apply: apply, fallback: fallback, fmtSize: fmtSize };
  navShadow();
  reveal();
  loadRelease();
})();

// Login status chip: shows who is signed in to the web JinVoice.
(function () {
  var box = document.querySelector('[data-who]');
  if (!box || !window.fetch) return;
  fetch('/jinvoice/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.logged_in) return;
      box.querySelector('[data-who-name]').textContent = d.name + ' 로그인 중';
      box.hidden = false;
      document.querySelectorAll('a[href="/app/jinvoice-login"]').forEach(function (a) { a.href = '/jinvoice/app/'; });
    })
    .catch(function () {});
})();
