import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

import {
  loadConfig,
  saveConfig,
  appendOrder,
  updateOrder,
  findOrderById,
  findOrderByPublicToken,
  loadOrders,
} from './store.js';
import {
  createQuantumPix,
  extractPixPayload,
  sendUtmifyOrder,
  mapQuantumStatusToUtmify,
} from './integrations.js';
import { btsTrace, btsTraceErr } from './bts-log.js';
import { appendGatewayPixLog, loadGatewayPixLogs } from './gateway-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3055;

const app = express();
app.set('trust proxy', 1);

const SECTORS = {
  arquib: { label: 'Arquibancada', color: '#e02020', inteira: 68000, meia: 34000 },
  sup: { label: 'Cadeira Superior', color: '#ff9800', inteira: 98000, meia: 49000 },
  inf: { label: 'Cadeira Inferior', color: '#00bcd4', inteira: 108000, meia: 54000 },
  pista: { label: 'Pista', color: '#0d47a1', inteira: 125000, meia: 62500 },
};

app.use(cors());
app.use(express.json({ limit: '2mb' }));

/** URL pública para webhooks (Quantum). Ordem: painel > PUBLIC_BASE_URL > host da requisição. */
function getPublicBaseUrl(req, cfg) {
  const clean = (u) => String(u || '').replace(/\/$/, '');
  const fromCfg = clean(cfg.publicBaseUrl);
  if (fromCfg) return fromCfg;
  const fromEnv = clean(process.env.PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv;
  const railDom = clean(process.env.RAILWAY_PUBLIC_DOMAIN);
  if (railDom) return `https://${railDom}`;
  const host = req.get('host');
  if (host) {
    const proto =
      req.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
      req.protocol ||
      'https';
    return `${proto}://${host}`;
  }
  return `http://localhost:${PORT}`;
}

function publicCfg(cfg) {
  return {
    ga4MeasurementId: cfg.ga4MeasurementId || '',
    googleAdsConversionId: cfg.googleAdsConversionId || '',
    googleAdsConversionLabel: cfg.googleAdsConversionLabel || '',
    maxTicketsPerOrder: Math.max(1, Math.min(99, Number(cfg.maxTicketsPerOrder) || 4)),
    platformName: cfg.platformName || 'BTSIngressos',
  };
}

app.get('/api/public-config', (req, res) => {
  res.json(publicCfg(loadConfig()));
});

app.get('/api/sectors', (req, res) => {
  const cfg = loadConfig();
  const maxQ = publicCfg(cfg).maxTicketsPerOrder;
  res.json({ sectors: SECTORS, maxTicketsPerOrder: maxQ });
});

function getAdminSession(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
}

async function assertAdmin(req, res, next) {
  const cfg = loadConfig();
  const envPass = process.env.ADMIN_PASSWORD;
  const token = getAdminSession(req);
  if (!token) return res.status(401).json({ error: 'Não autorizado' });

  if (envPass && token === envPass) return next();

  if (cfg.adminPasswordHash && (await bcrypt.compare(token, cfg.adminPasswordHash))) {
    return next();
  }
  return res.status(401).json({ error: 'Não autorizado' });
}

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body || {};
  const cfg = loadConfig();
  const envPass = process.env.ADMIN_PASSWORD;
  const pass = String(password || '');

  if (envPass && pass === envPass) {
    return res.json({ token: envPass, ok: true });
  }
  if (cfg.adminPasswordHash && pass && (await bcrypt.compare(pass, cfg.adminPasswordHash))) {
    return res.json({ token: pass, ok: true });
  }
  /* Primeiro acesso: sem senha salva e sem .env — define senha inicial */
  if (!cfg.adminPasswordHash && !envPass && pass.length >= 6) {
    saveConfig({
      adminPasswordHash: await bcrypt.hash(pass, 10),
    });
    return res.json({ token: pass, ok: true });
  }
  res.status(401).json({ error: 'Senha inválida' });
});

app.get('/api/admin/config', assertAdmin, (req, res) => {
  const cfg = loadConfig();
  res.json({
    ...cfg,
    quantumSecretKey: cfg.quantumSecretKey ? '********' : '',
    utmifyApiToken: cfg.utmifyApiToken ? '********' : '',
  });
});

app.put('/api/admin/config', assertAdmin, async (req, res) => {
  const body = req.body || {};
  const prev = loadConfig();
  const next = { ...prev };

  const fields = [
    'quantumPublicKey',
    'quantumApiBase',
    'quantumAmountUnit',
    'utmifyApiToken',
    'ga4MeasurementId',
    'googleAdsConversionId',
    'googleAdsConversionLabel',
    'maxTicketsPerOrder',
    'platformName',
    'publicBaseUrl',
  ];
  for (const f of fields) {
    if (body[f] !== undefined) next[f] = body[f];
  }
  if (body.quantumSecretKey && body.quantumSecretKey !== '********') {
    next.quantumSecretKey = body.quantumSecretKey;
  }
  if (body.utmifyApiToken && body.utmifyApiToken !== '********') {
    next.utmifyApiToken = body.utmifyApiToken;
  }
  if (body.newAdminPassword && String(body.newAdminPassword).length >= 6) {
    next.adminPasswordHash = await bcrypt.hash(String(body.newAdminPassword), 10);
  }

  saveConfig(next);
  res.json({ ok: true, config: publicCfg(next) });
});

