// BACKSTAGE v2 — utilitaires de texte partagés (Deno et Node).

/** Minuscules, sans accents, ponctuation remplacée par des espaces. */
export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[̀-ͯ]/g, "")
    .replace(/[øØ]/g, "o")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Vrai si `name` apparaît comme suite de mots entière dans `text` (normalisés). */
export function containsName(text: string, name: string): boolean {
  const n = norm(name);
  if (!n) return false;
  return (" " + norm(text) + " ").includes(" " + n + " ");
}

export function slugify(s: string, max = 62): string {
  return norm(s).replace(/ /g, "-").slice(0, max).replace(/-+$/, "");
}

export function wordCount(s: string): number {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
  auml: "ä", ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö",
  ugrave: "ù", ucirc: "û", uuml: "ü", oslash: "ø", aring: "å", ntilde: "ñ",
  szlig: "ß", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–",
  mdash: "—", hellip: "…", laquo: "«", raquo: "»", middot: "·", bull: "•",
  Eacute: "É", Agrave: "À", Ccedil: "Ç", Ouml: "Ö", Uuml: "Ü", Auml: "Ä",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return NAMED[code] ?? NAMED[code.toLowerCase()] ?? m;
  });
}

/** Hôte + chemin sans www ni barre finale, pour comparer deux URL. */
export function canonicalUrl(raw: unknown): string {
  try {
    const u = new URL(String(raw ?? ""));
    if (!/^https?:$/.test(u.protocol)) return "";
    return (u.hostname.toLowerCase().replace(/^www\./, "") +
      decodeURIComponent(u.pathname).replace(/\/+$/, "")).toLowerCase();
  } catch {
    return "";
  }
}
