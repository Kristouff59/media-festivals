// BACKSTAGE v2 — conversions pures, testables sans Supabase ni OpenAI.
import { buildStory, storyKey } from "../_shared/backstage/story.ts";
import { canonicalUrl } from "../_shared/backstage/text.ts";
import type { LeadKind } from "../_shared/backstage/verify.ts";

/** Créneau de découverte : 7 h et 18 h à Paris, été comme hiver. */
export function parisSlot(d: Date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return { id: day + (hour < 13 ? "-matin" : "-soir"), hour, isDiscoveryHour: hour === 7 || hour === 18 };
}

/**
 * Convertit la sortie JSON d'une découverte v18 (editorial_ai_logs.response_text)
 * en pistes v2. Permet de rejouer gratuitement de vraies découvertes.
 */
export function leadsFromV18Discovery(responseText: string) {
  let parsed: any;
  try {
    const t = String(responseText || "");
    parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    return [];
  }
  const items: any[] = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  return items.filter((c) => typeof c?.official_url === "string" && /^https:\/\//.test(c.official_url)).map((c) => {
    const year = String(c.topic ?? "").match(/\b20(2[6-9]|3\d)\b/);
    const kind: LeadKind = c.festival_name ? "lineup" : /tourn|tour/i.test(c.topic) ? "tour" : "other";
    return {
      channel: "openai", title: String(c.topic ?? "").slice(0, 300), why_now: c.why_now ?? null,
      official_url: c.official_url, event_name: c.festival_name || "", edition: year ? Number(year[0]) : null,
      kind, artists: Array.isArray(c.announced_artists) ? c.announced_artists : [], places: [],
      press_urls: c.press_url ? [c.press_url] : [], claimed_publication_date: null, priority: 50, listing_hint: null,
    };
  });
}

const KINDS = ["lineup", "tour", "concert", "cancellation", "industry", "other"];

/**
 * Zone couverte par BACKSTAGE (décision de la rédaction, 12 novembre 2026) :
 * la France, ses pays frontaliers et les Pays-Bas ; le Royaume-Uni seulement
 * pour les annonces importantes.
 */
export const CORE_COUNTRIES = ["FR", "BE", "LU", "DE", "CH", "IT", "ES", "AD", "MC", "NL"];
export const UK_MIN_PRIORITY = 75;
const COUNTRY_ALIASES: Record<string, string> = { UK: "GB", EN: "GB", ENG: "GB", SCO: "GB", WAL: "GB" };

export function normalizeCountries(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((c) => String(c ?? "").trim().toUpperCase()).map((c) => COUNTRY_ALIASES[c] ?? c)
    .filter((c) => /^[A-Z]{2}$/.test(c)))];
}

/** Vrai si la piste concerne la zone couverte. Sans pays connu, on laisse la vérification trancher. */
export function inZone(countries: unknown, priority = 50): boolean {
  const list = normalizeCountries(countries);
  if (!list.length) return true;
  if (list.some((c) => CORE_COUNTRIES.includes(c))) return true;
  return list.includes("GB") && priority >= UK_MIN_PRIORITY;
}

/**
 * Nettoie une piste avant insertion : une seule valeur hors des contraintes de la table
 * (ex. edition = 35 pour « 35 years ») faisait échouer TOUT le passage du 11 novembre.
 */
export function leadRow(l: any, slot: string, shadow: boolean) {
  const edition = Number.isInteger(l.edition) && l.edition >= 2020 && l.edition <= 2040 ? l.edition : null;
  const kind = KINDS.includes(l.kind) ? l.kind : "other";
  l = { ...l, edition, kind };
  const story = buildStory({ ...l, official_url: l.official_url });
  return {
    channel: l.channel ?? "openai", shadow, status: "new",
    title: String(l.title || "").slice(0, 300), why_now: l.why_now ?? null,
    official_url: l.official_url, canonical_url: canonicalUrl(l.official_url),
    event_name: l.event_name ? String(l.event_name).slice(0, 200) : null, edition,
    kind: l.kind ?? "other", artists: (l.artists ?? []).slice(0, 20), places: (l.places ?? []).slice(0, 20),
    countries: normalizeCountries(l.countries),
    press_urls: (l.press_urls ?? []).filter((u: string) => /^https:\/\//.test(u)).slice(0, 3),
    claimed_publication_date: /^\d{4}-\d{2}-\d{2}$/.test(l.claimed_publication_date ?? "") ? l.claimed_publication_date : null,
    listing_hint: l.listing_hint ?? null, priority: Math.max(0, Math.min(100, Math.round(Number(l.priority) || 50))),
    story_key: storyKey(story), discovered_slot: slot,
  };
}
