// BACKSTAGE v2 — identité des récits et détection des doublons.
// Un `topic_key` inventé par le modèle n'identifie rien. Un récit est défini
// par des faits : événement, édition, type d'annonce, ensemble d'artistes.
import { canonicalUrl, containsName, norm } from "./text.ts";
import { eventTokens, type LeadKind } from "./verify.ts";

export interface Story {
  event: string; // nom d'événement normalisé (ou "" pour une tournée)
  edition: number | null;
  kind: LeadKind;
  artists: string[]; // clés d'artistes normalisées, triées
  places: string[]; // villes / pays pour les tournées
  official_url: string;
}

export interface KnownArticle {
  id?: string;
  title: string;
  excerpt?: string;
  status?: string;
  created_at?: string;
  story?: Story | null; // présent pour les articles produits par la v2
  source_urls?: string[];
}

export type StoryVerdict =
  | { verdict: "new" }
  | { verdict: "duplicate"; of: KnownArticle; reason: string }
  | { verdict: "update"; of: KnownArticle; new_artists: string[]; new_places: string[] };

export const artistKey = (a: string) => norm(a).replace(/^the /, "");

/**
 * Les artistes qui FONT l'annonce. Une découverte liste parfois toute l'affiche
 * citée sur la page ; seuls ceux nommés dans le titre de la piste comptent alors.
 */
export function keyArtists(title: string | undefined, artists: string[] = []): string[] {
  if (!title) return artists;
  const named = artists.filter((a) => containsName(title, a));
  return named.length ? named : artists;
}

export function buildStory(input: {
  title?: string; event_name?: string; edition?: number | null; kind?: LeadKind;
  artists?: string[]; places?: string[]; official_url: string;
}): Story {
  return {
    event: eventTokens(input.event_name ?? "").join(" "),
    edition: input.edition ?? null,
    kind: input.kind ?? "other",
    artists: [...new Set(keyArtists(input.title, input.artists ?? []).map(artistKey).filter(Boolean))].sort(),
    places: [...new Set((input.places ?? []).map(norm).filter(Boolean))].sort(),
    official_url: input.official_url,
  };
}

/** Clé stable, utilisable comme identifiant en base. */
export function storyKey(s: Story): string {
  return [s.event || "-", s.edition ?? "-", s.kind, s.artists.join("+") || "-"].join("|").slice(0, 300);
}

function sameEvent(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ta = a.split(" "), tb = b.split(" ");
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => large.includes(t));
}

const GENERIC = new Set(["metal", "music", "musique", "meeting", "sound", "sounds", "summer",
  "winter", "night", "nights", "rocks", "festivals", "musik", "muziek", "world", "days"]);

function yearsIn(s: string): number[] {
  return [...String(s).matchAll(/\b(20[2-3]\d)\b/g)].map((m) => +m[1]);
}

/**
 * Reconstitue ce qu'un ancien article couvre, à partir de son texte, en
 * cherchant les noms du candidat. Sert pour les articles antérieurs à la v2.
 */
function legacyCoverage(old: KnownArticle, cand: Story, candArtists: string[], candEventName: string) {
  const text = old.title + " " + (old.excerpt ?? "");
  // « Graspop » suffit pour « Graspop Metal Meeting » : un mot distinctif.
  const tokens = eventTokens(candEventName);
  const distinctive = tokens.filter((t) => t.length >= 5 && !GENERIC.has(t));
  const event = !!candEventName && (tokens.every((t) => containsName(text, t)) ||
    (distinctive.length > 0 && distinctive.some((t) => containsName(text, t))));
  const years = yearsIn(old.title + " " + (old.excerpt ?? ""));
  let edition: number | null = years.find((y) => y === cand.edition) ?? (years.length ? years[0] : null);
  if (edition === null && old.created_at && cand.edition) {
    // Sans année écrite, un article de moins de 9 mois vise la prochaine édition.
    const ageMonths = (Date.now() - Date.parse(old.created_at)) / (30 * 86400000);
    if (ageMonths < 9) edition = cand.edition;
  }
  const artists = candArtists.filter((a) => containsName(text, a)).map(artistKey);
  return { event, edition, artists };
}

export function classifyStory(
  cand: Story, known: KnownArticle[],
  raw: { event_name?: string; artists?: string[] } = {},
): StoryVerdict {
  const candUrl = canonicalUrl(cand.official_url);
  let bestUpdate: StoryVerdict | null = null;

  for (const old of known) {
    if (old.status === "rejected" && !old.story) continue; // un refus n'est pas une couverture
    let event: boolean, edition: number | null, artists: string[], places: string[] = [];
    if (old.story) {
      event = sameEvent(old.story.event, cand.event);
      edition = old.story.edition;
      artists = old.story.artists;
      places = old.story.places;
    } else {
      const c = legacyCoverage(old, cand, cand.artists.length ? (raw.artists ?? []).filter((a) =>
        cand.artists.includes(artistKey(a))) : [], raw.event_name ?? "");
      event = c.event; edition = c.edition; artists = c.artists;
    }
    const sameUrl = !!candUrl && (old.source_urls ?? []).some((u) => canonicalUrl(u) === candUrl);
    const sameEdition = cand.edition === null || edition === null || cand.edition === edition;
    const overlap = cand.artists.filter((a) => artists.includes(a));
    const newArtists = cand.artists.filter((a) => !artists.includes(a));

    // 1. Même communiqué officiel avec au moins un artiste en commun.
    if (sameUrl && overlap.length && !newArtists.length) {
      return { verdict: "duplicate", of: old, reason: "meme_communique" };
    }
    // 2. Même événement, même édition.
    if (cand.event && event && sameEdition) {
      if (cand.artists.length && !newArtists.length) {
        return { verdict: "duplicate", of: old, reason: "memes_artistes_meme_edition" };
      }
      if (!cand.artists.length && old.story?.kind === cand.kind && cand.kind !== "lineup") {
        return { verdict: "duplicate", of: old, reason: "meme_annonce_evenement" };
      }
      if (overlap.length && newArtists.length) {
        bestUpdate ??= { verdict: "update", of: old, new_artists: newArtists, new_places: [] };
      }
      continue;
    }
    // 3. Tournée ou concert : mêmes artistes, même année.
    if (!cand.event && cand.artists.length && overlap.length === cand.artists.length &&
        (cand.kind === "tour" || cand.kind === "concert" || cand.kind === "cancellation") &&
        (!old.story || old.story.kind === cand.kind) && sameEdition) {
      const newPlaces = cand.places.filter((p) => !places.includes(p));
      if (newPlaces.length && places.length) {
        bestUpdate ??= { verdict: "update", of: old, new_artists: [], new_places: newPlaces };
        continue;
      }
      return { verdict: "duplicate", of: old, reason: "meme_tournee" };
    }
  }
  return bestUpdate ?? { verdict: "new" };
}
