// Offline smoke-tests du radar. Aucune API OpenAI ou Supabase appelée.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = fs.readFileSync("supabase/functions/backstage-radar/index.ts", "utf8");
new vm.Script(source, { filename: "backstage-radar/index.ts" });
assert.doesNotMatch(source, /const prioritySources\s*=/,
  "Le moteur ne doit pas contenir de liste fixe imposée");
assert.match(source, /async function activeEditorialSources\(key\)/,
  "La liste évolutive provient de la base de données");
assert.match(source, /const WATCH_PER_RUN\s*=\s*12/,
  "Contrôle borné par passage avec rotation des sites");
assert.match(source, /search_context_size: "low"/,
  "Limiter le volume des résultats Web sans supprimer la recherche ouverte");

const migration = fs.readFileSync("supabase/migration-radar.sql", "utf8");
const feedbackMigration = fs.readFileSync("supabase/migration-editorial-feedback.sql", "utf8");
const sourceMigration = fs.readFileSync("supabase/migration-dynamic-sources.sql", "utf8");
assert.match(sourceMigration, /create table if not exists public\.editorial_sources/i);
assert.match(sourceMigration, /enable row level security/i);
assert.match(sourceMigration, /create policy editorial_sources_admin_read/i);
assert.match(sourceMigration, /learn_editorial_source/i);
assert.match(sourceMigration, /mark_editorial_sources_checked/i);
assert.match(sourceMigration, /on conflict\(host\) do nothing/i);
const aiLogMigration = fs.readFileSync("supabase/migration-ai-logs.sql","utf8");
assert.match(aiLogMigration,/create table if not exists public\.editorial_ai_logs/i);
assert.match(aiLogMigration,/enable row level security/i);
assert.match(aiLogMigration,/create policy editorial_ai_logs_admin_read/i);
assert.match(aiLogMigration,/revoke all on public\.editorial_ai_logs from anon, authenticated/i);
assert.match(aiLogMigration,/interval '30 days'/i);
assert.match(feedbackMigration, /create table if not exists public\.editorial_feedback/i);
assert.match(feedbackMigration, /enable row level security/i);
assert.match(feedbackMigration, /create policy editorial_feedback_admin_read/i);
assert.match(feedbackMigration, /security definer/i);
assert.match(feedbackMigration, /public\.reject_editorial_draft_with_feedback/i);
assert.match(feedbackMigration, /status = 'rejected'/i);
// ON CONFLICT (topic_key) exige un index unique non partiel pour l'upsert PostgREST.
assert.match(migration, /create unique index\s+editorial_drafts_topic_unique\s+on public\.editorial_drafts\(topic_key\)\s*;/i);
let handler, openaiCalls = 0, insertedDraft = null, runUpdates = 0;
let emptyDiscovery = false;
let pressConfirmation = false;
let logWriteError = false;
const savedLogs = [];
const learnedSources=[];
const monitoredHosts=[];
const watchedSources = [
  {host:"cabaretvert.com",name:"Cabaret Vert",
    site_url:"https://cabaretvert.com/programmation/",source_kind:"festival"},
  {host:"graspop.be",name:"Graspop Metal Meeting",
    site_url:"https://press.graspop.be/en",source_kind:"festival"}
];
const prompts = [];
const editorialReturns = [
  { article_title:"Concert XYZ", category:"artiste",
    reason:"Je préfère les nouvelles annonces post-punk à ce groupe de pop.",apply_to_future:true },
  { article_title:"Autre concert", category:"style",
    reason:"Ce rejet est ponctuel, sans incidence éditoriale.",apply_to_future:false },
];
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
  if (address.includes("/rest/v1/editorial_feedback?select=")) return answer(editorialReturns);
  if (address.includes("/rest/v1/editorial_sources?select=")) {
    // La liste est désormais fournie exclusivement par Supabase.
    return answer([...watchedSources]);
  }
  if (address.includes("/rest/v1/rpc/mark_editorial_sources_checked")) {
    monitoredHosts.push(...JSON.parse(options.body).p_hosts);
    return answer(null,204);
  }
  if (address.includes("/rest/v1/rpc/learn_editorial_source")) {
    const p=JSON.parse(options.body);
    learnedSources.push(p);
    if (!watchedSources.some(x=>x.host===p.p_host)) {
      watchedSources.push({host:p.p_host,name:p.p_name,
        site_url:p.p_site_url,source_kind:p.p_source_kind});
    }
    return answer(null,204);
  }
  if (address.endsWith("/rest/v1/editorial_ai_logs")) {
    if (logWriteError) return answer({ message:"Test de panne du journal" }, 503);
    savedLogs.push(...JSON.parse(options.body));
    return answer(null, 204);
  }
  if (address.includes("/rest/v1/editorial_drafts?on_conflict=topic_key")) {
    insertedDraft = JSON.parse(options.body)[0];
    return answer([{ id: "test" }], 201);
  }
  if (address.includes("/rest/v1/editorial_radar_runs?slot=")) {
    runUpdates++;return answer(null, 204);
  }
  if (address.includes("/rest/v1/editorial_drafts?select=id&limit=1")) return answer([]);
  if (address.includes("press.graspop.be/en")) {
    const day = offset => {
      const d=new Date(Date.now()-offset*86400000);
      return String(d.getUTCDate()).padStart(2,"0") + "/" +
        String(d.getUTCMonth()+1).padStart(2,"0")+"/"+d.getUTCFullYear();
    };
    return new Response('<html><body><h1>Graspop Metal Meeting news</h1>'+
      '<h2>The first headliner for Sunday 20 June!</h2><time>'+day(2)+'</time>'+
      '<h2>A new headliner for Saturday 19 June!</h2><time>'+day(4)+'</time>'+
      '<h2>First headliner: blink-182</h2><time>'+day(12)+'</time>'+
      '<p>Festival news for 2027: new rock and metal headlines this week.</p></body></html>',
      {status:200,headers:{"content-type":"text/html"}});
  }
  if (address.includes("cabaretvert.com/programmation/"))
    return new Response('<html><body><h1>Cabaret Vert 2027</h1><p>Premiers noms Fontaines D.C. et Angèle. ' +
      'Le festival annonce les premiers artistes pour son édition 2027 à Charleville-Mézières. ' +
      'Les nouveaux noms sont affichés dans la programmation officielle et des annonces suivront.</p></body></html>',
      { status:200, headers:{"content-type":"text/html"} });
  if (address.includes("liveandshootmag.com/"))
    return new Response('<html><head><meta property="article:published_time" content="' +
      new Date(Date.now()-86400000).toISOString() +
      '"></head><body><h1>Grand Festival 2027 : Rock Un rejoint le festival</h1>' +
      '<p>Grand Festival annonce Rock Un en 2027. ' + 
      'Un nouvel artiste est officiellement confirmé par les organisateurs. '.repeat(7) + '</p></body></html>',
      { status:200, headers:{"content-type":"text/html"} });
  if (address.includes("grandfestival.example")) return new Response(sourceHTML, {
    status: 200, headers: { "content-type": "text/html" },
  });
  if (address === "https://api.openai.com/v1/responses") {
    const params = JSON.parse(options.body);
    prompts.push(params.input);
    openaiCalls++;
    if (params.tools) return answer({ status: "completed",
      id: "resp-test-decouverte", model:"test-mini",
      usage:{input_tokens:150,output_tokens:75,output_tokens_details:{reasoning_tokens:10}},
      output: [
      { type: "web_search_call" },
      { type: "message", content: [{ type: "output_text",
        text: JSON.stringify({ candidates: emptyDiscovery ? [] : [{
          topic: "Grand Festival 2027 annonce une première programmation",
          topic_key: "grand-festival-programmation-2027",
          why_now: "Annonce officielle cette semaine",
          official_url: "https://grandfestival.example/programme",
          quotes: ["Cette programmation nouvelle confirme le retour du groupe de rock au Grand Festival en 2027."],
          festival_name: "Grand Festival",
          press_url: pressConfirmation ? "https://www.liveandshootmag.com/grand-festival-2027/" : "",
          announced_artists: pressConfirmation ? ["Rock Un"] : [],
        }] }) }] },
    ] });
    return answer({ status: "completed", id:"resp-test-redaction", model:"test-mini",
      usage:{input_tokens:350,output_tokens:200,output_tokens_details:{reasoning_tokens:20}},
      output: [{ type: "message",
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
// Un fil officiel contient parfois plusieurs communiqués : 28 et 26 octobre
// doivent prévaloir sur l'annonce initiale du 19 octobre.
const sourceIndex = '<h2>Nouvelle tête d’affiche</h2>28/10/2026 '+
  '<h2>Deuxième annonce</h2>26/10/2026 '+
  '<h2>blink-182 première tête d’affiche</h2>19/10/2026';
const headlines = vm.runInNewContext(
  'recentOfficialHeadlines('+JSON.stringify(sourceIndex)+',Date.UTC(2026,9,30))',ctx);
assert.equal(headlines.length,2,"Annonces du 28 et du 26 dans la période de 7 jours");
assert.equal(headlines[0].date,"2026-10-28");
assert.equal(headlines[1].date,"2026-10-26");
assert.ok(!JSON.stringify(headlines).includes("2026-10-19"),
  "L'ancienne annonce du 19 octobre ne doit pas être retenue");
const onlyOld = vm.runInNewContext(
  'recentOfficialHeadlines("19/10/2026 première tête d’affiche",Date.UTC(2026,9,30))',ctx);
assert.equal(onlyOld.length,0);
const datesSansAnnee = vm.runInNewContext(
  'recentOfficialHeadlines("28 oct Nouvelle tête d’affiche 26 okt Autre annonce 19 oct blink-182",Date.UTC(2026,9,30))',ctx);
assert.equal(datesSansAnnee.length,2,"Actualités officielles en FR et NL sans année");
assert.equal(datesSansAnnee[0].date,"2026-10-28");
assert.equal(datesSansAnnee[1].date,"2026-10-26");

// Pages de news officielles sans métadonnées, mais avec une date affichée
// dans l'en-tête du billet à côté de son temps de lecture.
function datedHeading(daysAgo) {
  const d = new Date(Date.now() - daysAgo*86400000);
  const m = new Intl.DateTimeFormat("en-GB", {month:"long",timeZone:"UTC"}).format(d);
  const publishedText = d.getUTCDate() + " " + m.toUpperCase() +
    " " + d.getUTCFullYear();
  return '<html><body><div class="post-info">' + publishedText +
    ' 1 MIN READ</div><h1>World Tour announcement</h1><article>' +
    'World tour dates in 2027, including February 23, March 5 and October 30, 2027' +
    '</article></body></html>';
}
const readDate = html => vm.runInNewContext(
  "officialPublishedDate(" + JSON.stringify(html) + ")", ctx
);
assert.equal(readDate(datedHeading(2)).reason, null,
  "Date de publication visible et récente acceptée");
assert.equal(readDate(datedHeading(12)).reason, "annonce_trop_ancienne",
  "L'annonce U2 du 15 octobre ne doit pas être publiée le 27 octobre");
assert.equal(readDate('<html><body><h1>Concert du 30 octobre 2027</h1>' +
  '<p>Billets disponibles pour le 30 octobre 2027</p></body></html>').reason,
  "date_publication_absente",
  "La date d'un concert ne doit pas valider la fraîcheur de l'annonce");
assert.equal(readDate('<html><head><meta property="article:published_time" ' +
  'content="2025-11-17T10:00:00Z"></head><body><h1>Tour</h1>' +
  '<div>' + datedHeading(2) + '</div></body></html>').reason,
  "annonce_trop_ancienne",
  "Une métadonnée ancienne ne doit pas être blanchie par une date visible récente");

const unauth = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "invalid" }, body: "{}" }));
assert.equal(unauth.status, 401);
assert.equal(openaiCalls, 0, "Une requête non autorisée ne coûte rien");
assert.equal(savedLogs.length, 0, "Aucun log OpenAI d'une requête non autorisée");
const health = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: env.SUPABASE_SECRET_KEYS ? "sb_secret_test_only_nonproduction" : "?" },
    body: JSON.stringify({ healthcheck: true }) }));
