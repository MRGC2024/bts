/** Idade completa na data atual (UTC) a partir de AAAA-MM-DD */

export function ageFromBirthDate(isoDateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDateStr || ''))) return null;
  const [y, m, d] = isoDateStr.split('-').map(Number);
  const b = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const md = now.getUTCMonth() - b.getUTCMonth();
  if (md < 0 || (md === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

/**
 * Para quantity > 1: exige array attendees com mesmo length, nome, CPF 11 dígitos, nascimento, 16+ anos.
 */
export function normalizeAttendees(quantity, body) {
  const q = Math.max(1, Number(quantity) || 1);
  if (q <= 1) return { ok: true, attendees: null };

  const raw = body?.attendees;
  if (!Array.isArray(raw) || raw.length !== q) {
    return {
      ok: false,
      error: `Para ${q} ingressos, preencha nome completo, CPF e data de nascimento de cada titular.`,
    };
  }

  const seen = new Set();
  const out = [];

  for (let i = 0; i < q; i++) {
    const a = raw[i] || {};
    const fullName = String(a.fullName || a.name || '').trim();
    const document = String(a.document || a.cpf || '').replace(/\D/g, '');
    const birthDate = String(a.birthDate || '').trim();

    if (fullName.length < 3) {
      return { ok: false, error: `Nome completo inválido (titular ${i + 1}).` };
    }
    if (document.length !== 11) {
      return { ok: false, error: `CPF inválido no titular ${i + 1} (11 dígitos).` };
    }
    if (seen.has(document)) {
      return { ok: false, error: 'Cada ingresso deve ter um CPF diferente.' };
    }
    seen.add(document);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      return {
        ok: false,
        error: `Data de nascimento inválida (titular ${i + 1}). Use AAAA-MM-DD.`,
      };
    }

    const age = ageFromBirthDate(birthDate);
    if (age === null || age < 16) {
      return {
        ok: false,
        error: `Cada titular deve ter no mínimo 16 anos (titular ${i + 1}).`,
      };
    }

    out.push({ fullName, document, birthDate });
  }

  return { ok: true, attendees: out };
}
