// Shared PWA bootstrap — registers the service worker and (on pages that include
// a #pwa-install button) wires the Android install prompt. pwa.js lives at the
// repo root, so we resolve sw.js relative to THIS script's own URL — that keeps
// the SW scope at the root regardless of which page (root or sub-folder) loads it.
(function () {
  var base = (document.currentScript && document.currentScript.src) || self.location.href;
  var swUrl = new URL('sw.js', base).toString();
  var swScope = new URL('.', base).toString();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register(swUrl, { scope: swScope }).catch(function (e) {
        console.warn('[pwa] SW registration failed:', e);
      });
    });
  }

  // Android/desktop Chrome install flow. iOS Safari has no prompt — users add via
  // the Share sheet → "Add to Home Screen"; we surface a hint there instead.
  var deferred = null;
  var btn = document.getElementById('pwa-install');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (btn) btn.hidden = false;
  });
  if (btn) {
    btn.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () {
        deferred = null;
        btn.hidden = true;
      });
    });
  }
  window.addEventListener('appinstalled', function () {
    if (btn) btn.hidden = true;
  });

  // iOS standalone-capable Safari hint (only when not already installed).
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  var hint = document.getElementById('pwa-ios-hint');
  if (hint && isIOS && !standalone) hint.hidden = false;

  // ---- Force-update control -------------------------------------------------
  // A small floating "تحديث" button that wipes the service-worker caches +
  // registration and reloads, so anyone can pull the very latest version without
  // opening browser dev tools. Injected here so it shows on every page that loads
  // pwa.js. If a page hand-places its own #pwa-refresh, we reuse that instead.
  var refreshBtn = document.getElementById('pwa-refresh');
  if (!refreshBtn) {
    var style = document.createElement('style');
    style.textContent =
      '#pwa-refresh{position:fixed;bottom:16px;left:16px;z-index:9999;display:inline-flex;' +
      'align-items:center;gap:7px;background:#4338ca;color:#fff;border:0;border-radius:99px;' +
      'padding:10px 15px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;' +
      'box-shadow:0 6px 18px rgba(15,23,42,.25);transition:transform .15s,background .15s;opacity:.92}' +
      '#pwa-refresh:hover{background:#4f46e5;transform:translateY(-1px);opacity:1}' +
      '#pwa-refresh:active{transform:scale(.96)}' +
      '#pwa-refresh[disabled]{opacity:.6;cursor:default}' +
      '#pwa-refresh .pwa-refresh-ico{display:inline-block;font-size:15px;line-height:1}' +
      '#pwa-refresh.is-busy .pwa-refresh-ico{animation:pwa-spin .8s linear infinite}' +
      '@keyframes pwa-spin{to{transform:rotate(360deg)}}' +
      '@media print{#pwa-refresh{display:none}}';
    document.head.appendChild(style);
    refreshBtn = document.createElement('button');
    refreshBtn.id = 'pwa-refresh';
    refreshBtn.type = 'button';
    refreshBtn.title = 'مسح الكاش وتحميل آخر نسخة من الموقع';
    refreshBtn.setAttribute('aria-label', 'تحديث الموقع');
    refreshBtn.innerHTML = '<span class="pwa-refresh-ico">↻</span><span>تحديث</span>';
    document.body.appendChild(refreshBtn);
  }

  refreshBtn.addEventListener('click', function () {
    if (refreshBtn.classList.contains('is-busy')) return;
    refreshBtn.classList.add('is-busy');
    refreshBtn.disabled = true;

    var clearCaches = (window.caches && caches.keys)
      ? caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        })
      : Promise.resolve();

    var clearSW = (navigator.serviceWorker && navigator.serviceWorker.getRegistrations)
      ? navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        })
      : Promise.resolve();

    Promise.all([clearCaches, clearSW])
      .catch(function (e) { console.warn('[pwa] force-refresh cleanup failed:', e); })
      .then(function () {
        // Cache-bust the navigation itself so the browser can't serve stale HTML.
        var u = new URL(window.location.href);
        u.searchParams.set('_', Date.now().toString());
        window.location.replace(u.toString());
      });
  });
})();