assert.equal(health.status, 200);
assert.equal((await health.json()).db, "ok");
assert.equal(savedLogs.length, 0, "Le healthcheck ne contacte pas OpenAI et ne crée pas de log");
const trigger = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
const result = await trigger.json();
assert.equal(trigger.status, 200, JSON.stringify(result));
assert.equal(result.result, "article_a_valider");
assert.equal(openaiCalls, 2, "Une recherche et une rédaction, pas plus");
assert.equal(savedLogs.length, 2, "Chaque appel déjà existant est journalisé");
assert.equal(savedLogs[0].stage, "decouverte");
assert.equal(savedLogs[1].stage, "redaction");
assert.equal(savedLogs[0].input_tokens, 150);
assert.equal(savedLogs[0].output_tokens, 75);
assert.equal(savedLogs[0].reasoning_tokens, 10);
assert.equal(savedLogs[0].web_search_calls, 1);
assert.equal(savedLogs[1].input_tokens, 350);
assert.equal(savedLogs[1].output_tokens, 200);
assert.ok(savedLogs[0].request_text.includes("nouvelles annonces post-punk"));
assert.ok(savedLogs[0].response_text.includes("Grand Festival"));
assert.ok(savedLogs.every(l=>l.status==="completed"));
assert.ok(!savedLogs.some(l=>JSON.stringify(l).includes("sk-test-fake") ||
  JSON.stringify(l).includes("sb_secret_test_only_nonproduction")), 
  "Aucune clé dans les logs");
