// BACKSTAGE v2 — preuves de date de publication.
// Chaque indice devient une preuve typée, pondérée et traçable.
// Une date de concert, de billetterie ou d'historique n'est jamais une
// date de publication : on l'écarte par sa position et par son contexte.
import type { ParsedPage } from "./html.ts";
import { htmlAttr, htmlToText, parseLinks } from "./html.ts";
import { findDates, parseDateValue } from "./dates.ts";
import { canonicalUrl, norm } from "./text.ts";

export type EvidenceType =
  | "jsonld" | "meta" | "time" | "sous_le_titre" | "marqueur_publication"
  | "url" | "sommaire_officiel" | "presse";

export interface DateEvidence {
  date: string;
  type: EvidenceType;
  url: string;
  confidence: number; // 0..1
  detail: string;
}

const PUBLISHED_KEYS = new Set([
  "article:published_time", "datepublished", "datecreated", "pubdate", "publishdate",
  "publish_date", "publication_date", "dc.date.issued", "dc.date", "dcterms.created",
  "citation_date", "sailthru.date", "parsely-pub-date", "og:published_time",
]);
const ARTICLE_TYPES = /article|posting|report|webpage|pressrelease/i;

// Mots qui, juste avant une date, signalent qu'elle ne date pas la publication.
const EVENT_CONTEXT = new RegExp(
  "(festival|concert|show|gig|tour|edition|editie|ausgabe|tickets?|billets?|billetterie|" +
  "ticketverkoop|vorverkauf|on sale|en vente|prevente|presale|doors|portes|" +
  "last appearance|derniere|since|depuis|until|jusqu|from|du|au|to|tot|van|vom|bis|" +
  "op|le|on|at|in)\\s*:?\\s*$",
);
const PUBLISH_MARKER = new RegExp(
  "(published|posted|updated|publie|mis en ligne|gepubliceerd|geplaatst|veroffentlicht|" +
  "publicado|pubblicato|date de publication|publication date)\\s*(on|le|op|am|el|il)?\\s*:?\\s*$",
);

function contextBefore(text: string, index: number, size = 32): string {
  return norm(text.slice(Math.max(0, index - size), index));
}

/** Indices de date contenus dans la page elle-même. */
export function pageEvidence(page: ParsedPage, now = Date.now()): DateEvidence[] {
  const out: DateEvidence[] = [];
  const url = page.url;

  for (const node of page.jsonld) {
    const type = String(node["@type"] ?? "");
    if (type && !ARTICLE_TYPES.test(type)) continue;
    for (const k of ["datePublished", "dateCreated", "uploadDate"]) {
      const d = parseDateValue(node[k], now);
      if (d) out.push({ date: d, type: "jsonld", url, confidence: 0.95, detail: `${type || "JSON-LD"}.${k}` });
    }
  }
  for (const m of page.meta) {
    if (!PUBLISHED_KEYS.has(m.key)) continue;
    const d = parseDateValue(m.content, now);
    if (d) out.push({ date: d, type: "meta", url, confidence: 0.9, detail: m.key });
  }

  // <time datetime> dans le contenu principal, avant le corps du texte.
  const head = page.mainHtml.slice(0, 20000);
  for (const m of head.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
    const d = parseDateValue(htmlAttr(m[1], "datetime") || htmlToText(m[2]), now);
    if (!d) continue;
    const marked = /published|pubdate|entry-date|post-date|publication/i.test(m[1]);
    const before = norm(htmlToText(head.slice(Math.max(0, m.index! - 200), m.index!)));
    if (!marked && EVENT_CONTEXT.test(before.slice(-32))) continue;
    out.push({ date: d, type: "time", url, confidence: marked ? 0.9 : 0.75, detail: "<time>" });
  }

  // Date isolée juste sous (ou juste au-dessus) du titre principal :
  // c'est ainsi que Rock Werchter, Graspop et beaucoup de sites datent leurs news.
  if (page.headlineIndex >= 0) {
    const afterStart = page.headlineIndex + page.headline.length;
    const after = page.text.slice(afterStart, afterStart + 260);
    const first = findDates(after, now)[0];
    if (first) {
      const lineStart = after.lastIndexOf("\n", first.index) + 1;
      const prefix = after.slice(lineStart, first.index);
      // La date ouvre sa ligne (ou suit seulement un jour / une catégorie courte).
      const opensLine = norm(prefix).split(" ").filter(Boolean).length <= 2;
      if (opensLine && !EVENT_CONTEXT.test(contextBefore(after, first.index))) {
        out.push({
          date: first.iso, type: "sous_le_titre", url,
          confidence: first.hasYear ? 0.8 : 0.65, detail: first.raw,
        });
      }
    }
    const beforeText = page.text.slice(Math.max(0, page.headlineIndex - 160), page.headlineIndex);
    const above = findDates(beforeText, now).pop();
    if (above && !EVENT_CONTEXT.test(contextBefore(beforeText, above.index)) &&
        beforeText.slice(above.index + above.raw.length).trim().length < 40) {
      out.push({ date: above.iso, type: "sous_le_titre", url, confidence: 0.6, detail: "au-dessus du titre : " + above.raw });
    }
  }

  // « Publié le 28 octobre 2026 », « Posted on October 28, 2026 », n'importe où.
  for (const d of findDates(page.text, now)) {
    if (PUBLISH_MARKER.test(contextBefore(page.text, d.index, 40))) {
      out.push({ date: d.iso, type: "marqueur_publication", url, confidence: 0.85, detail: d.raw });
    }
  }

  // /2026/10/28/ dans l'adresse
  const u = /\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//.exec(url);
  if (u) {
    const d = parseDateValue(`${u[1]}-${u[2].padStart(2, "0")}-${u[3].padStart(2, "0")}`);
    if (d) out.push({ date: d, type: "url", url, confidence: 0.6, detail: "adresse datée" });
  }
  // Une date future trouvée dans le TEXTE est une date d'événement, pas de publication.
  // Seules les métadonnées futures sont conservées (signal d'horloge ou d'embargo).
  const tomorrow = new Date(now + 86400000).toISOString().slice(0, 10);
  return out.filter((e) => e.date <= tomorrow || e.type === "jsonld" || e.type === "meta");
}

