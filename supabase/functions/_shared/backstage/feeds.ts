// BACKSTAGE v2 — veille gratuite par les fils RSS / Atom que les médias publient eux-mêmes.
// Le serveur lit les fils, garde les titres récents et utiles ; l'IA ne fait ensuite qu'un tri,
// sans recherche Web. Les fils de Google Actualités / Bing ne sont PAS utilisés : leurs conditions
// les réservent à un usage personnel non commercial.
import { decodeEntities, norm } from "./text.ts";

export interface Feed { url: string; name: string; country: string; general?: boolean }
export interface FeedItem { title: string; url: string; date: string; source: string; country: string; summary: string }

// Fils testés depuis Supabase le 12 novembre 2026 (tous répondaient avec des actualités du jour ou de la semaine).
export const FEEDS: Feed[] = [
  { url: "https://www.francetvinfo.fr/culture/musique.rss", name: "franceinfo Musique", country: "FR" },
  { url: "https://www.lemonde.fr/musiques/rss_full.xml", name: "Le Monde Musiques", country: "FR" },
  { url: "https://www.liberation.fr/arc/outboundfeeds/rss/category/culture/musique/?outputType=xml", name: "Libération Musique", country: "FR" },
  { url: "https://www.lesinrocks.com/feed/", name: "Les Inrocks", country: "FR" },
  { url: "https://www.rollingstone.fr/feed/", name: "Rolling Stone France", country: "FR" },
  { url: "https://www.tsugi.fr/feed/", name: "Tsugi", country: "FR" },
  { url: "https://www.hardforce.fr/feed/", name: "Hard Force", country: "FR" },
  { url: "https://www.metalzone.fr/feed/", name: "Metalzone", country: "FR" },
  { url: "https://www.rockurlife.net/feed/", name: "RockUrLife", country: "FR" },
  { url: "https://www.20minutes.fr/feeds/rss-culture.xml", name: "20 Minutes Culture", country: "FR", general: true },
  { url: "https://www.sortiraparis.com/rss/actualites", name: "Sortir à Paris", country: "FR", general: true },
  { url: "https://www.lalibre.be/arc/outboundfeeds/rss/section/culture/musique/?outputType=xml", name: "La Libre Musique", country: "BE" },
  { url: "https://www.rts.ch/info/culture/musiques/?format=rss/news", name: "RTS Musiques", country: "CH" },
  { url: "https://www.musikexpress.de/feed/", name: "Musikexpress", country: "DE" },
  { url: "https://www.festivalfans.nl/feed/", name: "FestivalFans", country: "NL" },
  { url: "https://www.nme.com/news/music/feed", name: "NME", country: "GB" },
  { url: "https://www.loudersound.com/feeds/all", name: "Louder", country: "GB" },
];

// Pour les fils généralistes : on ne garde que ce qui parle de musique live.
const LIVE = /festival|concert|tourn[eé]e|\btour\b|sc[eè]ne|line-?up|affiche|programmation|annul|report|billetterie|t[eê]te d'affiche|olympia|z[eé]nith|bercy|stade de france|accor arena/i;

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = new RegExp("<" + n + "\\b[^>]*>([\\s\\S]*?)</" + n + ">", "i").exec(block);
    if (m) return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  }
  return "";
}
const clean = (s: string) => decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parseFeed(xml: string, feed: Feed): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = clean(tag(b, ["title"]));
    let url = clean(tag(b, ["link"]));
    if (!/^https?:\/\//.test(url)) {
      const href = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) ??
        /<link\b[^>]*href=["']([^"']+)["']/i.exec(b);
      url = href ? decodeEntities(href[1]) : "";
    }
    if (!/^https?:\/\//.test(url)) {
      const guid = clean(tag(b, ["guid"]));
      if (/^https?:\/\//.test(guid)) url = guid;
    }
    const t = Date.parse(clean(tag(b, ["pubDate", "published", "dc:date", "updated"])));
    if (!title || !url || !Number.isFinite(t)) continue;
    out.push({ title: title.slice(0, 220), url: url.replace(/^http:/, "https:"), date: new Date(t).toISOString(),
      source: feed.name, country: feed.country,
      summary: clean(tag(b, ["description", "summary", "content:encoded", "content"])).slice(0, 240) });
  }
  return out;
}

// Garde les titres récents, utiles, et pas déjà vus ; fusionne les reprises d'un même titre.
export function selectFeedItems(items: FeedItem[], opts: {
  now: number; maxAgeHours: number; seenUrls: Set<string>; generalSources: Set<string>; max: number; priorityNames?: string[];
}): FeedItem[] {
  const seenTitles = new Set<string>();
  const fresh = items.filter((it) => {
    const age = (opts.now - Date.parse(it.date)) / 3600000;
    if (age < -24 || age > opts.maxAgeHours) return false;
    if (opts.seenUrls.has(it.url)) return false;
    if (opts.generalSources.has(it.source) && !LIVE.test(it.title + " " + it.summary)) return false;
    const k = norm(it.title).slice(0, 80);
    if (seenTitles.has(k)) return false;
    seenTitles.add(k);
    return true;
  });
  // Les grands festivals suivis passent devant, puis le plus récent d'abord.
  const watched = (it: FeedItem) => (opts.priorityNames ?? []).some((n) => norm(it.title + " " + it.summary).includes(norm(n))) ? 1 : 0;
  return fresh.sort((a, b) => watched(b) - watched(a) || b.date.localeCompare(a.date)).slice(0, opts.max);
}
