// BACKSTAGE v2 — tests hors ligne : aucune requête réseau, aucun appel OpenAI.
// Lancer : node --test tests/v2/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchPage, isPublicHttpsUrl, type FetchedPage } from "../../supabase/functions/_shared/backstage/fetch.ts";
import { findDates } from "../../supabase/functions/_shared/backstage/dates.ts";
import { parsePage } from "../../supabase/functions/_shared/backstage/html.ts";
import { decidePublication, pageEvidence } from "../../supabase/functions/_shared/backstage/evidence.ts";
import { verifyLead } from "../../supabase/functions/_shared/backstage/verify.ts";
import { buildStory, classifyStory } from "../../supabase/functions/_shared/backstage/story.ts";
import { lintArticle } from "../../supabase/functions/_shared/backstage/quality.ts";
import { leadRow, leadsFromV18Discovery, parisSlot } from "../../supabase/functions/backstage-pipeline/mapping.ts";

const fx = (name: string) => fs.readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
// Passage réel en échec : 2 novembre 2026, 7 h à Paris.
const RUN_2_NOV = Date.parse("2026-11-02T06:00:00Z");
const RW = "https://www.rockwerchter.be/en/news/";
const MA_URL = RW + "massive-attack-make-their-return-at-rock-werchter";
const TS_URL = RW + "turnstile-join-the-line-up";

