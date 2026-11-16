// BACKSTAGE v2 — vérification complète d'une piste.
// Le modèle propose ; seul le serveur prouve. Rien ici ne fait confiance à une
// affirmation d'OpenAI : la date et les faits viennent des pages téléchargées.
import type { FetchedPage } from "./fetch.ts";
import { isPublicHttpsUrl } from "./fetch.ts";
import { parsePage, type ParsedPage } from "./html.ts";
import { decidePublication, listingEvidence, pageEvidence, type DateEvidence } from "./evidence.ts";
import { canonicalUrl, containsName, norm } from "./text.ts";

export type LeadKind = "lineup" | "tour" | "concert" | "cancellation" | "industry" | "other";
export interface Lead {
  official_url: string;
  title?: string;
  event_name?: string;
  edition?: number | null;
  artists?: string[];
  kind?: LeadKind;
  press_urls?: string[];
  claimed_publication_date?: string | null;
  /** Date déjà relevée par le canal officiel (sommaire lu par le serveur). */
  listing_hint?: { date: string; url: string } | null;
}

export type VerificationStatus = "verified" | "needs_review" | "rejected" | "retry";
export interface VerificationRecord {
  official_url: string;
  final_url: string;
  page_title: string;
  publication_date: string | null;
  date_evidence_url: string | null;
  date_evidence_type: string | null;
  date_confidence: number | null;
  verification_status: VerificationStatus;
  rejection_reason: string | null;
  corroborating_sources: { url: string; date: string | null; artists: string[] }[];
  checks: {
    event_found: boolean | null;
    edition_found: boolean | null;
    artists_found: string[];
    artists_missing: string[];
    truncated: boolean;
    redirects: string[];
    date_conflict: boolean;
    claimed_date: string | null;
    claimed_date_matches: boolean | null;
  };
  evidence: DateEvidence[];
  /** Texte du contenu principal, transmis à la rédaction (jamais publié tel quel). */
  source_text: string;
  checked_at: string;
}

export interface VerifyDeps {
  fetchPage: (url: string) => Promise<FetchedPage>;
  /** Sommaires d'actualités à consulter pour cette URL (registre + déduction). */
  listingUrlsFor?: (url: string) => string[];
  now?: number;
  maxAgeDays?: number;
}

const STOP = new Set(["festival", "fest", "the", "le", "la", "les", "de", "du", "des", "of", "and", "et", "open", "air", "edition", "editie"]);
export function eventTokens(name: string): string[] {
  return norm(name).split(" ").filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}
function eventInText(text: string, name: string): boolean {
  if (containsName(text, name)) return true;
  const tokens = eventTokens(name);
  return tokens.length > 0 && tokens.every((t) => containsName(text, t));
}

/** Sommaire déduit de l'adresse : /en/news/mon-article → /en/news */
export function inferredListingUrls(url: string): string[] {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const out: string[] = [];
    for (let i = parts.length - 1; i >= 1 && out.length < 2; i--) {
      out.push(u.origin + "/" + parts.slice(0, i).join("/"));
    }
    return out;
  } catch {
    return [];
  }
}

