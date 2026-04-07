import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ORDERS_PATH = path.join(DATA_DIR, 'orders.json');

const defaultConfig = {
  quantumPublicKey: '',
  quantumSecretKey: '',
  quantumApiBase: 'https://api.quantumpayments.com.br/v1',
  /** Quantum Pay costuma validar em REAIS (decimal); 'cents' só se o manual disser explícito */
  quantumAmountUnit: 'reais',
  utmifyApiToken: '',
  ga4MeasurementId: '',
  googleAdsConversionId: '',
  googleAdsConversionLabel: '',
  maxTicketsPerOrder: 4,
  adminPasswordHash: '',
  platformName: 'BTSIngressos',
  publicBaseUrl: '',
  /** Nome fixo opcional para usar em {eventName} no título do item Quantum */
  quantumEventName: '',
  /**
   * Título da linha do produto no gateway (placeholders: {eventName} {sectorLabel} {sectorId} {ticketType} {ticketTypeLabel} {lote} {quantity})
   * Vazio = padrão interno (equivalente a "{sectorLabel} ({ticketTypeLabel})").
   */
  quantumItemTitleTemplate: '',
  /** Quando o total não divide igual por quantidade, um único item agrupado (placeholders iguais) */
  quantumItemTitleTemplateBundle: '',
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
    return { ...defaultConfig };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {
    return { ...defaultConfig };
  }
}

export function saveConfig(cfg) {
  ensureDir();
  const merged = { ...loadConfig(), ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function loadOrders() {
  ensureDir();
  if (!fs.existsSync(ORDERS_PATH)) {
    fs.writeFileSync(ORDERS_PATH, '[]', 'utf8');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

export function saveOrders(orders) {
  ensureDir();
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2), 'utf8');
}

export function appendOrder(order) {
  const orders = loadOrders();
  orders.unshift(order);
  saveOrders(orders);
  return order;
}

export function updateOrder(orderId, patch) {
  const orders = loadOrders();
  const i = orders.findIndex((o) => o.id === orderId);
  if (i === -1) return null;
  orders[i] = { ...orders[i], ...patch, updatedAt: new Date().toISOString() };
  saveOrders(orders);
  return orders[i];
}

export function findOrderById(id) {
  return loadOrders().find((o) => o.id === id) || null;
}

export function findOrderByPublicToken(token) {
  return loadOrders().find((o) => o.publicToken === token) || null;
}