assert.ok(prompts[0].includes("nouvelles annonces post-punk"), "Le moteur lit la mémoire lors de la découverte");
assert.ok(prompts[0].includes("Cabaret Vert"), "Une source officielle prioritaire est incluse dans la recherche");
assert.ok(prompts[0].includes("Fontaines D.C."), "Les premiers noms trouvés sur le site officiel guident la découverte");
assert.ok(prompts[0].includes("Graspop Metal Meeting"), "Le sommaire du Graspop est consulté");
assert.ok(prompts[0].includes("recent_headlines"), "Le prompt expose les titres officiels récents");
assert.match(prompts[0],/FENÊTRE DE NOUVEAUTÉ/,
  "La plage réelle de publication est fournie, pas seulement la date du concert");
assert.ok(prompts[1].includes("nouvelles annonces post-punk"), "Le moteur lit la mémoire lors de la rédaction");
assert.ok(!prompts[0].includes("Ce rejet est ponctuel"), "Un refus ponctuel n'est pas transmis");
assert.ok(!prompts[1].includes("Ce rejet est ponctuel"), "Le refus ponctuel est aussi absent de la rédaction");
assert.equal(insertedDraft.status, "pending", "Aucune publication automatique");
assert.equal(result.source_learned, true, "Une source officielle vérifiée est mémorisée");
assert.equal(learnedSources.length,1);
assert.equal(learnedSources[0].p_host,"grandfestival.example");
assert.equal(learnedSources[0].p_site_url,"https://grandfestival.example/");
assert.ok(monitoredHosts.includes("cabaretvert.com"),"Les sources existantes sont interrogées");
assert.equal(openaiCalls,2,"La mémoire des sources ne déclenche aucun appel OpenAI");
assert.equal(insertedDraft.payload.article.sources[0].url, "https://grandfestival.example/programme");
assert.equal(runUpdates, 1);
// Aucun feedback n'est envoyé si le rédacteur choisit de ne pas l'appliquer.
editorialReturns[0].apply_to_future=false;
prompts.length=0;
logWriteError=true;
const noMemory = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal(noMemory.status, 200, "Une panne Supabase du journal n'interrompt pas la veille");
assert.ok(prompts[0].includes("grandfestival.example"),
 "Une nouvelle source apprise apparaît dans la veille suivante, sans liste figée");
