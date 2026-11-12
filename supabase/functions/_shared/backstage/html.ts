// BACKSTAGE v2 — lecture structurée d'une page HTML, sans dépendance externe.
// L'objectif n'est pas un parseur complet mais une extraction robuste des
// éléments utiles à la vérification : titre, contenu principal, métadonnées,
// JSON-LD et liens, quelle que soit la taille de la page.
import { decodeEntities } from "./text.ts";

export interface MetaTag { key: string; content: string }
export interface PageLink { href: string; text: string; index: number; end: number }
export interface ParsedPage {
  url: string;
  title: string;
  headline: string;
  meta: MetaTag[];
  jsonld: Record<string, unknown>[];
  /** Texte de la page avec une ligne par bloc (titres, paragraphes, éléments). */
  text: string;
  /** Texte du contenu principal (article, main) si identifiable, sinon `text`. */
  main: string;
  /** Position du titre principal dans `text`, ou -1. */
  headlineIndex: number;
  /** Fragment HTML du contenu principal (pour les balises <time>). */
  mainHtml: string;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return decodeEntities(m ? (m[2] ?? m[3] ?? m[4] ?? "") : "").trim();
}
export { attr as htmlAttr };

const BLOCK = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|br|tr|td|th|table|time|figure|figcaption|blockquote|dd|dt)\b[^>]*>/gi;

/** Texte lisible, un bloc par ligne. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      // Page tronquée au milieu d'un script : ne pas transformer le code en texte.
      .replace(/<(script|style)\b[^>]*>(?![\s\S]*<\/\1>)[\s\S]*$/i, " ")
      .replace(BLOCK, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

function firstBlock(html: string, tag: string): string | null {
  const open = new RegExp("<" + tag + "\\b[^>]*>", "i").exec(html);
  if (!open) return null;
  // Prendre la DERNIÈRE fermeture pour englober les blocs imbriqués du même nom.
  const close = html.toLowerCase().lastIndexOf("</" + tag + ">");
  if (close <= open.index) return null;
  return html.slice(open.index, close + tag.length + 3);
}

/** Retire les zones qui ne sont jamais le contenu d'un communiqué. */
function withoutChrome(html: string): string {
  return html
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<header\b[^>]*>(?:(?!<h1\b)[\s\S])*?<\/header>/gi, " ");
}

export function parseJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const stack: unknown[] = [parsed];
      while (stack.length) {
        const item = stack.pop();
        if (Array.isArray(item)) stack.push(...item);
        else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          out.push(obj);
          if (obj["@graph"]) stack.push(obj["@graph"]);
          if (obj.mainEntity && typeof obj.mainEntity === "object") stack.push(obj.mainEntity);
        }
      }
    } catch { /* JSON-LD invalide : ignoré, d'autres indices existent */ }
  }
  return out;
}

export function parseMeta(html: string): MetaTag[] {
  const out: MetaTag[] = [];
  const head = html.slice(0, 400_000);
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
    const content = attr(tag, "content") || attr(tag, "datetime");
    if (key && content) out.push({ key, content });
  }
  return out;
}

export function parseLinks(html: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = attr(" " + m[1], "href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      out.push({
        href: new URL(href, base).toString(),
        text: htmlToText(m[2]).replace(/\n/g, " ").trim(),
        index: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
      });
    } catch { /* lien invalide */ }
  }
  return out;
}

export function parsePage(html: string, url: string): ParsedPage {
  const meta = parseMeta(html);
  const jsonld = parseJsonLd(html);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const headline = h1 ? htmlToText(h1[1]).replace(/\n/g, " ").trim() : "";
  const ogTitle = meta.find((m) => m.key === "og:title")?.content || "";
  const title = headline || ogTitle ||
    (titleTag ? htmlToText(titleTag[1]).replace(/\s*[|–—-]\s*[^|–—-]+$/, "").trim() : "");

  // Une page tronquée n'a plus de </body> : partir de <body> jusqu'à la fin.
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const body = firstBlock(html, "body") ??
    (bodyOpen ? html.slice(bodyOpen.index) : html.replace(/<head\b[\s\S]*?<\/head>/i, " "));
  const mainHtml = firstBlock(body, "article") ?? firstBlock(body, "main") ?? withoutChrome(body);
  const text = htmlToText(body);
  const main = htmlToText(mainHtml) || text;
  const headlineIndex = headline ? text.indexOf(headline) : -1;
  return { url, title, headline, meta, jsonld, text, main, headlineIndex, mainHtml };
}
