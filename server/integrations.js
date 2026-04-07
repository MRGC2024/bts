import { btsTrace, btsTraceErr } from './bts-log.js';

const UTMIFY_URL = 'https://api.utmify.com.br/api-credentials/orders';

export function formatUtmifyUtcDate(isoOrDate) {
  if (!isoOrDate) return null;
  const x = new Date(isoOrDate);
  if (Number.isNaN(x.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(
    x.getUTCHours()
  )}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
}

export function mapQuantumStatusToUtmify(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'paid' || s === 'approved') return 'paid';
  if (s === 'refused') return 'refused';
  if (s === 'refunded') return 'refunded';
  if (s === 'chargeback') return 'chargedback';
  return 'waiting_payment';
}

export async function sendUtmifyOrder(cfg, order, utmifyStatus) {
  const token = (cfg.utmifyApiToken || '').trim();
  if (!token) return { skipped: true, reason: 'no_token' };

  const createdAt = formatUtmifyUtcDate(order.createdAt) || formatUtmifyUtcDate(new Date());
  const approvedDate =
    utmifyStatus === 'paid'
      ? formatUtmifyUtcDate(order.paidAt || new Date())
      : null;

  const totalCents = order.totalCents || 0;
  const gatewayFee = order.gatewayFeeInCents ?? 0;
  let userComm = totalCents - gatewayFee;
  if (userComm <= 0) userComm = totalCents;

  const tp = order.tracking || {};
  const body = {
    orderId: order.id,
    platform: cfg.platformName || 'BTSIngressos',
    paymentMethod: 'pix',
    status: utmifyStatus,
    createdAt,
    approvedDate,
    refundedAt: utmifyStatus === 'refunded' ? formatUtmifyUtcDate(order.refundedAt) : null,
    customer: {
      name: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone || null,
      document: order.customerDocument || null,
      country: 'BR',
      ip: order.customerIp || null,
    },
    products: [
      {
        id: `${order.sectorId}-${order.ticketType}`,
        name: `${order.sectorLabel} — ${order.ticketType === 'meia' ? 'Meia' : 'Inteira'} (${order.lote})`,
        planId: order.lote,
        planName: order.lote,
        quantity: order.quantity,
        priceInCents: Math.round(order.unitPriceCents),
      },
    ],
    trackingParameters: {
      src: tp.src || null,
      sck: tp.sck || null,
      utm_source: tp.utm_source || null,
      utm_campaign: tp.utm_campaign || null,
      utm_medium: tp.utm_medium || null,
      utm_content: tp.utm_content || null,
      utm_term: tp.utm_term || null,
    },
    commission: {
      totalPriceInCents: totalCents,
      gatewayFeeInCents: gatewayFee,
      userCommissionInCents: userComm,
      currency: 'BRL',
    },
  };

  const res = await fetch(UTMIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-token': token,
    },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    data = { raw: await res.text() };
  }
  if (!res.ok) {
    const err = new Error(`Utmify ${res.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

function normalizeAmounts(cfg, order) {
  const amountCents = Number(order.totalCents) || 0;
  const qty = Math.max(1, Number(order.quantity) || 1);
  const unitCents = Math.round(amountCents / qty);
  const unit = (cfg.quantumAmountUnit || 'cents').toLowerCase() === 'reais' ? 'reais' : 'cents';
  if (unit === 'reais') {
    return {
      amount: Number((amountCents / 100).toFixed(2)),
      unitPrice: Number((unitCents / 100).toFixed(2)),
    };
  }
  return { amount: Math.round(amountCents), unitPrice: Math.round(unitCents) };
}

export function extractPixPayload(quantumData) {
  const root = quantumData?.data ?? quantumData;
  const pix = root?.pix ?? quantumData?.pix ?? {};
  const direct =
    pix.qrcode ||
    pix.qrCode ||
    pix.qr_code ||
    pix.copyPaste ||
    pix.copy_paste ||
    pix.emv ||
    root?.pixQrCode ||
    quantumData?.pixQrCode;
  if (direct) return String(direct);
  const nested = pix.dynamicQrCode?.qrcode || pix.qr?.payload || root?.brCode;
  return nested ? String(nested) : null;
}

export async function createQuantumPix(cfg, order, publicBaseUrl, logRid = '') {
  const rid = logRid || String(order.id || '').slice(0, 8) || 'no-id';
  const scope = `quantum:${rid}`;

  const pub = (cfg.quantumPublicKey || '').trim();
  const sec = (cfg.quantumSecretKey || '').trim();
  if (!pub || !sec) {
    btsTrace(scope, 'config_missing', {
      hasPublic: !!pub,
      hasSecret: !!sec,
      orderId: order.id,
    });
    const err = new Error('Chaves Quantum ausentes no painel (pública e secreta).');
    err.code = 'quantum_config';
    throw err;
  }

  const base = (cfg.quantumApiBase || 'https://api.quantumpayments.com.br/v1').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  const postbackUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/webhook/quantum`;

  const { amount, unitPrice } = normalizeAmounts(cfg, order);
  const amountUnit = (cfg.quantumAmountUnit || 'cents').toLowerCase() === 'reais' ? 'reais' : 'cents';

  btsTrace(scope, 'request_prepare', {
    orderId: order.id,
    apiHost: (() => {
      try {
        return new URL(base).host;
      } catch {
        return base;
      }
    })(),
    postbackUrl,
    amountUnit,
    amount,
    unitPrice,
    quantity: order.quantity,
    totalCents: order.totalCents,
    paymentMethod: 'pix',
    document: String(order.customerDocument || '').replace(/\D/g, ''),
  });

  const payload = {
    amount,
    paymentMethod: 'pix',
    postbackUrl,
    externalRef: order.id,
    metadata: JSON.stringify({
      orderId: order.id,
      lote: order.lote,
      sector: order.sectorId,
    }),
    customer: {
      name: order.customerName,
      email: order.customerEmail,
      phone: String(order.customerPhone || '').replace(/\D/g, '') || undefined,
      document: {
        type: 'cpf',
        number: String(order.customerDocument || '').replace(/\D/g, ''),
      },
    },
    items: [
      {
        title: `${order.sectorLabel} (${order.ticketType})`,
        quantity: order.quantity,
        tangible: false,
        unitPrice,
        externalRef: `${order.id}-item`,
      },
    ],
  };

  const url = `${base}/transactions`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    btsTraceErr(scope, 'fetch_failed', e, {
      url,
      name: e?.name,
      cause: e?.cause?.message,
    });
    const err = new Error(
      e?.name === 'TimeoutError'
        ? 'Tempo esgotado ao falar com api.quantumpayments.com.br'
        : 'Rede ao contactar Quantum: ' + (e?.message || 'falha')
    );
    err.code = 'quantum_network';
    throw err;
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { parseError: true, raw: text?.slice(0, 800) };
  }

  const root = data?.data ?? data;
  const topKeys = data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [];
  const pixKeys =
    root && typeof root === 'object' && root.pix && typeof root.pix === 'object'
      ? Object.keys(root.pix)
      : [];

  if (!res.ok) {
    btsTrace(scope, 'http_error', {
      httpStatus: res.status,
      url,
      responseKeys: topKeys,
      bodySnippet: text?.slice(0, 1800),
    });
    const msg =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (Array.isArray(data.errors) ? JSON.stringify(data.errors).slice(0, 400) : null) ||
      `Quantum HTTP ${res.status}`;
    const err = new Error(msg);
    err.details = data;
    err.status = res.status;
    err.code = 'quantum_upstream';
    btsTraceErr(scope, 'upstream_rejected', err, { httpStatus: res.status });
    throw err;
  }

  const hasPix = !!extractPixPayload(data);
  btsTrace(scope, 'response_ok', {
    httpStatus: res.status,
    transactionId: root?.id ?? data?.id ?? null,
    dataKeys: topKeys,
    pixKeys,
    hasExtractablePixCode: hasPix,
  });

  return data;
}