/**
 * Relie une date du sommaire officiel au communiqué EXACT :
 * on cherche le lien vers l'URL vérifiée (ou au titre identique), puis la date
 * de SA carte, c'est-à-dire entre le lien précédent et le suivant vers un autre article.
 */
export function listingEvidence(
  listingHtml: string, listingUrl: string, target: { url: string; title?: string }, now = Date.now(),
): DateEvidence | null {
  const links = parseLinks(listingHtml, listingUrl);
  const targetKey = canonicalUrl(target.url);
  const titleKey = norm(target.title);
  const hits = links.filter((l) => canonicalUrl(l.href) === targetKey ||
    (titleKey.length >= 15 && norm(l.text) === titleKey));
  if (!hits.length) return null;
  const isOther = (l: { href: string }) => canonicalUrl(l.href) !== targetKey &&
    /\/(news|nieuws|actualites?|actus?|press|presse|stories|story|article|blog)\//i.test(l.href);

  for (const hit of hits) {
    const prev = [...links].reverse().find((l) => l.end <= hit.index && isOther(l));
    const next = links.find((l) => l.index >= hit.end && isOther(l));
    // La carte du communiqué : de la fin du lien précédent au début du suivant.
    const start = prev ? prev.end : Math.max(0, hit.index - 1500);
    const end = next ? next.index : Math.min(listingHtml.length, hit.end + 1500);
    const card = listingHtml.slice(start, end);
    const anchor = hit.index - start;
    const candidates: { iso: string; pos: number }[] = [];
    for (const t of card.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
      const d = parseDateValue(htmlAttr(t[1], "datetime") || htmlToText(t[2]), now);
      if (d) candidates.push({ iso: d, pos: t.index! });
    }
    // Remplacer les balises par des espaces conserve les positions.
    const flat = card.replace(/<[^>]*>/g, (m) => " ".repeat(m.length));
    for (const f of findDates(flat, now)) {
      if (!EVENT_CONTEXT.test(contextBefore(flat, f.index))) candidates.push({ iso: f.iso, pos: f.index });
    }
    candidates.sort((a, b) => Math.abs(a.pos - anchor) - Math.abs(b.pos - anchor));
    if (candidates[0]) {
      return {
        date: candidates[0].iso, type: "sommaire_officiel", url: listingUrl, confidence: 0.85,
        detail: "date de la carte du communiqué dans le sommaire",
      };
    }
  }
  return null;
}

export type Freshness = "fresh" | "stale" | "future" | "unknown";
export interface PublicationDecision {
  date: string | null;
  evidence: DateEvidence | null;
  freshness: Freshness;
  ageDays: number | null;
  conflict: boolean;
  all: DateEvidence[];
}

/**
 * Choisit la meilleure preuve. Les dates postérieures à aujourd'hui sont
 * écartées (ce sont des dates d'événement) ; une page datée à la fois par ses
 * métadonnées et sous son titre est plus sûre que l'un ou l'autre seul.
 */
export function decidePublication(
  evidence: DateEvidence[], now = Date.now(), maxAgeDays = 10,
): PublicationDecision {
  const today = new Date(now).toISOString().slice(0, 10);
  const tomorrow = new Date(now + 86400000).toISOString().slice(0, 10);
  const usable = evidence.filter((e) => e.date <= tomorrow);
  if (!usable.length) {
    return { date: null, evidence: null, freshness: evidence.length ? "future" : "unknown", ageDays: null, conflict: false, all: evidence };
  }
  // Agréger la confiance par date : plusieurs indices concordants se renforcent.
  const score = new Map<string, number>();
  for (const e of usable) score.set(e.date, 1 - (1 - (score.get(e.date) ?? 0)) * (1 - e.confidence));
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  const [date] = ranked[0];
  const best = usable.filter((e) => e.date === date).sort((a, b) => b.confidence - a.confidence)[0];
  const conflict = ranked.length > 1 && ranked[1][1] >= 0.75 &&
    Math.abs(Date.parse(ranked[1][0]) - Date.parse(date)) > 2 * 86400000;
  const ageDays = Math.floor((Date.parse(today) - Date.parse(date)) / 86400000);
  return {
    date, evidence: best, conflict, ageDays, all: evidence,
    freshness: ageDays < -1 ? "future" : ageDays > maxAgeDays ? "stale" : "fresh",
  };
}
