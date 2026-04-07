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

export async function createQuantumPix(cfg, order, publicBaseUrl) {
  const pub = (cfg.quantumPublicKey || '').trim();
  const sec = (cfg.quantumSecretKey || '').trim();
  if (!pub || !sec) {
    const err = new Error('Quantum não configurado');
    err.code = 'quantum_config';
    throw err;
  }

  const base = (cfg.quantumApiBase || 'https://api.quantumpayments.com.br/v1').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  const postbackUrl = `${publicBaseUrl.replace(/\/$/, '')}/api/webhook/quantum`;

  /** Valor em centavos (padrão comum em gateways BR) */
  const amountCents = order.totalCents;
  const unitPerTicket = Math.round(amountCents / (order.quantity || 1));

  const payload = {
    amount: amountCents,
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
        unitPrice: unitPerTicket,
        externalRef: `${order.id}-item`,
      },
    ],
  };

  const res = await fetch(`${base}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Quantum HTTP ${res.status}`);
    err.details = data;
    err.status = res.status;
    throw err;
  }

  return data;
}
