/**
 * Captura UTMs e envia contexto para o dataLayer (GA4 / GTM) + persistência local.
 * Inclua após carregar a página e chame initTrackingPage('nome_pagina').
 */
(function () {
  const STORAGE_KEY = 'bts_utm_context';

  function getParams() {
    const q = new URLSearchParams(window.location.search);
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
    const o = {};
    keys.forEach((k) => {
      const v = q.get(k);
      if (v) o[k] = v;
    });
    return o;
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveContext(merge) {
    const prev = loadStored();
    const next = { ...prev, ...merge, lastPath: window.location.pathname + window.location.search };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  window.BtsTracking = {
    getContext() {
      const fromUrl = getParams();
      const merged = saveContext(fromUrl);
      return merged;
    },

    pushPageView(pageName) {
      const ctx = this.getContext();
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'bts_page_view',
        page_name: pageName,
        ...ctx,
      });
    },

    pushBeginCheckout(payload) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'begin_checkout',
        ...payload,
      });
    },

    pushPurchase(payload) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'purchase',
        ...payload,
      });
    },
  };
})();
