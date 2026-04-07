import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, 'data', 'gateway-pix-log.json');
const MAX = 40;

function readLog() {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const j = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** Registra falha ou aviso do PIX para exibir no painel admin (não substitui logs [BTS] no console). */
export function appendGatewayPixLog(entry) {
  const row = {
    at: new Date().toISOString(),
    ...entry,
  };
  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prev = readLog();
    prev.unshift(row);
    fs.writeFileSync(LOG_PATH, JSON.stringify(prev.slice(0, MAX), null, 0), 'utf8');
  } catch (e) {
    console.error('[BTS][gateway-log] write failed', e.message);
  }
}

export function loadGatewayPixLogs() {
  return readLog();
}
