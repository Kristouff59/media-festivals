// CSV : séparateur « ; » (compatible tableurs francophones), échappement RFC 4180.
export function toCsv(rows, sep = ';') {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(esc).join(sep)).join('\r\n')}\r\n`;
}

export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/**
 * Lignes d'import de participants. En-tête reconnu (insensible à la casse) :
 * nom | equipe ; joueur1..joueurN | joueurs (séparés par « / ») ; tete_de_serie ; email ; telephone.
 * Sans en-tête : 1re colonne = nom, colonnes suivantes = joueurs.
 */
export function participantsFromCsv(text, { mode = 'team', teamSize = 2 } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const head = rows[0].map(norm);
  const hasHeader = head.some((h) => ['nom', 'equipe', 'name', 'team', 'joueur1', 'joueurs'].includes(h));
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const out = [];
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const get = (i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    let name; let players = []; let seed = null; let email = ''; let phone = '';
    if (hasHeader) {
      name = get(idx(['nom', 'equipe', 'name', 'team']));
      const joined = get(idx(['joueurs', 'players']));
      if (joined) players = joined.split('/').map((x) => x.trim()).filter(Boolean);
      else for (let k = 1; k <= 20; k++) { const i = idx([`joueur${k}`, `player${k}`]); if (i >= 0 && get(i)) players.push(get(i)); }
      const sd = get(idx(['tetedeserie', 'seed', 'tds']));
      seed = sd && /^\d+$/.test(sd) ? Number(sd) : null;
      email = get(idx(['email', 'mail', 'courriel']));
      phone = get(idx(['telephone', 'tel', 'phone']));
    } else {
      name = get(0);
      players = r.slice(1, 1 + teamSize).map((x) => String(x).trim()).filter(Boolean);
    }
    if (!name) continue;
    out.push({ name, players: mode === 'team' ? players : [], seed, contact: { email, phone } });
  }
  return out;
}
