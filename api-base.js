/**
 * Prefixo opcional se o site não estiver na raiz do domínio.
 * Ex.: site em https://dominio.com.br/bts/ → no HTML: <meta name="bts-api-base" content="/bts">
 */
(function () {
  var m = document.querySelector('meta[name="bts-api-base"]');
  var base = ((m && m.getAttribute('content')) || '').replace(/\/$/, '');
  window.BTS_API_BASE = base;
  window.apiUrl = function (path) {
    if (!path || path.charAt(0) !== '/') path = '/' + (path || '');
    return base + path;
  };
})();
