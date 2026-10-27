// Offline smoke-tests du radar. Aucune API OpenAI ou Supabase appelée.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("supabase/functions/backstage-radar/index.ts", "utf8");
new vm.Script(source, { filename: "backstage-radar/index.ts" });
const migration = fs.readFileSync("supabase/migration-radar.sql", "utf8");
// ON CONFLICT (topic_key) exige un index unique non partiel pour l'upsert PostgREST.
assert.match(migration, /create unique index\s+editorial_drafts_topic_unique\s+on public\.editorial_drafts\(topic_key\)\s*;/i);
let handler, openaiCalls = 0, insertedDraft = null, runUpdates = 0;
const db = [];
let publicationDate = new Date(Date.now() - 86400000).toISOString();
let sourceHTML = '<html><head><meta property="article:published_time" content="' +
  publicationDate + '"></head><body><h1>Grand Festival 2027</h1>' +
  "Cette programmation nouvelle confirme le retour du groupe de rock au Grand Festival en 2027. " +
  "Le festival Grand Festival annonce les artistes sur sa page officielle dès ce matin. " +
  "Vendredi 18 juin 2027 Rock Un et Rock Deux. ".repeat(5) + "</body></html>";
const paragraph = "La programmation du Grand Festival en 2027 suscite un réel intérêt pour la scène musicale. " +
  "Cette édition attire l'attention sur les artistes confirmés, et sur la place du spectacle vivant. " +
  "La communication officielle reste la référence pour vérifier les informations présentées ici. " +
  "Les amateurs pourront consulter les prochains détails directement sur le site de l'organisateur. ";
const story = {
  title: "Grand Festival 2027 annonce une programmation de concerts très attendue",
  excerpt: "La première annonce officielle présente des artistes et donne un nouvel élan au Grand Festival 2027.",
  category: "FESTIVALS",
  body: [paragraph, paragraph], sections: [{ title: "Une programmation attendue",
    paragraphs: [paragraph, paragraph] }],
  festival: { name: "Grand Festival", city: "Paris", country: "France",
    editionYear: 2027, dates: "18 juin 2027",
    lineup: [{ day: "Vendredi 18 juin 2027", artists: ["Rock Un", "Rock Deux"] }] },
};
function answer(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}
async function fakeFetch(url, options = {}) {
  const address = String(url);
  if (address.includes("/rest/v1/editorial_drafts?select=id&status=eq.pending")) return answer([]);
  if (address.includes("/rest/v1/editorial_radar_runs?on_conflict=slot")) return answer([{ slot: "2026-10-26-matin" }], 201);
  if (address.includes("/rest/v1/editorial_drafts?select=topic_key")) return answer([]);
  if (address.includes("/rest/v1/editorial_drafts?on_conflict=topic_key")) {
    insertedDraft = JSON.parse(options.body)[0];
    return answer([{ id: "test" }], 201);
  }
  if (address.includes("/rest/v1/editorial_radar_runs?slot=")) {
    runUpdates++;return answer(null, 204);
  }
  if (address.includes("/rest/v1/editorial_drafts?select=id&limit=1")) return answer([]);
  if (address.includes("grandfestival.example")) return new Response(sourceHTML, {
    status: 200, headers: { "content-type": "text/html" },
  });
  if (address === "https://api.openai.com/v1/responses") {
    const params = JSON.parse(options.body);
    openaiCalls++;
    if (params.tools) return answer({ status: "completed", output: [
      { type: "web_search_call" },
      { type: "message", content: [{ type: "output_text",
        text: JSON.stringify({ candidates: [{
          topic: "Grand Festival 2027 annonce une première programmation",
          topic_key: "grand-festival-programmation-2027",
          why_now: "Annonce officielle cette semaine",
          official_url: "https://grandfestival.example/programme",
          quotes: ["Cette programmation nouvelle confirme le retour du groupe de rock au Grand Festival en 2027."],
          festival_name: "Grand Festival",
        }] }) }] },
    ] });
    return answer({ status: "completed", output: [{ type: "message",
      content: [{ type: "output_text", text: JSON.stringify(story) }] }] });
  }
  throw Error("Accès réseau non prévu dans le test : " + address);
}
const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_test_only_nonproduction" }),
  OPENAI_API_KEY: "sk-test-fake",
};
const ctx = {
  Deno: { env: { get: key => env[key] }, serve: callback => { handler = callback; } },
  fetch: fakeFetch, crypto: webcrypto, TextEncoder, AbortSignal,
  URL, Response, console, Date, JSON,
};
vm.runInNewContext(source, ctx);
const unauth = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "invalid" }, body: "{}" }));
assert.equal(unauth.status, 401);
assert.equal(openaiCalls, 0, "Une requête non autorisée ne coûte rien");
const health = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: env.SUPABASE_SECRET_KEYS ? "sb_secret_test_only_nonproduction" : "?" },
    body: JSON.stringify({ healthcheck: true }) }));
assert.equal(health.status, 200);
assert.equal((await health.json()).db, "ok");
const trigger = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
const result = await trigger.json();
assert.equal(trigger.status, 200, JSON.stringify(result));
assert.equal(result.result, "article_a_valider");
assert.equal(openaiCalls, 2, "Une recherche et une rédaction, pas plus");
assert.equal(insertedDraft.status, "pending", "Aucune publication automatique");
assert.equal(insertedDraft.payload.article.sources[0].url, "https://grandfestival.example/programme");
assert.equal(runUpdates, 1);
// Une annonce ancienne ou sans date de publication doit être écartée.
const recentMeta = '<meta property="article:published_time" content="' + publicationDate + '">';
sourceHTML = sourceHTML.replace(recentMeta,
  '<meta property="article:published_time" content="2025-11-17T10:00:00Z">');
openaiCalls = 0;
insertedDraft = null;
const stale = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal(stale.status, 200);
assert.equal((await stale.json()).result, "aucune_source_officielle_verifiee");
assert.equal(openaiCalls, 1, "Une annonce ancienne ne doit pas être rédigée");
assert.equal(insertedDraft, null, "Ne pas soumettre une vieille annonce");

sourceHTML = sourceHTML.replace('content="2025-11-17T10:00:00Z"', 'content=""');
openaiCalls = 0;
const undated = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal((await undated.json()).result, "aucune_source_officielle_verifiee");
assert.equal(openaiCalls, 1, "Une page sans date n'autorise pas la rédaction");
console.log("OK — authentification, absence de frais non autorisés, sources, article privé, pas de publication");
