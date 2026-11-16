// BACKSTAGE v2 — relecture automatique d'un article.
// Les ERREURS bloquent (structure inutilisable). Les ALERTES n'empêchent pas
// la proposition : elles sont affichées dans l'admin pour la relecture humaine.
// C'est l'inverse de la v18, qui jetait l'article pour une année non retrouvée.
import { norm, wordCount } from "./text.ts";

export type ArticleFormat = "breve" | "actualite" | "dossier";
export interface DraftArticle {
  title: string;
  excerpt: string;
  category: string;
  format?: ArticleFormat;
  body: string[];
  sections: { title: string; paragraphs: string[] }[];
}
export interface QualityReport { errors: string[]; warnings: string[]; words: number }

export const FORMAT_WORDS: Record<ArticleFormat, [number, number]> = {
  breve: [180, 500],
  actualite: [450, 1100],
  dossier: [900, 2500],
};

// Formules signalées par la rédaction (PR #21, #22) et quelques autres.
const CLICHES = [
  "donne le ton", "rendez-vous incontournable", "s annonce riche", "au coeur de",
  "une chose est sure", "de quoi ravir", "reste a voir", "plus que jamais",
  "promet une", "promet un", "un evenement a ne pas manquer", "les fans n ont qu a bien se tenir",
  "affiche allechante", "nul doute",
  "sans plus attendre", "en effet", "il convient de", "force est de constater",
  "vibrer", "electrisant", "explosif", "mythique", "incontournable",
];

export function lintArticle(a: DraftArticle, sourceTexts: string[]): QualityReport {
  const errors: string[] = [], warnings: string[] = [];
  if (!a || typeof a.title !== "string" || a.title.trim().length < 15) errors.push("titre_absent");
  if (typeof a?.excerpt !== "string" || a.excerpt.trim().length < 40) errors.push("chapo_absent");
  if (!["FESTIVALS", "CONCERTS", "SOCIÉTÉ"].includes(a?.category)) errors.push("categorie_inconnue");
  const body = Array.isArray(a?.body) ? a.body.filter((p) => typeof p === "string" && p.trim()) : [];
  const sections = Array.isArray(a?.sections) ? a.sections.filter((s) =>
    s && typeof s.title === "string" && Array.isArray(s.paragraphs)) : [];
  const paragraphs = [...body, ...sections.flatMap((s) => s.paragraphs.filter((p) => typeof p === "string"))];
  const prose = paragraphs.join("\n");
  const words = wordCount(prose);
  if (!body.length) errors.push("corps_absent");
  if (words < 150) errors.push("article_trop_court");
  if (words > 2600) errors.push("article_trop_long");
  if (errors.length) return { errors, warnings, words };

  const [min, max] = FORMAT_WORDS[a.format ?? "breve"] ?? FORMAT_WORDS.breve;
  if (words < min) warnings.push(`plus_court_que_le_format (${words} mots)`);
  if (words > max) warnings.push(`plus_long_que_le_format (${words} mots)`);
  if (a.title.length > 120) warnings.push("titre_long");
  if (norm(a.excerpt).startsWith(norm(a.title).slice(0, 40))) warnings.push("chapo_repete_le_titre");

  const all = norm(a.title + " " + a.excerpt + " " + prose);
  for (const c of CLICHES) if ((" " + all + " ").includes(" " + norm(c) + " ")) warnings.push("cliche: " + c);

  const sources = sourceTexts.join("\n");
  const unsupportedYears = [...new Set((a.title + " " + prose).match(/\b(19|20)\d{2}\b/g) ?? [])]
    .filter((y) => !sources.includes(y));
  if (unsupportedYears.length) warnings.push("annees_non_sourcees: " + unsupportedYears.join(", "));
  const numbers = [...new Set(prose.match(/\b\d{1,3}(?:[ . ]\d{3})+\b|\b\d{4,}\b/g) ?? [])]
    .filter((n) => !/^(19|20)\d{2}$/.test(n) && !sources.replace(/[ . ]/g, "").includes(n.replace(/[ . ]/g, "")));
  if (numbers.length) warnings.push("chiffres_non_sources: " + numbers.slice(0, 5).join(", "));
  if (/« [^»]{10,} »/.test(prose) && !/« [^»]{10,} »/.test(sources) && !/"[^"]{10,}"/.test(sources)) {
    warnings.push("citation_a_verifier");
  }
  const last = paragraphs[paragraphs.length - 1] ?? "";
  if (/\b(reste|restera|a suivre|à suivre|rendez-vous|l'avenir dira)\b/i.test(last)) warnings.push("conclusion_formule");
  return { errors, warnings, words };
}