app.get('/api/admin/orders', assertAdmin, (req, res) => {
  res.json({ orders: loadOrders() });
});

app.get('/api/admin/gateway-pix-log', assertAdmin, (req, res) => {
  res.json({ entries: loadGatewayPixLogs() });
});

function fakePurchaseId() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `TM-BR-${n}`;
}

function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    ''
  );
}

app.post('/api/checkout/create', async (req, res) => {
      const rid = Math.random().toString(36).slice(2, 10);
      try {
        const cfg = loadConfig();
        const maxT = publicCfg(cfg).maxTicketsPerOrder;
        const {
          lote,
          sectorId,
          ticketType,
          quantity,
          customerName,
          customerEmail,
          customerPhone,
          customerDocument,
          tracking,
        } = req.body || {};

        const sec = SECTORS[sectorId];
        if (!sec) return res.status(400).json({ error: 'Setor inválido' });
        const tt = ticketType === 'meia' ? 'meia' : 'inteira';
        const q = Math.max(1, Math.min(maxT, parseInt(String(quantity), 10) || 1));
        const unit = sec[tt];
        const totalCents = unit * q;

        if (!customerName || !customerEmail || !customerDocument) {
          return res.status(400).json({ error: 'Preencha nome, e-mail e CPF' });
        }

        const docDigits = String(customerDocument).replace(/\D/g, '');
        if (docDigits.length !== 11) {
          return res.status(400).json({ error: 'CPF deve ter 11 dígitos (somente números).' });
        }

        const baseUrl = getPublicBaseUrl(req, cfg);

        btsTrace(`checkout:${rid}`, 'validated', {
          rid,
          sectorId,
          lote,
          ticketType: tt,
          quantity: q,
          totalCents,
          publicBaseUrl: baseUrl,
          quantumAmountUnit: cfg.quantumAmountUnit || 'cents',
          hasQuantumKeys: !!(cfg.quantumPublicKey && cfg.quantumSecretKey),
        });

        const order = {
          id: uuidv4(),
          publicToken: uuidv4().replace(/-/g, '').slice(0, 16),
          fakePurchaseId: fakePurchaseId(),
          requestId: `SOL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          lote: String(lote || ''),
          sectorId,
          sectorLabel: sec.label,
          ticketType: tt,
          quantity: q,
          unitPriceCents: unit,
          totalCents,
          status: 'pending',
          customerName: String(customerName).trim(),
          customerEmail: String(customerEmail).trim(),
          customerPhone: String(customerPhone || '').trim(),
          customerDocument: String(customerDocument).replace(/\D/g, ''),
          customerIp: clientIp(req),
          tracking: tracking || {},
          quantumTransactionId: null,
          pixQrCode: null,
          pixExpiresAt: null,
          paidAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        appendOrder(order);
        btsTrace(`checkout:${rid}`, 'order_persisted', {
          orderId: order.id,
          publicToken: order.publicToken,
        });

        try {
          await sendUtmifyOrder(cfg, order, 'waiting_payment');
          btsTrace(`checkout:${rid}`, 'utmify_ok', { orderId: order.id });
        } catch (e) {
          btsTrace(`checkout:${rid}`, 'utmify_skipped_or_err', {
            message: e.message,
          });
        }

        let quantumData;
        try {
          quantumData = await createQuantumPix(cfg, order, baseUrl, rid);
        } catch (e) {
          btsTraceErr(`checkout:${rid}`, 'quantum_throw', e, { orderId: order.id });
          appendGatewayPixLog({
            kind: 'quantum_error',
            orderId: order.id,
            rid,
            code: e.code || 'quantum_upstream',
            message: e.message,
            httpStatus: e.status,
            details: e.details != null ? JSON.stringify(e.details).slice(0, 2000) : null,
          });
          updateOrder(order.id, {
            status: 'gateway_error',
            gatewayError: e.message,
            gatewayDetails: e.details,
          });
          const hint =
            e.code === 'quantum_config'
              ? ' Configure chave pública e secreta em Gateway PIX.'
              : e.code === 'quantum_network'
                ? ' Verifique rede/DNS do servidor ou tente de novo.'
                : e.code === 'quantum_validation'
                  ? ' Verifique CPF (11 dígitos).'
                  : ' O servidor já tentou reais e centavos automaticamente; se persistir, confira o painel Quantum e os logs abaixo.';
          const errStatus = e.code === 'quantum_validation' ? 400 : 424;
          return res.status(errStatus).json({
            error:
              'Falha ao gerar PIX no gateway.' +
              hint +
              ' Resposta: ' +
              (e.message || 'erro desconhecido'),
            code: e.code || 'quantum_upstream',
            details: e.details ?? null,
            orderId: order.id,
          });
        }

        const tx = quantumData.data || quantumData;
        const pixCode = extractPixPayload(quantumData);
        const pixObj = tx.pix || {};
        const gatewayFeeCents =
          tx.fee?.estimatedFee != null ? Math.round(Number(tx.fee.estimatedFee) * 100) : 0;

        if (!pixCode) {
          btsTrace(`checkout:${rid}`, 'missing_pix_payload', {
            orderId: order.id,
            txKeys: tx && typeof tx === 'object' ? Object.keys(tx) : [],
            rawSnippet: JSON.stringify(tx).slice(0, 2000),
          });
          appendGatewayPixLog({
            kind: 'quantum_missing_pix',
            orderId: order.id,
            rid,
            message: 'Resposta OK mas sem campo de código PIX',
            rawSnippet: JSON.stringify(tx).slice(0, 1500),
          });
          updateOrder(order.id, {
            status: 'gateway_error',
            gatewayError: 'Resposta Quantum sem qrcode/copyPaste',
            quantumRaw: tx,
          });
          return res.status(424).json({
            error:
              'O gateway respondeu, mas não veio código PIX (QR). Veja o formato na documentação e abra um chamado com a Quantum.',
            code: 'quantum_missing_pix',
            details: { hint: 'Confira se a API devolve pix.qrcode, copyPaste ou similar.', id: tx.id },
            orderId: order.id,
          });
        }

        updateOrder(order.id, {
          status: 'waiting_payment',
          quantumTransactionId: tx.id ?? quantumData.id,
          quantumRaw: tx,
          pixQrCode: pixCode,
          pixExpiresAt: pixObj.expirationDate || pixObj.expiresAt || null,
          gatewayFeeInCents: gatewayFeeCents,
        });

        const fresh = findOrderById(order.id);
        btsTrace(`checkout:${rid}`, 'pix_ready', {
          orderId: fresh.id,
          quantumTransactionId: fresh.quantumTransactionId,
          pixCodeLength: fresh.pixQrCode ? String(fresh.pixQrCode).length : 0,
        });
        res.json({
          orderId: fresh.id,
          publicToken: fresh.publicToken,
          pixQrCode: fresh.pixQrCode,
          expiresAt: fresh.pixExpiresAt,
          amountCents: fresh.totalCents,
        });
      } catch (e) {
        btsTraceErr(`checkout:${rid}`, 'unhandled', e);
        res.status(500).json({ error: e.message || 'Erro interno' });
      }
});

app.get('/api/order/:publicToken', (req, res) => {
  const o = findOrderByPublicToken(req.params.publicToken);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json({
    id: o.id,
    publicToken: o.publicToken,
    fakePurchaseId: o.fakePurchaseId || null,
    requestId: o.requestId || null,
    status: o.status,
    lote: o.lote,
    sectorLabel: o.sectorLabel,
    ticketType: o.ticketType,
    quantity: o.quantity,
    unitPriceCents: o.unitPriceCents,
    totalCents: o.totalCents,
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    paidAt: o.paidAt,
    createdAt: o.createdAt,
    pixQrCode: o.pixQrCode,
  });
});

app.post('/api/webhook/quantum', express.json({ type: '*/*' }), async (req, res) => {
  res.sendStatus(200);

  try {
    const payload = req.body;
    const data = payload?.data || payload;
    const externalRef = data.externalRef || data.external_ref;
    if (!externalRef) return;

    const order = findOrderById(externalRef);
    if (!order) return;

    const rawStatus = data.status;
    const utStatus = mapQuantumStatusToUtmify(rawStatus);
    const paid = rawStatus === 'paid' || rawStatus === 'approved';

    const patch = {
      status: paid ? 'paid' : rawStatus || order.status,
      paidAt: paid ? new Date().toISOString() : order.paidAt,
      webhookLast: data,
    };
    updateOrder(order.id, patch);
    const cfg = loadConfig();
    const updated = findOrderById(order.id);
    try {
      await sendUtmifyOrder(cfg, updated, utStatus);
    } catch (e) {
      console.warn('Utmify webhook:', e.message);
    }
  } catch (e) {
    console.error('webhook', e);
  }
});

app.get('/health', (req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/', (req, res) => {
  res.redirect(302, '/event/bts-world-tour-arirang.html');
});

app.use(express.static(ROOT));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BTS tickets listening on 0.0.0.0:${PORT}`);
  console.log(`Site: /event/bts-world-tour-arirang.html | Admin: /admin/`);
});
