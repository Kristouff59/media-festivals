// BACKSTAGE — moteur autonome. Aucun article n'est publié par ce service.
// Seule la clé serveur Supabase peut invoquer cette fonction.
// Déployer avec verify_jwt=false, auth appliquée ci-dessous.
const env = (name) => Deno.env.get(name)?.trim() || "";
const root = env("SUPABASE_URL").replace(/\/$/, "");
const model = env("OPENAI_MODEL") || "gpt-5.4-mini";
const site = env("BACKSTAGE_SITE_URL") || "https://kristouff59.github.io/media-festivals";
const api = "https://api.openai.com/v1/responses";
function secret() {
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS"));
    if (keys.default && keys.default.startsWith("sb_secret_")) return keys.default;
  } catch (_) { /* ancienne clé disponible en secours */ }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}
function allowed(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (!a.length || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
const norm = (s) => String(s || "").normalize("NFKD").toLowerCase()
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s) => norm(s).replace(/ /g, "-").slice(0, 62);
const count = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
async function digest(s) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function data(path, key, method = "GET", item = null, prefer = "") {
  const r = await fetch(root + "/rest/v1/" + path, {
    method, signal: AbortSignal.timeout(9000),
    headers: { apikey: key, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    ...(item === null ? {} : { body: JSON.stringify(item) }),
  });
  if (!r.ok) throw Error("Supabase HTTP " + r.status + " : " + (await r.text()).slice(0, 130));
  return r.status === 204 ? null : await r.json().catch(() => null);
}
function parseOutput(text) {
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw Error("Sortie JSON absente");
  return JSON.parse(text.slice(first, last + 1));
}
async function openai(prompt, web) {
  const req = {
    model, input: prompt, store: false,
    reasoning: { effort: "low" }, max_output_tokens: web ? 2400 : 4500,
  };
  if (web) {
    req.tools = [{ type: "web_search", search_context_size: "medium" }];
    req.tool_choice = "required";
    req.max_tool_calls = 2;
  } else req.text = { format: { type: "json_object" } };
  const r = await fetch(api, {
    method: "POST", signal: AbortSignal.timeout(50000),
    headers: { Authorization: "Bearer " + env("OPENAI_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw Error("OpenAI HTTP " + r.status + " : " + (await r.text()).slice(0, 160));
  const result = await r.json();
  if (result.status !== "completed") throw Error("OpenAI non terminé");
  if (web && !result.output?.some(x => x.type === "web_search_call")) {
    throw Error("Recherche Web absente");
  }
  const text = (result.output || []).filter(x => x.type === "message")
    .flatMap(x => x.content || []).filter(x => x.type === "output_text")
    .map(x => x.text || "").join("");
  return parseOutput(text);
}
function officialUrl(raw) {
  try {
    const u = new URL(raw), h = u.hostname.toLowerCase();
    const banned = ["google.com","news.google.com","wikipedia.org","lemonde.fr",
      "ouest-france.fr","infoconcert.com","ticketmaster.fr","fnacspectacles.com",
      "facebook.com","instagram.com","x.com","youtube.com","reddit.com","bandsintown.com"];
    if (u.protocol !== "https:" || u.port || u.username || u.password ||
        !h.includes(".") || h === "localhost" || h.endsWith(".local") ||
        /^(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./.test(h) ||
        banned.some(b => h === b || h.endsWith("." + b))) return null;
    u.hash = "";
    return u.toString();
  } catch (_) { return null; }
}
function plain(html) {
  return html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&(?:amp|nbsp|lt|gt|quot|apos);/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60000);
}
async function verify(news) {
  const url = officialUrl(news.official_url);
  if (!url || !Array.isArray(news.quotes)) return null;
  const r = await fetch(url, {
    redirect: "error", signal: AbortSignal.timeout(12000),
    headers: { Accept: "text/html", "User-Agent": "BACKSTAGE-editorial-check/1.0" },
  });
  if (!r.ok || !/html/i.test(r.headers.get("content-type") || "") ||
      Number(r.headers.get("content-length") || 0) > 1200000) return null;
  const html = await r.text();
  if (html.length > 1200000) return null;
  const source = plain(html), normalized = norm(source);
  if (normalized.length < 250) return null;
  // Le modèle n'est pas une preuve : citer une phrase retrouvée textuellement.
  const matches = news.quotes.filter(q => typeof q === "string" &&
    norm(q).length >= 35 && normalized.includes(norm(q)));
  if (!matches.length) return null;
  const tokens = norm(news.festival_name || news.topic).split(" ").filter(t => t.length > 4);
  if (tokens.length && !tokens.some(t => normalized.includes(t))) return null;
  return { url, source };
}
function articleValid(a, source) {
  if (!a || typeof a.title !== "string" || a.title.length < 22 || a.title.length > 140 ||
      typeof a.excerpt !== "string" || a.excerpt.length < 65 || a.excerpt.length > 350 ||
      !["FESTIVALS","CONCERTS","SOCIÉTÉ"].includes(a.category) ||
      !Array.isArray(a.body) || a.body.length < 2 ||
      !Array.isArray(a.sections) || !a.sections.length) return false;
  const paragraphs = [...a.body, ...a.sections.flatMap(x => x.paragraphs || [])];
  if (!paragraphs.every(p => typeof p === "string" && p.length >= 60 && p.length < 1600)) return false;
  if (count(paragraphs.join(" ")) < 180 || count(paragraphs.join(" ")) > 750) return false;
  if (!a.sections.every(x => typeof x.title === "string" && Array.isArray(x.paragraphs))) return false;
  for (const year of (a.title + paragraphs.join(" ")).match(/\b20\d\d\b/g) || []) {
    if (!source.includes(year)) return false;
  }
  return true;
}
function festivalChanges(f, source, url) {
  if (!f || typeof f.name !== "string" || !Array.isArray(f.lineup) ||
      !Number.isInteger(f.editionYear) || f.editionYear < 2026 || f.editionYear > 2035 ||
      !norm(source).includes(norm(f.name)) || !source.includes(String(f.editionYear))) return [];
  const days = f.lineup.slice(0, 5).map(x => ({
    day: String(x.day || "").slice(0, 70),
    artists: (Array.isArray(x.artists) ? x.artists : []).filter(a => typeof a === "string" &&
      a.length >= 3 && norm(source).includes(norm(a))).slice(0, 20),
  })).filter(x => x.day.length > 4 && x.artists.length);
  if (days.reduce((n,x) => n + x.artists.length, 0) < 2) return [];
  const row = {
    name: f.name, city: String(f.city || "À confirmer").slice(0, 80),
    country: String(f.country || "France").slice(0, 40),
    dates: String(f.dates || "").slice(0, 70),
    editionYear: f.editionYear, genres: "Musique live",
    lineup: days, lineupStatus: "Noms officiellement annoncés", url, code: "FEST",
  };
  return [{ name: row.name, previous: null, new: row }];
}
async function notify(a, id) {
  const to = env("BACKSTAGE_ALERT_EMAIL");
  const from = env("BACKSTAGE_FROM_EMAIL");
  const key = env("RESEND_API_KEY");
  if (!(to && from && key)) return "notification_non_configuree";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json",
        "Idempotency-Key": "backstage-" + id },
      body: JSON.stringify({ to: [to], from,
        subject: "BACKSTAGE — Article à valider : " + a.title.slice(0, 90),
        text: "Nouvel article complet à valider :\n\n" + a.title + "\n\n" +
          site.replace(/\/$/, "") + "/admin/" }),
    });
    return r.ok ? "email_envoye" : "email_echec_HTTP_" + r.status;
  } catch (_) { return "email_echec_reseau"; }
}

const legacyTitles = [
  "We Love Green 2027 premiers noms Fontaines D.C. Angèle",
  "Hellfest 2027 dates billetterie",
  "Oasis Paris 2027 concerts",
  "Toto tournée 2027",
  "Jeanne Added tournée 2027",
  "Khalid Salle Pleyel concert 2026",
];
async function run(key) {
  const pending = await data("editorial_drafts?select=id&status=eq.pending&limit=5", key);
  if (pending.length >= 5) return { result: "cinq_articles_en_attente" };

  // Un seul lancement payant par demi-journée UTC, même si Cron réessaie.
  const now = new Date();
  const slot = now.toISOString().slice(0, 10) +
    (now.getUTCHours() < 12 ? "-matin" : "-soir");
  const lock = await data("editorial_radar_runs?on_conflict=slot", key, "POST",
    [{ slot, status: "running" }], "resolution=ignore-duplicates,return=representation");
  if (!lock.length) return { result: "radar_deja_execute", slot };
  let outcome = "sans_annonce";
  try {
    const recent = await data("editorial_drafts?select=topic_key,title&order=created_at.desc&limit=60", key);
    const existingKeys = new Set(recent.map(x => x.topic_key).filter(Boolean));
    const previousTitles = [...recent.map(x => x.title), ...legacyTitles];
    const discovery = await openai(
      "Tu es rédacteur en chef de BACKSTAGE, média indépendant de musique LIVE, en français. " +
      "Date actuelle UTC : " + now.toISOString().slice(0, 10) + ". " +
      "Utilise une VRAIE recherche Web pour découvrir des annonces publiées dans les 7 derniers jours. " +
      "Choisis jusqu'à TROIS grandes annonces parmi festivals et programmations, rock / post-punk " +
      "et scènes alternatives, tournées majeures, retours de groupes, pop, électro, rap, et société du live. " +
      "Privilégie leur impact éditorial, pas la proximité géographique. " +
      "France et pays voisins bienvenus, mais ne te limite pas à de petits événements locaux. " +
      "Ne propose pas de liste d'agendas génériques, de rumeurs, ni une annonce déjà connue : " +
      JSON.stringify(previousTitles.slice(0, 45)) + ". " +
      "Trouve pour chaque sujet une page de source PRIMAIRE accessible en HTTPS : " +
      "festival, artiste, salle officielle, producteur ou organisateur. " +
      "Fournis deux citations assez longues copiées EXACTEMENT de la page officielle. " +
      "Ne fabrique jamais une citation. Si rien n'est suffisamment confirmé, candidats vides. " +
      "Réponds uniquement par un objet JSON SANS Markdown : " +
      '{"candidates":[{"topic":"Annonce précise de cette semaine",'+
      '"topic_key":"sujet-evenement-annee-cle-stable",'+
      '"why_now":"Ce qui vient réellement d’être annoncé",'+
      '"official_url":"https://site-officiel/page",'+
      '"quotes":["extrait exact assez long de la page","autre extrait exact"],'+
      '"festival_name":"Nom du festival ou chaîne vide"}]}. ' +
      "Maximum trois candidats, du plus intéressant au moins intéressant.",
      true
    );
    if (!Array.isArray(discovery.candidates)) throw Error("Aucun tableau de sujets");
    let chosen = null;
    for (const news of discovery.candidates.slice(0, 3)) {
      if (!news || typeof news.topic !== "string" || news.topic.length < 20 ||
          typeof news.topic_key !== "string" ||
          !/^[a-z0-9-]{12,130}$/.test(news.topic_key) ||
          existingKeys.has(news.topic_key)) continue;
      try {
        const proof = await verify(news);
        if (proof) { chosen = { news, proof }; break; }
      } catch (_) { /* source officielle indisponible : sujet suivant */ }
    }
    if (!chosen) {
      outcome = "aucune_source_officielle_verifiee";
      return { result: outcome };
    }
    const { news, proof } = chosen;
    const article = await openai(
      "Rédige un VRAI article journalistique en français pour BACKSTAGE, " +
      "dans un style vivant et humain, précis, sans publicité, sans copier la source, " +
      "sans citations fabriquées ni expérience de terrain inventée. " +
      "Entre 220 et 480 mots, chapô, paragraphes et intertitres. " +
      "Ne mentionne jamais une date, un prix, une ville ou un artiste qui ne sont pas présents dans la source. " +
      "Sujet : " + news.topic + ". Actualité : " + news.why_now + ". " +
      "Source officielle (seule base factuelle autorisée) : " + proof.url + "\n" +
      proof.source.slice(0, 11000) + "\n" +
      "Retourne un JSON valide et UNIQUEMENT un JSON : " +
      '{"title":"titre précis","excerpt":"chapô complet",'+
      '"category":"FESTIVALS","body":["paragraphe 1","paragraphe 2"],'+
      '"sections":[{"title":"intertitre","paragraphs":["paragraphe 3","paragraphe 4"]}],'+
      '"festival":null}. ' +
      'Pour un concert utiliser category CONCERTS ; pour un enjeu de société utiliser SOCIÉTÉ. ' +
      'Si ET SEULEMENT SI le sujet présente des artistes confirmés d’une même édition de festival, ' +
      'remplacer festival null par ' +
      '{"name":"Nom","city":"Ville","country":"France","dates":"dates annoncées",'+
      '"editionYear":2027,"lineup":[{"day":"Jour et date","artists":["Artiste 1","Artiste 2"]}]}. ' +
      "N'inscris rien d'invérifiable dans le texte ou la fiche festival.",
      false
    );
    if (!articleValid(article, proof.source)) {
      outcome = "article_ecarte_controle_qualite";
      return { result: outcome };
    }
    const hash = await digest(news.topic_key + "|" + proof.url);
    const prose = [...article.body, ...article.sections.flatMap(s => s.paragraphs)].join(" ");
    const row = {
      slug: slug(article.title) + "-" + hash.slice(0, 8),
      title: article.title, excerpt: article.excerpt, category: article.category,
      body: article.body, sections: article.sections,
      date: now.toISOString().slice(0, 10),
      format: article.category === "SOCIÉTÉ" ? "DÉCRYPTAGE" : "ACTUALITÉ",
      readMinutes: Math.max(2, Math.round(count(prose) / 210)),
      visual: "visual-b", artword: "LIVE", byline: "BACKSTAGE · La rédaction",
      sources: [{ label: "Annonce officielle", url: proof.url }],
    };
    const payload = { article: row, previous: null,
      festivals: festivalChanges(article.festival, proof.source, proof.url) };
    const fingerprint = await digest(JSON.stringify(payload));
    const inserted = await data("editorial_drafts?on_conflict=topic_key", key,
      "POST", [{
        fingerprint, topic_key: news.topic_key, slug: row.slug, title: row.title,
        excerpt: row.excerpt, payload, status: "pending",
      }], "resolution=ignore-duplicates,return=representation");
    if (!inserted.length) {
      outcome = "article_deja_propose";
      return { result: outcome };
    }
    const notification = await notify(row, fingerprint);
    outcome = "article_a_valider";
    return { result: outcome, title: row.title, notification };
  } catch (error) {
    outcome = "erreur : " + String(error instanceof Error ? error.message : error).slice(0, 180);
    throw error;
  } finally {
    try {
      await data("editorial_radar_runs?slot=eq." + encodeURIComponent(slot),
        key, "PATCH", { status: outcome.startsWith("erreur") ? "failed" : "completed",
          detail: outcome.slice(0, 440), finished_at: new Date().toISOString() },
        "return=minimal");
    } catch (error) { console.error("Erreur journal du radar", String(error)); }
  }
}
Deno.serve(async request => {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const key = secret();
  if (!key || !allowed(request.headers.get("apikey") || "", key)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!root || !env("OPENAI_API_KEY")) {
    return Response.json({ error: "missing_OPENAI_API_KEY_or_project_URL" }, { status: 503 });
  }
  try {
    const input = await request.json().catch(() => ({}));
    if (input.healthcheck === true) {
      const rows = await data("editorial_drafts?select=id&limit=1", key);
      return Response.json({ ok: true, engine: "supabase-openai", db: Array.isArray(rows) ? "ok" : "error",
        model, email_configured: !!(env("RESEND_API_KEY") && env("BACKSTAGE_FROM_EMAIL") && env("BACKSTAGE_ALERT_EMAIL")) });
    }
    return Response.json(await run(key));
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
    console.error("BACKSTAGE", detail);
    return Response.json({ error: "radar_failed", detail }, { status: 500 });
  }
});
