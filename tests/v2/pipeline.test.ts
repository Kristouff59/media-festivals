// BACKSTAGE v2 — test de bout en bout de la fonction Edge, avec une fausse base
// Supabase en mémoire, un faux Web et un faux OpenAI. Aucun appel réseau réel.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const fx = (n: string) => fs.readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const MA = "https://www.rockwerchter.be/en/news/massive-attack-make-their-return-at-rock-werchter";
const FIXED = Date.parse("2026-11-02T06:15:00Z"); // 7 h 15 à Paris, le jour de l'incident
const realNow = Date.now;

type Row = Record<string, any>;
let loads = 0;
function harness(mode: "shadow" | "live") {
  const tables: Record<string, Row[]> = {
    editorial_radar_runs: [], editorial_ai_logs: [], editorial_leads: [], editorial_drafts: [],
    editorial_feedback: [], editorial_sources: [],
  };
  let openaiCalls = 0, id = 0;
  const web: Record<string, string> = { [MA]: fx("rw-massive-attack.html") };

  const match = (row: Row, params: URLSearchParams) => {
    for (const [k, v] of params) {
      if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
      const [op, ...rest] = v.split(".");
      const val = rest.join(".");
      if (op === "eq" && String(row[k]) !== val) return false;
      if (op === "in" && !val.slice(1, -1).split(",").includes(String(row[k]))) return false;
      if (op === "is" && !((val === "null" && row[k] == null) || (val === "false" && row[k] === false))) return false;
      if (op === "lte" && !(String(row[k]) <= val)) return false;
    }
    return true;
  };

  const fakeFetch = async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith("https://project.supabase.co/rest/v1/")) {
      const u = new URL(url);
      const name = u.pathname.split("/").pop()!;
      const method = init.method || "GET";
      if (name.startsWith("rpc")) return new Response(null, { status: 204 });
      const table = tables[name] ?? (tables[name] = []);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === "GET") {
        let rows = table.filter((r) => match(r, u.searchParams));
        const limit = Number(u.searchParams.get("limit") || 1000);
        rows = rows.slice(0, limit);
        return Response.json(rows);
      }
      if (method === "POST") {
        const conflict = u.searchParams.get("on_conflict")?.split(",") ?? [];
        const inserted: Row[] = [];
        for (const item of body) {
          if (conflict.length && table.some((r) => conflict.every((c) => r[c] === item[c]))) continue;
          const row = { id: "id-" + ++id, attempts: 0, created_at: new Date(FIXED).toISOString(),
            next_attempt_at: new Date(FIXED - 1000).toISOString(), draft_id: null, ...item };
          table.push(row);
          inserted.push(row);
        }
        return Response.json(inserted, { status: 201 });
      }
      if (method === "PATCH") {
        for (const r of table.filter((r) => match(r, u.searchParams))) Object.assign(r, body);
        return new Response(null, { status: 204 });
      }
    }
    if (url === "https://api.openai.com/v1/responses") {
      openaiCalls++;
      const req = JSON.parse(init.body);
      const p = "Massive Attack sont de retour à Rock Werchter, le festival belge qui se tiendra du 1er au 4 juillet 2027 au Festivalpark. Le groupe de Bristol n'y avait plus joué depuis le 27 juin 2003. ";
      const art = { write: true, skip_reason: "", title: "Massive Attack retrouve Rock Werchter en 2027, vingt-quatre ans après",
        excerpt: "Le collectif de Bristol est annoncé pour l'édition 2027 du festival belge, où il n'avait plus joué depuis 2003.",
        category: "FESTIVALS", format: "breve", body: [p.repeat(3), p.repeat(2)],
        sections: [{ title: "Billetterie", paragraphs: ["Les combi-tickets sont en vente depuis le vendredi 30 octobre à 10 h sur le site officiel du festival, qui se tient du 1er au 4 juillet 2027."] }] };
      assert.equal(req.text.format.type, "json_schema");
      return Response.json({ id: "resp", status: "completed", model: "test", usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(art) }] }] });
    }
    if (web[url]) return new Response(web[url], { status: 200, headers: { "content-type": "text/html" } });
    return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  };

  const env: Record<string, string> = {
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_test" }),
    OPENAI_API_KEY: "sk-test", BACKSTAGE_PIPELINE_MODE: mode,
  };
  let handler: (r: Request) => Promise<Response>;
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] }, serve: (h: any) => { handler = h; } };
  (globalThis as any).fetch = fakeFetch;
  Date.now = () => FIXED;
  return {
    tables, web, get openaiCalls() { return openaiCalls; },
    // Chaque test charge sa propre instance de la fonction (le module est mis en cache par URL).
    load: async () => { await import("../../supabase/functions/backstage-pipeline/index.ts?" + mode + "-" + (++loads)); },
    call: async (body: unknown, key = "sb_secret_test") => {
      const r = await handler!(new Request("https://x/functions/v1/backstage-pipeline",
        { method: "POST", headers: { apikey: key }, body: JSON.stringify(body) }));
      return { status: r.status, json: await r.json() };
    },
  };
}

