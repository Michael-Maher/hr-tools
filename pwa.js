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
})();
