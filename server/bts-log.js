/**
 * Logs estruturados para Railway / console (grep: [BTS]).
 * Nunca registrar chaves secretas completas.
 */

function maskDocumentInObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  if (typeof out.document === 'string' && out.document.length > 0) {
    const d = out.document.replace(/\D/g, '');
    out.documentMasked = d.length > 2 ? `***${d.slice(-2)}` : '***';
    delete out.document;
  }
  return out;
}

export function btsTrace(scope, event, data = {}) {
  const ts = new Date().toISOString();
  const safe = maskDocumentInObject({ ...data });
  const payload = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  console.log(`[BTS][${scope}][${event}] ${ts}${payload}`);
}

export function btsTraceErr(scope, event, err, extra = {}) {
  const ts = new Date().toISOString();
  const o = {
    message: err?.message || String(err),
    code: err?.code,
    status: err?.status,
    ...extra,
  };
  if (err?.details != null) {
    try {
      o.details =
        typeof err.details === 'object'
          ? JSON.stringify(err.details).slice(0, 2500)
          : String(err.details).slice(0, 800);
    } catch {
      o.details = '[unserializable]';
    }
  }
  console.error(`[BTS][${scope}][${event}][ERROR] ${ts} ${JSON.stringify(o)}`);
}