logWriteError=false;
assert.ok(!prompts.some(p=>p.includes("nouvelles annonces post-punk")),
  "L'avis décoché est exclu même après un précédent usage");
// Une annonce ancienne ou sans date de publication doit être écartée.
const recentMeta = '<meta property="article:published_time" content="' + publicationDate + '">';
sourceHTML = sourceHTML.replace(recentMeta,
  '<meta property="article:published_time" content="2025-11-17T10:00:00Z">');
openaiCalls = 0;
insertedDraft = null;
const stale = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal(stale.status, 200);
const staleReport = await stale.json();
assert.equal(staleReport.result, "aucune_source_officielle_verifiee");
assert.equal(staleReport.candidates_found, 1);
assert.equal(staleReport.rejections[0].reason, "annonce_trop_ancienne");
assert.ok(staleReport.rejections[0].topic.includes("Grand Festival"));
assert.equal(openaiCalls, 1, "Une annonce ancienne ne doit pas être rédigée");
assert.equal(insertedDraft, null, "Ne pas soumettre une vieille annonce");

sourceHTML = sourceHTML.replace('content="2025-11-17T10:00:00Z"', 'content=""');
openaiCalls = 0;
const undated = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
const undatedReport = await undated.json();
assert.equal(undatedReport.result, "aucune_source_officielle_verifiee");
assert.equal(undatedReport.rejections[0].reason, "date_publication_absente");
assert.equal(openaiCalls, 1, "Une page sans date n'autorise pas la rédaction");
sourceHTML = sourceHTML.replace('content=""',
  'content="' + new Date(Date.now()-86400000).toISOString() + '"');