const v18Discovery = JSON.stringify({ candidates: [
  { topic: "Massive Attack annoncé à Rock Werchter 2027", topic_key: "rw-2027-massive-attack", why_now: "Ajout",
    official_url: MA, quotes: [], festival_name: "Rock Werchter", press_url: "", announced_artists: ["Massive Attack"] },
  { topic: "Evanescence au Graspop Metal Meeting 2027", topic_key: "graspop-2027-evanescence-bis", why_now: "Ajout",
    official_url: "https://press.graspop.be/en/evanescence", quotes: [], festival_name: "Graspop Metal Meeting",
    press_url: "", announced_artists: ["Evanescence"] },
] });

test("Mode fantôme : rejoue la découverte v18 du 2 novembre, sans OpenAI ni article", async () => {
  const h = harness("shadow");
  h.tables.editorial_ai_logs.push({ stage: "decouverte", status: "completed", slot: "2026-11-02-matin", response_text: v18Discovery });
  h.tables.editorial_drafts.push({ id: "old", title: "Evanescence rejoint l'affiche du Graspop 2027", excerpt: "",
    status: "published", created_at: "2026-10-25T08:00:00Z", payload: { article: { sources: [] } } });
  await h.load();
  assert.equal((await h.call({}, "mauvaise-cle")).status, 401);
  const res = await h.call({ stage: "tick" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const leads = h.tables.editorial_leads;
  assert.equal(leads.length, 2);
  const ma = leads.find((l) => l.event_name === "Rock Werchter")!;
  assert.equal(ma.status, "verified", ma.rejection_reason);
  assert.equal(ma.publication_date, "2026-10-28");
  assert.equal(ma.date_evidence_type, "sous_le_titre");
  assert.equal(ma.shadow, true);
  const eva = leads.find((l) => l.event_name === "Graspop Metal Meeting")!;
  // Déjà publié avant la v2 : classé doublon AVANT tout téléchargement.
  assert.equal(eva.status, "duplicate");
  assert.equal(eva.story_verdict.of, "Evanescence rejoint l'affiche du Graspop 2027");
  assert.equal(h.openaiCalls, 0, "le mode fantôme ne coûte rien");
  assert.equal(h.tables.editorial_drafts.length, 1, "aucun article créé en mode fantôme");
  // Un second passage ne reprend pas la découverte (verrou du créneau).
  await h.call({ stage: "tick" });
  assert.equal(h.tables.editorial_leads.length, 2);
  Date.now = realNow;
});

test("Mode réel : la piste vérifiée devient UN article pending, avec preuves et relecture", async () => {
  const h = harness("live");
  await h.load();
  h.tables.editorial_leads.push({
    id: "lead-1", status: "verified", shadow: false, draft_id: null, attempts: 1, priority: 80,
    title: "Massive Attack annoncé à Rock Werchter 2027", official_url: MA, event_name: "Rock Werchter",
    edition: 2027, kind: "lineup", artists: ["Massive Attack"], places: [], story_key: "rock werchter|2027|lineup|massive attack",
    publication_date: "2026-10-28", date_evidence_type: "sous_le_titre", date_evidence_url: MA,
    source_text: fx("rw-massive-attack.html"), verification: { final_url: MA, corroborating_sources: [] },
    next_attempt_at: new Date(FIXED + 86400000).toISOString(),
  });
  h.tables.editorial_radar_runs.push({ slot: "v2-2026-11-02-matin" }); // découverte déjà faite
  const res = await h.call({ stage: "tick" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(h.openaiCalls, 1, "une rédaction, un appel");
  const draft = h.tables.editorial_drafts[0];
  assert.equal(draft.status, "pending");
  assert.equal(draft.payload.article.sources[0].url, MA);
  assert.ok(Array.isArray(draft.quality.warnings));
  assert.equal(draft.quality.verification.date_evidence_type, "sous_le_titre");
  assert.equal(h.tables.editorial_leads[0].status, "written");
  assert.equal(h.tables.editorial_leads[0].draft_id, draft.id);
  Date.now = realNow;
});

test("Mode réel : une piste déjà couverte par un article publié n'est pas rédigée (aucun appel OpenAI)", async () => {
  const h = harness("live");
  await h.load();
  h.tables.editorial_drafts.push({ id: "d-hell", title: "Helloween complète l'affiche des têtes d'affiche de Graspop Metal Meeting 2027",
    excerpt: "", status: "pending", created_at: "2026-11-05T17:00:00Z", payload: { article: { sources: [] } } });
  h.tables.editorial_leads.push({
    id: "lead-h", status: "verified", shadow: false, draft_id: null, attempts: 1, priority: 80,
    title: "Graspop Metal Meeting révèle Helloween comme dernière tête d'affiche de GMM 2027",
    official_url: "https://press.graspop.be/la-derniere-tete-daffiche-du-gmm-2027", event_name: "Graspop Metal Meeting",
    edition: 2027, kind: "lineup", artists: ["Helloween"], places: [], publication_date: "2026-11-01",
    source_text: "Helloween au Graspop Metal Meeting 2027.", verification: { corroborating_sources: [] },
    next_attempt_at: new Date(FIXED + 86400000).toISOString(),
  });
  h.tables.editorial_radar_runs.push({ slot: "v2-2026-11-02-matin" });
  const res = await h.call({ stage: "tick" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(h.openaiCalls, 0);
  assert.equal(h.tables.editorial_leads[0].status, "duplicate");
  assert.equal(h.tables.editorial_drafts.length, 1);
  Date.now = realNow;
});