export async function verifyLead(lead: Lead, deps: VerifyDeps): Promise<VerificationRecord> {
  const now = deps.now ?? Date.now();
  const maxAgeDays = deps.maxAgeDays ?? 10;
  const artists = (lead.artists ?? []).filter((a) => typeof a === "string" && norm(a).length >= 2).slice(0, 20);
  const record: VerificationRecord = {
    official_url: lead.official_url, final_url: lead.official_url, page_title: "",
    publication_date: null, date_evidence_url: null, date_evidence_type: null, date_confidence: null,
    verification_status: "rejected", rejection_reason: null, corroborating_sources: [],
    checks: {
      event_found: null, edition_found: null, artists_found: [], artists_missing: [],
      truncated: false, redirects: [], date_conflict: false,
      claimed_date: lead.claimed_publication_date ?? null, claimed_date_matches: null,
    },
    evidence: [], source_text: "", checked_at: new Date(now).toISOString(),
  };
  const end = (status: VerificationStatus, reason: string | null) => {
    record.verification_status = status;
    record.rejection_reason = reason;
    return record;
  };

  if (!isPublicHttpsUrl(lead.official_url)) return end("rejected", "url_officielle_invalide");
  const fetched = await deps.fetchPage(lead.official_url);
  record.final_url = fetched.finalUrl;
  record.checks.redirects = fetched.redirects;
  if (!fetched.ok) {
    if (fetched.status === 404 || fetched.status === 410) return end("rejected", "source_introuvable");
    return end(fetched.transient ? "retry" : "needs_review", "source_" + fetched.error);
  }
  record.checks.truncated = fetched.truncated;
  const page: ParsedPage = parsePage(fetched.html, fetched.finalUrl);
  record.page_title = page.title;
  record.source_text = page.main.slice(0, 20000);
  if (norm(page.main).length < 120 && norm(page.text).length < 200) {
    // Page rendue en JavaScript : le contenu existe sans doute, mais pas pour nous.
    return end("needs_review", "contenu_illisible");
  }

  // --- Les faits, vérifiés dans la page ---
  const factText = page.title + "\n" + page.main;
  const wholeText = page.title + "\n" + page.text + "\n" + page.meta.map((m) => m.content).join("\n");
  if (lead.event_name) record.checks.event_found = eventInText(wholeText, lead.event_name);
  if (lead.edition) record.checks.edition_found = wholeText.includes(String(lead.edition)) ||
    // « Rock Werchter 2027 » dans le titre de l'onglet, « RW27 » ou « '27 »
    new RegExp("\\b(?:rw|'|’)?" + String(lead.edition).slice(2) + "\\b", "i").test(page.title);
  for (const a of artists) (containsName(factText, a) ? record.checks.artists_found : record.checks.artists_missing).push(a);

  if (record.checks.event_found === false && !artists.some((a) => containsName(factText, a))) {
    return end("rejected", "sujet_absent_de_la_source");
  }
  if (artists.length && !record.checks.artists_found.length) {
    return end("rejected", "artistes_absents_de_la_source");
  }

  // --- La date de publication ---
  const evidence = pageEvidence(page, now);
  let decision = decidePublication(evidence, now, maxAgeDays);
  const strong = decision.evidence && decision.evidence.confidence >= 0.75;

  if (!strong) {
    if (lead.listing_hint && canonicalUrl(lead.listing_hint.url) !== canonicalUrl(fetched.finalUrl)) {
      evidence.push({ date: lead.listing_hint.date, type: "sommaire_officiel", url: lead.listing_hint.url, confidence: 0.85, detail: "relevé par le canal officiel" });
    }
    const listings = [...new Set([...(deps.listingUrlsFor?.(fetched.finalUrl) ?? []), ...inferredListingUrls(fetched.finalUrl)])].slice(0, 3);
    for (const listingUrl of listings) {
      if (evidence.some((e) => e.type === "sommaire_officiel")) break;
      const listing = await deps.fetchPage(listingUrl);
      if (!listing.ok) continue;
      const found = listingEvidence(listing.html, listing.finalUrl, { url: fetched.finalUrl, title: page.title }, now) ??
        listingEvidence(listing.html, listing.finalUrl, { url: lead.official_url, title: page.title }, now);
      if (found) evidence.push(found);
    }
    decision = decidePublication(evidence, now, maxAgeDays);
  }

  // --- Recoupement par la presse si la source officielle ne date rien ---
  if (!decision.date || (decision.evidence?.confidence ?? 0) < 0.75) {
    for (const pressUrl of (lead.press_urls ?? []).filter(isPublicHttpsUrl).slice(0, 3)) {
      if (canonicalUrl(pressUrl) === canonicalUrl(fetched.finalUrl)) continue;
      const press = await deps.fetchPage(pressUrl);
      if (!press.ok) continue;
      const pp = parsePage(press.html, press.finalUrl);
      const pText = pp.title + "\n" + pp.main;
      const sameEvent = !lead.event_name || eventInText(pText, lead.event_name);
      const sameArtists = record.checks.artists_found.filter((a) => containsName(pText, a));
      if (!sameEvent || (record.checks.artists_found.length && !sameArtists.length)) continue;
      const pd = decidePublication(pageEvidence(pp, now), now, maxAgeDays);
      record.corroborating_sources.push({ url: press.finalUrl, date: pd.date, artists: sameArtists });
      if (pd.date && (pd.evidence?.confidence ?? 0) >= 0.75) {
        // La presse fixe une borne : l'annonce date au plus tard de ce jour-là.
        evidence.push({ date: pd.date, type: "presse", url: press.finalUrl, confidence: 0.7, detail: "annonce reprise par la presse" });
      }
    }
    decision = decidePublication(evidence, now, maxAgeDays);
  }

  record.evidence = evidence;
  record.checks.date_conflict = decision.conflict;
  if (record.checks.claimed_date && decision.date) record.checks.claimed_date_matches = record.checks.claimed_date === decision.date;
  if (decision.date) {
    record.publication_date = decision.date;
    record.date_evidence_url = decision.evidence!.url;
    record.date_evidence_type = decision.evidence!.type;
    record.date_confidence = Math.round(decision.evidence!.confidence * 100) / 100;
  }

  if (decision.freshness === "stale") return end("rejected", "annonce_trop_ancienne");
  if (decision.freshness === "future") return end("needs_review", "date_publication_future");
  if (!decision.date) return end("needs_review", "date_publication_non_prouvee");
  if ((decision.evidence?.confidence ?? 0) < 0.7) return end("needs_review", "date_publication_incertaine");
  if (decision.conflict) return end("needs_review", "dates_contradictoires");
  if (record.checks.event_found === false) return end("needs_review", "evenement_non_retrouve");
  if (lead.edition && record.checks.edition_found === false) return end("needs_review", "edition_non_retrouvee");
  return end("verified", null);
}
