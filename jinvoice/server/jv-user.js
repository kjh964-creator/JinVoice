// JinVoice web only: small "who is signed in" chip with a logout link.
// Injected into the subpath web bundle by build_web_subpath.mjs; the desktop
// and Android apps never load it. Reads /jinvoice/me (served by the site gate).
(function () {
  if (!window.fetch || document.getElementById('jv-who')) return;
  fetch('/jinvoice/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.logged_in) return;
      var css = document.createElement('style');
      css.textContent =
        '#jv-who{position:fixed;left:14px;bottom:14px;z-index:2147483000;display:flex;align-items:center;gap:8px;' +
        'padding:6px 6px 6px 12px;border-radius:999px;font:13px/1.2 "Pretendard","Malgun Gothic",system-ui,sans-serif;' +
        'color:#2B2D45;background:rgba(255,255,255,.92);border:1px solid rgba(22,23,60,.12);' +
        'box-shadow:0 6px 20px -8px rgba(40,42,110,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}' +
        '#jv-who i{width:8px;height:8px;border-radius:50%;background:#12A374;flex:none}' +
        '#jv-who a{color:#4B4FE0;text-decoration:none;padding:4px 9px;border-radius:999px;background:#ECEBFF;font-weight:600}' +
        '#jv-who a:hover{filter:brightness(.96)}' +
        '@media (prefers-color-scheme:dark){#jv-who{color:#DADBEA;background:rgba(21,22,36,.9);border-color:rgba(255,255,255,.12)}' +
        '#jv-who a{color:#C9C6FF;background:rgba(124,108,255,.2)}}' +
        '@media print{#jv-who{display:none}}';
      var box = document.createElement('div');
      box.id = 'jv-who';
      box.setAttribute('role', 'status');
      var dot = document.createElement('i');
      var name = document.createElement('span');
      name.textContent = d.name + ' 로그인 중';
      var out = document.createElement('a');
      out.href = '/jinvoice/logout';
      out.textContent = '로그아웃';
      box.appendChild(dot); box.appendChild(name); box.appendChild(out);
      document.head.appendChild(css);
      document.body.appendChild(box);
    })
    .catch(function () {});
})();