/** Faux Web : URL → page. Toute URL inconnue répond 404. */
function fakeWeb(pages: Record<string, string | { status: number; location?: string; body?: string }>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const p = pages[url];
    if (p === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    if (typeof p === "string") return new Response(p, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(p.body ?? "", { status: p.status, headers: { "content-type": "text/html", ...(p.location ? { location: p.location } : {}) } });
  };
  return { calls, fetch: (u: string): Promise<FetchedPage> => fetchPage(u, { fetchImpl }) };
}

// ------------------------------------------------------------------ Incidents de référence

test("Massive Attack × Rock Werchter : vérifiée, datée du 28 octobre par la date sous le titre", async () => {
  const web = fakeWeb({ [MA_URL]: fx("rw-massive-attack.html") });
  const r = await verifyLead({
    official_url: MA_URL, event_name: "Rock Werchter", edition: 2027, artists: ["Massive Attack"],
    claimed_publication_date: "2026-10-28",
  }, { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "verified", r.rejection_reason ?? "");
  assert.equal(r.publication_date, "2026-10-28");
  assert.equal(r.date_evidence_type, "sous_le_titre");
  assert.equal(r.date_evidence_url, MA_URL);
  assert.equal(r.checks.claimed_date_matches, true);
  assert.deepEqual(r.checks.artists_found, ["Massive Attack"]);
});

test("Massive Attack : ni 27 juin 2003, ni 30 octobre (billetterie), ni juillet 2027 ne sont pris pour la publication", () => {
  const p = parsePage(fx("rw-massive-attack.html"), MA_URL);
  const dates = pageEvidence(p, RUN_2_NOV).map((e) => e.date);
  assert.ok(!dates.includes("2003-06-27"));
  assert.ok(!dates.includes("2026-10-30"));
  assert.ok(!dates.some((d) => d.startsWith("2027")));
});

test("Échantillon du dossier de passation : « titre — 28 October 2026 » sous le h1", () => {
  const html = `<html><body><main><h1>Massive Attack make their return at Rock Werchter</h1>
    <p>— 28 October 2026</p><p>Massive Attack are making their return to Rock Werchter.</p></main></body></html>`;
  const d = decidePublication(pageEvidence(parsePage(html, MA_URL), RUN_2_NOV), RUN_2_NOV);
  assert.equal(d.date, "2026-10-28");
  assert.equal(d.freshness, "fresh");
});

test("Turnstile : page sans date, date retrouvée sur la carte EXACTE du sommaire officiel", async () => {
  const web = fakeWeb({
    [TS_URL]: fx("rw-turnstile.html"),
    "https://www.rockwerchter.be/en/news": fx("rw-news-listing.html"),
  });
  const r = await verifyLead({ official_url: TS_URL, event_name: "Rock Werchter", edition: 2027, artists: ["Turnstile"] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "verified", r.rejection_reason ?? "");
  // Le sommaire contient aussi Massive Attack (28/10) : il ne faut pas lui voler sa date.
  assert.equal(r.publication_date, "2026-10-30");
  assert.equal(r.date_evidence_type, "sommaire_officiel");
  assert.equal(r.date_evidence_url, "https://www.rockwerchter.be/en/news");
});

test("Page officielle de 4 Mo : lue partiellement, jamais rejetée pour sa taille", async () => {
  const heavy = fx("rw-massive-attack.html").replace("</body>",
    "<script>" + "x".repeat(4_000_000) + "</script></body>");
  const web = fakeWeb({ [MA_URL]: heavy });
  const r = await verifyLead({ official_url: MA_URL, event_name: "Rock Werchter", artists: ["Massive Attack"] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.checks.truncated, true);
  assert.equal(r.verification_status, "verified");
});

test("Redirections : suivies vers le même site, refusées vers une adresse privée", async () => {
  const short = "https://rockwerchter.be/en/news/massive-attack-make-their-return-at-rock-werchter/";
  const web = fakeWeb({ [short]: { status: 301, location: MA_URL }, [MA_URL]: fx("rw-massive-attack.html") });
  const r = await verifyLead({ official_url: short, event_name: "Rock Werchter", artists: ["Massive Attack"] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "verified");
  assert.equal(r.final_url, MA_URL);

  const evil = fakeWeb({ "https://evil.example/x": { status: 302, location: "https://127.0.0.1/admin" } });
  const p = await evil.fetch("https://evil.example/x");
  assert.equal(p.ok, false);
  assert.equal(p.error, "url_non_autorisee");
  assert.equal(isPublicHttpsUrl("https://localhost/"), false);
  assert.equal(isPublicHttpsUrl("http://www.rockwerchter.be/"), false);
});

// ------------------------------------------------------------------ Les trois issues

test("Annonce réelle sans aucune date prouvable : à examiner, pas rejetée", async () => {
  const web = fakeWeb({ [TS_URL]: fx("rw-turnstile.html") }); // pas de sommaire joignable
  const r = await verifyLead({ official_url: TS_URL, event_name: "Rock Werchter", artists: ["Turnstile"] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "needs_review");
  assert.equal(r.rejection_reason, "date_publication_non_prouvee");
});

test("Presse de n'importe quel média sérieux : borne la date si elle parle du même artiste et du même festival", async () => {
  const press = "https://www.festivalinfo.nl/news/59559/Ook-Turnstile-erbij-voor-Rock-Werchter-2027/";
  const web = fakeWeb({
    [TS_URL]: fx("rw-turnstile.html"),
    [press]: `<html><body><article><h1>Ook Turnstile erbij voor Rock Werchter 2027</h1>
      <div class="date">30 oktober 2026</div><p>Rock Werchter heeft Turnstile toegevoegd aan de affiche van 2027.</p></article></body></html>`,
  });
  const r = await verifyLead({ official_url: TS_URL, event_name: "Rock Werchter", edition: 2027, artists: ["Turnstile"], press_urls: [press] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "verified", r.rejection_reason ?? "");
  assert.equal(r.date_evidence_type, "presse");
  assert.equal(r.publication_date, "2026-10-30");
  assert.equal(r.corroborating_sources[0].artists[0], "Turnstile");
});

test("Presse qui parle d'un autre artiste : ignorée", async () => {
  const press = "https://www.example-mag.com/a";
  const web = fakeWeb({
    [TS_URL]: fx("rw-turnstile.html"),
    [press]: `<html><body><article><h1>Rock Werchter 2027 : Muse confirmé</h1><p>Publié le 30 octobre 2026</p><p>Muse jouera à Rock Werchter.</p></article></body></html>`,
  });
  const r = await verifyLead({ official_url: TS_URL, event_name: "Rock Werchter", artists: ["Turnstile"], press_urls: [press] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "needs_review");
  assert.equal(r.corroborating_sources.length, 0);
});

test("Annonce ancienne : rejetée avec la preuve de sa date", async () => {
  const web = fakeWeb({ [MA_URL]: fx("rw-massive-attack.html") });
  const r = await verifyLead({ official_url: MA_URL, event_name: "Rock Werchter", artists: ["Massive Attack"] },
    { fetchPage: web.fetch, now: Date.parse("2026-11-25T06:00:00Z") });
  assert.equal(r.verification_status, "rejected");
  assert.equal(r.rejection_reason, "annonce_trop_ancienne");
  assert.equal(r.publication_date, "2026-10-28"); // la preuve reste consultable
});

test("Hallucination : l'artiste n'est pas sur la page officielle → rejetée", async () => {
  const web = fakeWeb({ [MA_URL]: fx("rw-massive-attack.html") });
  const r = await verifyLead({ official_url: MA_URL, event_name: "Rock Werchter", artists: ["Radiohead"] },
    { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(r.verification_status, "rejected");
  assert.equal(r.rejection_reason, "artistes_absents_de_la_source");
});

test("404 → rejet ; 503 ou délai → nouvel essai plus tard", async () => {
  const web = fakeWeb({ "https://site.example.com/down": { status: 503 } });
  const gone = await verifyLead({ official_url: "https://site.example.com/nope" }, { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(gone.verification_status, "rejected");
  const down = await verifyLead({ official_url: "https://site.example.com/down" }, { fetchPage: web.fetch, now: RUN_2_NOV });
  assert.equal(down.verification_status, "retry");
});

test("JSON-LD @graph et méta article:published_time l'emportent et concordent", () => {
  const html = `<html><head><meta property="article:published_time" content="2026-10-31T09:00:00+01:00">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},
    {"@type":"NewsArticle","datePublished":"2026-10-31T08:00:00Z","headline":"x"}]}</script></head>
    <body><article><h1>Hellfest 2027 dévoile ses têtes d'affiche</h1><p>Le festival aura lieu du 18 au 21 juin 2027.</p></article></body></html>`;
  const d = decidePublication(pageEvidence(parsePage(html, "https://hellfest.fr/news/a"), RUN_2_NOV), RUN_2_NOV);
  assert.equal(d.date, "2026-10-31");
  assert.equal(d.evidence?.type, "jsonld");
});

test("Dates en plusieurs langues et formats", () => {
  const now = RUN_2_NOV;
  const iso = (s: string) => findDates(s, now)[0]?.iso;
  assert.equal(iso("28 oktober 2026"), "2026-10-28");
  assert.equal(iso("28. Oktober 2026"), "2026-10-28");
  assert.equal(iso("October 28, 2026"), "2026-10-28");
  assert.equal(iso("mardi 28 octobre 2026"), "2026-10-28");
  assert.equal(iso("28/10/2026"), "2026-10-28");
  assert.equal(iso("1er novembre 2026"), "2026-11-01");
  assert.equal(iso("28 oct."), "2026-10-28");
  assert.equal(iso("Publicado el 28 de octubre de 2026") ?? null, null); // tournure non prise : pas d'invention
});

// ------------------------------------------------------------------ Doublons et mises à jour

const graspop = (artists: string[], url = "https://press.graspop.be/en/news/x") =>
  buildStory({ event_name: "Graspop Metal Meeting", edition: 2027, kind: "lineup", artists, official_url: url });

test("Evanescence au Graspop 2027 : doublon d'un article publié avant la v2", () => {
  const v = classifyStory(graspop(["Evanescence"]),
    [{ title: "Evanescence rejoint l'affiche du Graspop 2027", status: "published", created_at: "2026-10-20T08:00:00Z" }],
    { event_name: "Graspop Metal Meeting", artists: ["Evanescence"] });
  assert.equal(v.verdict, "duplicate");
});

test("Mötley Crüe proposé deux fois avec des topic_key différents : le second est un doublon", () => {
  const first = graspop(["Mötley Crüe"], "https://press.graspop.be/en/motley-crue");
  const v = classifyStory(graspop(["Motley Crue"], "https://press.graspop.be/en/motley-crue/"),
    [{ title: "Graspop 2027 accueillera Mötley Crüe", story: first, status: "pending" }]);
  assert.equal(v.verdict, "duplicate");
});

test("Même festival, même artiste + nouvel artiste : mise à jour légitime, pas doublon", () => {
  const v = classifyStory(graspop(["Mötley Crüe", "Judas Priest"]),
    [{ title: "Graspop 2027 accueillera Mötley Crüe", story: graspop(["Mötley Crüe"]), status: "published" }]);
  assert.equal(v.verdict, "update");
  if (v.verdict === "update") assert.deepEqual(v.new_artists, ["judas priest"]);
});

test("Même artiste, autre édition : nouvelle actualité", () => {
  const v = classifyStory(graspop(["Evanescence"]),
    [{ title: "Evanescence au Graspop 2026", status: "published", created_at: "2025-11-01T08:00:00Z" }],
    { event_name: "Graspop Metal Meeting", artists: ["Evanescence"] });
  assert.equal(v.verdict, "new");
});

test("Tournée : nouvelles villes = mise à jour ; mêmes villes = doublon", () => {
  const tour = (places: string[]) => buildStory({ kind: "tour", edition: 2027, artists: ["Idles"], places, official_url: "https://idlesband.com/tour" });
  const known = [{ title: "Idles en tournée en 2027", story: tour(["Paris", "Lille"]), status: "published" }];
  assert.equal(classifyStory(tour(["Paris", "Lille"]), known).verdict, "duplicate");
  assert.equal(classifyStory(tour(["Paris", "Lille", "Lyon"]), known).verdict, "update");
});

test("Un article refusé ne bloque pas une nouvelle proposition", () => {
  const v = classifyStory(graspop(["Evanescence"]),
    [{ title: "Evanescence au Graspop 2027", status: "rejected" }], { event_name: "Graspop", artists: ["Evanescence"] });
  assert.equal(v.verdict, "new");
});

// ------------------------------------------------------------------ Relecture

test("Relecture : clichés et années non sourcées en alertes, l'article n'est pas jeté", () => {
  const p = "Massive Attack reviendra à Rock Werchter en juillet 2027, plus de vingt ans après leur dernier passage en 2003 sur la plaine du Festivalpark. ";
  const r = lintArticle({
    title: "Massive Attack de retour à Rock Werchter en 2027",
    excerpt: "Le collectif de Bristol retrouve le festival belge, qu'il n'avait plus foulé depuis 2003.",
    category: "FESTIVALS", format: "breve",
    body: [p.repeat(4), "Une affiche incontournable, un rendez-vous incontournable qui date de 1998."],
    sections: [{ title: "Billetterie", paragraphs: [p.repeat(3)] }],
  }, [fx("rw-massive-attack.html")]);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith("cliche")));
  assert.ok(r.warnings.some((w) => w.includes("1998")));
});

// ------------------------------------------------------------------ Branchements

test("Rejeu d'une découverte v18 réelle → piste v2 complète", () => {
  const v18 = JSON.stringify({ candidates: [{
    topic: "Massive Attack annoncé à Rock Werchter 2027", topic_key: "rock-werchter-2027-massive-attack",
    why_now: "Nouvel ajout", official_url: MA_URL, quotes: [], festival_name: "Rock Werchter",
    press_url: "", announced_artists: ["Massive Attack"],
  }] });
  const leads = leadsFromV18Discovery("Voici :\n" + v18);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].edition, 2027);
  const row = leadRow(leads[0], "2026-11-02-matin", true);
  assert.equal(row.story_key, "rock werchter|2027|lineup|massive attack");
  assert.equal(row.canonical_url, "rockwerchter.be/en/news/massive-attack-make-their-return-at-rock-werchter");
  assert.deepEqual(row.press_urls, []);
});

test("Créneaux de découverte à 7 h et 18 h, heure de Paris, en hiver comme en été", () => {
  assert.equal(parisSlot(new Date("2026-11-03T06:15:00Z")).isDiscoveryHour, true); // 7 h 15 hiver
  assert.equal(parisSlot(new Date("2026-07-03T05:15:00Z")).isDiscoveryHour, true); // 7 h 15 été
  assert.equal(parisSlot(new Date("2026-11-03T17:15:00Z")).id, "2026-11-03-soir");
  assert.equal(parisSlot(new Date("2026-11-03T10:00:00Z")).isDiscoveryHour, false);
});
