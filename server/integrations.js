import { btsTrace, btsTraceErr } from './bts-log.js';
import { appendGatewayPixLog } from './gateway-log.js';

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

/**
 * Monta body da transação Quantum com amount/items coerentes (evita "valores inválidos").
 * - reais: amount e unitPrice em decimal (2 casas), alinhados ao total em centavos internos.
 * - cents: inteiros em centavos.
 */
export function buildQuantumTransactionPayload(order, unitMode) {
  const totalCents = Math.round(Number(order.totalCents) || 0);
  const qty = Math.max(1, Number(order.quantity) || 1);
  const doc = String(order.customerDocument || '').replace(/\D/g, '');

  const phoneRaw = String(order.customerPhone || '').replace(/\D/g, '');
  const phone = phoneRaw.length >= 10 && phoneRaw.length <= 13 ? phoneRaw : undefined;

  const base = {
    paymentMethod: 'pix',
    externalRef: order.id,
    metadata: JSON.stringify({
      orderId: order.id,
      lote: order.lote,
      sector: order.sectorId,
    }),
    customer: {
      name: String(order.customerName || '').trim(),
      email: String(order.customerEmail || '').trim(),
      ...(phone ? { phone } : {}),
      document: {
        type: 'cpf',
        number: doc,
      },
    },
  };

  if (unitMode === 'cents') {
    const unitCents = Math.round(totalCents / qty);
    const remainder = totalCents - unitCents * qty;
    let items;
    if (remainder !== 0) {
      items = [
        {
          title: `${order.sectorLabel} (${order.ticketType}) · ${qty} un.`,
          quantity: 1,
          unitPrice: totalCents,
          tangible: false,
          externalRef: `${order.id}-item`,
        },
      ];
    } else {
      items = [
        {
          title: `${order.sectorLabel} (${order.ticketType})`,
          quantity: qty,
          unitPrice: unitCents,
          tangible: false,
          externalRef: `${order.id}-item`,
        },
      ];
    }
    return { ...base, amount: totalCents, items };
  }

  const amount = Number((totalCents / 100).toFixed(2));
  const unitCentsEach = Math.floor(totalCents / qty);
  const remainder = totalCents - unitCentsEach * qty;
  let items;
  if (remainder !== 0) {
    items = [
      {
        title: `${order.sectorLabel} (${order.ticketType}) · ${qty} un.`,
        quantity: 1,
        unitPrice: amount,
        tangible: false,
        externalRef: `${order.id}-item`,
      },
    ];
  } else {
    const unitPrice = Number((unitCentsEach / 100).toFixed(2));
    items = [
      {
        title: `${order.sectorLabel} (${order.ticketType})`,
        quantity: qty,
        unitPrice,
        tangible: false,
        externalRef: `${order.id}-item`,
      },
    ];
  }
  return { ...base, amount, items };
}

/** Erro da Quantum costuma vir em data.error como objeto, ex.: { postbackUrl: "..." } */
function isPostbackRelatedQuantumError(data, rawText) {
  const err = data?.error;
  const blob = `${JSON.stringify(err || {})} ${data?.message || ''} ${rawText || ''}`.toLowerCase();
  if (blob.includes('postback')) return true;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    if ('postbackUrl' in err || 'postback' in err) return true;
  }
  return false;
}

/**
 * Só tenta reais↔centavos quando há sinal claro de valor; a mensagem genérica
 * "Requisição com valores inválidos" também cobre postbackUrl inválida — não pode disparar retry.
 */
function isLikelyInvalidAmountError(data, rawText) {
  if (isPostbackRelatedQuantumError(data, rawText)) return false;
  const err = data?.error;
  if (err && typeof err === 'object' && err !== null && !Array.isArray(err)) {
    const keys = Object.keys(err).join(' ').toLowerCase();
    if (keys.includes('amount') || keys.includes('unitprice') || keys.includes('items') || keys.includes('price')) {
      return true;
    }
  }
  const errStr = typeof err === 'string' ? err : '';
  const msg = `${errStr} ${data?.message || ''} ${rawText || ''}`.toLowerCase();
  if (msg.includes('postback')) return false;
  if (msg.includes('valores inválidos') || msg.includes('valores invalidos')) return false;
  return (
    ((msg.includes('valor') || msg.includes('amount')) &&
      (msg.includes('inválid') || msg.includes('invalid'))) ||
    msg.includes('unitprice') ||
    msg.includes('unit price') ||
    msg.includes('preço')
  );
}

/**
 * Monta a URL do webhook Quantum e valida (HTTPS + host público).
 * A API rejeita postback em localhost e costuma exigir HTTPS em produção.
 */
