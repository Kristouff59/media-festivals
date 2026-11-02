// BACKSTAGE v2 — repérage de dates écrites dans le texte, en plusieurs langues.
// Ce module ne décide JAMAIS si une date est une date de publication :
// il se contente de trouver les dates et leur position. evidence.ts juge.
import { norm } from "./text.ts";

const MONTHS: Record<string, number> = {};
const add = (n: number, ...names: string[]) => names.forEach((x) => (MONTHS[x] = n));
add(1, "jan", "janv", "january", "janvier", "januari", "januar", "enero", "gennaio", "jänner");
add(2, "feb", "fev", "fevr", "february", "fevrier", "februari", "februar", "febrero", "febbraio");
add(3, "mar", "mars", "march", "maart", "marz", "maerz", "marzo", "mrt");
add(4, "apr", "avr", "april", "avril", "abril", "aprile");
add(5, "may", "mai", "mei", "mayo", "maggio");
add(6, "jun", "juin", "june", "juni", "junio", "giugno");
add(7, "jul", "juil", "juillet", "july", "juli", "julio", "luglio");
add(8, "aug", "aou", "aout", "august", "augustus", "agosto");
add(9, "sep", "sept", "september", "septembre", "septiembre", "settembre");
add(10, "oct", "okt", "october", "octobre", "oktober", "octubre", "ottobre");
add(11, "nov", "november", "novembre", "noviembre");
add(12, "dec", "dez", "december", "decembre", "dezember", "diciembre", "dicembre");

const MONTH_WORD = "[A-Za-zÀ-ÿ]{3,10}\\.?";

export interface FoundDate {
  iso: string; // AAAA-MM-JJ
  index: number; // position dans le texte analysé
  raw: string;
  hasYear: boolean;
}

function valid(y: number, m: number, d: number): string | null {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function monthOf(word: string): number | null {
  const w = norm(word).replace(/\s/g, "");
  if (MONTHS[w]) return MONTHS[w];
  // Abréviation : « sept », « déc », « juil » — jamais « mardi » pris pour « mar(s) ».
  if (w.length < 3) return null;
  const full = Object.keys(MONTHS).find((k) => k.length >= 5 && k.startsWith(w));
  return full ? MONTHS[full] : null;
}

/**
 * Trouve toutes les dates du texte. Sans année, la date est rattachée à
 * l'année de `now` (ou à la précédente si elle tomberait dans le futur).
 */
export function findDates(text: string, now = Date.now()): FoundDate[] {
  const out: FoundDate[] = [];
  const seen = new Set<number>();
  const push = (index: number, raw: string, iso: string | null, hasYear: boolean) => {
    if (!iso || seen.has(index)) return;
    seen.add(index);
    out.push({ iso, index, raw, hasYear });
  };
  const yearNow = new Date(now).getUTCFullYear();
  const guessYear = (m: number, d: number) => {
    const iso = valid(yearNow, m, d);
    if (iso && Date.parse(iso) > now + 2 * 86400000) return yearNow - 1;
    return yearNow;
  };

  // 2026-10-28 ou 2026-10-28T10:00
  for (const m of text.matchAll(/\b(20\d{2}|19\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    push(m.index!, m[0], valid(+m[1], +m[2], +m[3]), true);
  }
  // 28/10/2026, 28.10.2026, 28-10-2026 (ordre européen)
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g)) {
    push(m.index!, m[0], valid(+m[3], +m[2], +m[1]), true);
  }
  // 28 October 2026, 28. Oktober 2026, mardi 28 oct. 2026, 28 oct
  const dmy = new RegExp("\\b(\\d{1,2})(?:er|st|nd|rd|th|e)?\\.?\\s+(" + MONTH_WORD + ")(?:,?\\s+(\\d{4}))?(?![\\w])", "g");
  for (const m of text.matchAll(dmy)) {
    const mo = monthOf(m[2]);
    if (!mo) continue;
    const y = m[3] ? +m[3] : guessYear(mo, +m[1]);
    push(m.index!, m[0], valid(y, mo, +m[1]), !!m[3]);
  }
  // October 28, 2026 / Oct 28
  const mdy = new RegExp("\\b(" + MONTH_WORD + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b", "g");
  for (const m of text.matchAll(mdy)) {
    const mo = monthOf(m[1]);
    if (!mo) continue;
    // Éviter « July 2027 » interprété comme « July 20 ».
    if (!m[3] && /^\d{1,2}$/.test(m[2]) && /^\s*\d{2}/.test(text.slice(m.index! + m[0].length))) continue;
    const y = m[3] ? +m[3] : guessYear(mo, +m[2]);
    push(m.index!, m[0], valid(y, mo, +m[2]), !!m[3]);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Interprète une valeur de métadonnée (ISO, RFC 2822, « 28 October 2026 »...). */
export function parseDateValue(value: unknown, now = Date.now()): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return valid(+iso[1], +iso[2], +iso[3]);
  const found = findDates(s, now);
  if (found.length && found[0].hasYear) return found[0].iso;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export function daysBetween(isoA: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(isoA + "T00:00:00Z")) / 86400000);
}