sourceHTML = sourceHTML.replace(
  "Cette programmation nouvelle confirme le retour du groupe de rock au Grand Festival en 2027.",
  "La phrase attendue par le modèle est absente de la page."
);
openaiCalls = 0;
const missingQuote = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal(missingQuote.status, 200);
assert.equal((await missingQuote.json()).rejections[0].reason, "citations_non_retrouvees");
assert.equal(openaiCalls, 1, "Une citation manquante empêche la rédaction");

// Une recherche OpenAI sans piste ne doit pas déclencher de rédaction
// et doit être clairement distinguée des sources vérifiées puis rejetées.
emptyDiscovery = true;
openaiCalls = 0;
insertedDraft = null;
const logsBeforeEmpty=savedLogs.length;
const noCandidates = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body: "{}" }));
assert.equal(noCandidates.status, 200);
const emptyReport = await noCandidates.json();
assert.equal(emptyReport.result, "aucune_source_officielle_verifiee");
assert.equal(emptyReport.candidates_found, 0);
assert.equal(emptyReport.checked, 0);
assert.equal(emptyReport.discovery_status, "no_candidates_returned");
assert.equal(emptyReport.rejections.length, 0);
assert.equal(openaiCalls, 1, "Pas de rédaction payante sans sujet");
assert.equal(savedLogs.length, logsBeforeEmpty+1, "Une recherche vide reste journalisée");
assert.equal(insertedDraft, null, "Pas de création d'article à partir d'une recherche vide");

// Une page officielle de programmation sans date peut être corroborée
// par un média connu, daté récemment et confirmant le même artiste.
emptyDiscovery = false;
pressConfirmation = true;
sourceHTML = sourceHTML.replace('La phrase attendue par le modèle est absente de la page.',
 "Cette programmation nouvelle confirme le retour du groupe de rock au Grand Festival en 2027.");
sourceHTML = sourceHTML.replace(/<meta property="article:published_time" content="[^"]*">/, "");
openaiCalls = 0;
insertedDraft = null;
const withPress = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method: "POST", headers: { apikey: "sb_secret_test_only_nonproduction" }, body:"{}" }));
const pressResult = await withPress.json();
assert.equal(withPress.status,200,JSON.stringify(pressResult));
assert.equal(pressResult.result, "article_a_valider", JSON.stringify(pressResult));
assert.equal(insertedDraft.payload.article.sources.length, 2,
 "Le programme officiel et l'article de presse daté sont tous deux cités");
assert.match(insertedDraft.payload.article.sources[1].url,/liveandshootmag/);
assert.equal(openaiCalls,2, "La corroboration ne déclenche pas de requête OpenAI supplémentaire");

// Une source de presse récente ne doit JAMAIS blanchir un vieux
// communiqué de lancement officiellement daté.
sourceHTML=sourceHTML.replace("</head>",
 '<meta property="article:published_time" content="2025-11-17T10:00:00Z"></head>');
openaiCalls=0;
insertedDraft=null;
const noFalseFresh = await handler(new Request("https://project.supabase.co/functions/v1/backstage-radar",
  { method:"POST",headers:{apikey:"sb_secret_test_only_nonproduction"},body:"{}" }));
assert.equal((await noFalseFresh.json()).rejections[0].reason,"annonce_trop_ancienne");
assert.equal(openaiCalls,1);
assert.equal(insertedDraft,null);

console.log("OK — authentification, absence de frais non autorisés, sources, article privé, pas de publication");
