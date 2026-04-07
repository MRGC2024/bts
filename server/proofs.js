import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PAYMENT_PROOFS_DIR = path.join(__dirname, 'data', 'payment-proofs');

export function savePaymentProof(orderId, { note, imageBase64 }) {
  const n = String(note || '').trim().slice(0, 2000);
  const hasImg = typeof imageBase64 === 'string' && imageBase64.length > 30;
  if (!n && !hasImg) {
    throw new Error('Envie uma foto do comprovante ou uma mensagem.');
  }

  fs.mkdirSync(PAYMENT_PROOFS_DIR, { recursive: true });

  const meta = {
    orderId,
    submittedAt: new Date().toISOString(),
    note: n || null,
    hasImage: false,
    imageFile: null,
  };

  if (hasImg) {
    const m = imageBase64.match(/^data:image\/(png|jpeg|jpg|webp);base64,([\s\S]+)$/i);
    if (!m) {
      throw new Error('Imagem inválida. Use PNG, JPG ou WebP (captura de tela do comprovante).');
    }
    const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    if (buf.length > 1_800_000) {
      throw new Error('Imagem muito grande (máx. ~1,3 MB).');
    }
    if (buf.length < 80) {
      throw new Error('Arquivo de imagem muito pequeno ou corrompido.');
    }
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const fname = `${orderId}.${ext}`;
    fs.writeFileSync(path.join(PAYMENT_PROOFS_DIR, fname), buf);
    meta.hasImage = true;
    meta.imageFile = fname;
  }

  fs.writeFileSync(
    path.join(PAYMENT_PROOFS_DIR, `${orderId}.json`),
    JSON.stringify(meta, null, 2),
    'utf8'
  );
  return meta;
}