export function buildQuantumPostbackUrl(publicBaseUrl) {
  const raw = String(publicBaseUrl || '').trim();
  if (!raw) {
    const e = new Error(
      'Configure a URL pública do site (painel Utmify/URL ou variável PUBLIC_BASE_URL no servidor). É obrigatória para o postback do PIX.'
    );
    e.code = 'quantum_postback_url';
    throw e;
  }
  let u;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    const e = new Error(
      'URL pública inválida. Informe o endereço completo do site, ex.: https://seu-app.up.railway.app'
    );
    e.code = 'quantum_postback_url';
    throw e;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')) {
    const e = new Error(
      'A Quantum não aceita URL de postback em localhost. No painel, coloque a URL HTTPS do deploy (ex.: Railway) ou defina PUBLIC_BASE_URL.'
    );
    e.code = 'quantum_postback_url';
    throw e;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const e = new Error('A URL pública deve ser http ou https.');
    e.code = 'quantum_postback_url';
    throw e;
  }
  if (u.protocol === 'http:') {
    u = new URL(u.href.replace(/^http:\/\//i, 'https://'));
  }
  let base = u.origin;
  if (u.pathname && u.pathname !== '/') {
    base = u.origin + u.pathname.replace(/\/$/, '');
  }
  return `${base}/api/webhook/quantum`;
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

async function postQuantum(base, auth, bodyObj) {
  const url = `${base.replace(/\/$/, '')}/transactions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(55000),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { parseError: true, raw: text?.slice(0, 800) };
  }
  return { res, data, text, url };
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

  const docDigits = String(order.customerDocument || '').replace(/\D/g, '');
  if (docDigits.length !== 11) {
    const err = new Error('CPF deve ter 11 dígitos para gerar o PIX.');
    err.code = 'quantum_validation';
    throw err;
  }

  const base = (cfg.quantumApiBase || 'https://api.quantumpayments.com.br/v1').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  let postbackUrl;
  try {
    postbackUrl = buildQuantumPostbackUrl(publicBaseUrl);
  } catch (e) {
    if (e.code === 'quantum_postback_url') throw e;
    const err = new Error(e?.message || 'URL de postback inválida.');
    err.code = 'quantum_postback_url';
    throw err;
  }

  const primaryUnit = (cfg.quantumAmountUnit || 'reais').toLowerCase() === 'cents' ? 'cents' : 'reais';
  const alternateUnit = primaryUnit === 'cents' ? 'reais' : 'cents';

  const attempts = [
    { unit: primaryUnit, label: 'primary' },
    { unit: alternateUnit, label: 'retry_alt_unit' },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { unit, label } = attempts[i];
    const body = buildQuantumTransactionPayload(order, unit);
    body.postbackUrl = postbackUrl;

    btsTrace(scope, `request_${label}`, {
      orderId: order.id,
      amountUnit: unit,
      amount: body.amount,
      items: body.items?.map((it) => ({
        q: it.quantity,
        unitPrice: it.unitPrice,
        title: it.title?.slice(0, 40),
      })),
      postbackUrl,
    });

    let fetchRes;
    try {
      fetchRes = await postQuantum(base, auth, body);
    } catch (e) {
      btsTraceErr(scope, 'fetch_failed', e, { attempt: label });
      const err = new Error(
        e?.name === 'TimeoutError'
          ? 'Tempo esgotado ao falar com api.quantumpayments.com.br'
          : 'Rede ao contactar Quantum: ' + (e?.message || 'falha')
      );
      err.code = 'quantum_network';
      throw err;
    }

    const { res, data, text } = fetchRes;

    const root = data?.data ?? data;
    const topKeys = data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [];
    const pixKeys =
      root && typeof root === 'object' && root.pix && typeof root.pix === 'object'
        ? Object.keys(root.pix)
        : [];

    if (res.ok) {
      btsTrace(scope, 'response_ok', {
        attempt: label,
        amountUnit: unit,
        httpStatus: res.status,
        transactionId: root?.id ?? data?.id ?? null,
        dataKeys: topKeys,
        pixKeys,
        hasExtractablePixCode: !!extractPixPayload(data),
      });
      return data;
    }

    let msg =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (Array.isArray(data.errors) ? JSON.stringify(data.errors).slice(0, 400) : null) ||
      `Quantum HTTP ${res.status}`;

    btsTrace(scope, 'http_error', {
      attempt: label,
      amountUnit: unit,
      httpStatus: res.status,
      responseKeys: topKeys,
      bodySnippet: text?.slice(0, 1800),
      postbackUrl,
    });

    const err = new Error(msg);
    err.details = data;
    err.status = res.status;
    err.code = 'quantum_upstream';

    if (isPostbackRelatedQuantumError(data, text)) {
      err.code = 'quantum_postback_url';
      const nested = data?.error;
      const reason =
        nested && typeof nested === 'object' && nested.postbackUrl
          ? String(nested.postbackUrl)
          : typeof nested === 'string'
            ? nested
            : '';
      err.message = reason
        ? `${reason} URL enviada: ${postbackUrl}`
        : `URL de postback recusada pela Quantum. Verifique URL pública (HTTPS, domínio liberado no painel Quantum). Enviada: ${postbackUrl}`;
    }

    const shouldRetry =
      i === 0 &&
      isLikelyInvalidAmountError(data, text) &&
      primaryUnit !== alternateUnit;

    if (shouldRetry) {
      appendGatewayPixLog({
        kind: 'quantum_retry',
        orderId: order.id,
        rid,
        message: `1ª tentativa (${primaryUnit}) recusada pela Quantum; em seguida tentamos ${alternateUnit}.`,
        httpStatus: res.status,
        gatewayMessage: msg,
      });
      continue;
    }

    btsTraceErr(scope, 'upstream_rejected', err, { httpStatus: res.status, attempt: label });
    throw err;
  }

  throw new Error('Quantum: falha após tentativas de valor.');
}
