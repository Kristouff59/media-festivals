// Serveur HTTP : API JSON, temps réel (Server-Sent Events), fichiers statiques.
// Chaque commande passe par : authentification → contrôle d'autorisation →
// verrou du tournoi → contrôle de version / idempotence → moteur métier →
// écriture atomique + journal → diffusion aux clients connectés.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TournamentStore } from './store.js';
import { Auth, httpError } from './auth.js';
import { applyCommand, createTournament } from '../engine/tournament.js';
import { DomainError } from '../engine/errors.js';
import { buildView, redactFor } from '../engine/view.js';
import { canExecute, atLeast, roleLevel } from '../engine/permissions.js';
import { PRESETS, defaultConfig, validateConfig } from '../engine/config.js';
import { computeStats } from '../engine/stats.js';
import { simulateResult, fakeParticipants } from '../engine/simulate.js';
import { createRng } from '../engine/rng.js';
import * as X from './exports.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

export function createApp({ dataDir = path.join(ROOT, 'data'), log = true } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const auth = new Auth(dataDir);
  const stores = { real: new TournamentStore(path.join(dataDir, 'real')), demo: new TournamentStore(path.join(dataDir, 'demo')) };
  const clients = new Map(); // tournamentId -> Set<{res, role}>

  const findStore = (id) => (stores.real.get(id) ? stores.real : stores.demo.get(id) ? stores.demo : null);
  const getTournament = (id) => {
    const st = findStore(id);
    if (!st) throw httpError(404, 'Tournoi introuvable.');
    return { store: st, state: st.get(id) };
  };
  const bySpectatorToken = (token) => {
    for (const st of Object.values(stores)) for (const t of st.list()) if (token && t.share?.spectatorToken === token) return { store: st, state: t };
    throw httpError(404, 'Lien de partage invalide ou expiré.');
  };
  const byRegistrationToken = (token) => {
    for (const st of Object.values(stores)) for (const t of st.list()) if (token && t.share?.registrationToken === token) return { store: st, state: t };
    throw httpError(404, 'Lien d\'inscription invalide.');
  };

  function memberOf(state, user) {
    // Sans compte, l'accès se fait UNIQUEMENT par le jeton de partage (routes /api/public).
    if (!user) return null;
    const m = state.members.find((x) => x.userId === user.id);
    if (user.globalRole === 'superadmin' && (!m || roleLevel(m.role) < roleLevel('admin'))) return { ...(m || {}), userId: user.id, role: 'admin' };
    return m || null;
  }
  function requireMember(state, user, min = 'spectator') {
    const m = memberOf(state, user);
    if (!m || (!user && min !== 'spectator')) throw httpError(user ? 403 : 401, user ? 'Vous n\'avez pas accès à ce tournoi.' : 'Connexion requise.');
    if (!atLeast(m.role, min)) throw httpError(403, 'Droits insuffisants pour cette action.');
    return m;
  }

  function broadcast(id, payload) {
    const set = clients.get(id);
    if (!set) return;
    const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of set) c.res.write(data);
  }

  async function execute(id, user, command, { expectedVersion, commandId, member: forcedMember, now } = {}) {
    const { store } = getTournament(id);
    return store.lock(id).run(() => {
      const state = store.get(id);
      if (commandId && state.recentCommands?.some((c) => c.id === commandId)) {
        const prev = state.recentCommands.find((c) => c.id === commandId);
        return { duplicate: true, version: state.version, summary: prev.summary, result: prev.result || {} };
      }
      if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== state.version)
        throw httpError(409, 'Le tournoi a été modifié par un autre utilisateur entre-temps. Les données ont été rechargées : vérifier puis recommencer.', { currentVersion: state.version });
      const member = forcedMember || memberOf(state, user);
      if (!member) throw httpError(user ? 403 : 401, 'Vous n\'avez pas accès à ce tournoi.');
      const perm = canExecute(member, command, state);
      if (!perm.ok) throw httpError(403, perm.reason);
      if (command.type === 'demo.simulate') throw httpError(400, 'Utiliser la route de simulation.');
      const t = now ?? Date.now();
      const r = applyCommand(state, command, { now: t, userId: user?.id || null, canValidate: atLeast(member.role, 'referee') });
      r.state.recentCommands = [...(state.recentCommands || []).slice(-199), { id: commandId || crypto.randomUUID(), summary: r.summary, result: r.result }];
      store.save(r.state);
      store.appendLog(id, { at: t, version: r.state.version, userId: user?.id || null, user: user?.name || (forcedMember ? 'Inscription publique' : null), role: member.role, type: command.type, payload: sanitizePayload(command.payload), summary: r.summary, events: r.events });
      broadcast(id, { version: r.state.version, summary: r.summary });
      return { version: r.state.version, summary: r.summary, events: r.events, result: r.result };
    });
  }

  function sanitizePayload(p) {
    if (!p) return p;
    const s = JSON.stringify(p);
    return s.length > 20000 ? { truncated: true } : p;
  }

  async function createNew({ user, name, config, demo = false, targets = 4, participants = [], seed, demoParams }) {
    const store = demo ? stores.demo : stores.real;
    const id = `${demo ? 'demo' : 't'}_${crypto.randomBytes(6).toString('hex')}`;
    let state = createTournament({ id, name, config, ownerId: user.id, demo, targets, seed });
    state.members[0].label = user.name;
    if (demoParams) state.demoParams = demoParams;
    const ctx = { now: Date.now(), userId: user.id, canValidate: true };
    for (const p of participants) state = applyCommand(state, { type: 'participant.add', payload: p }, ctx).state;
    state.version = 1;
    store.save(state);
    store.appendLog(id, { at: Date.now(), version: 1, userId: user.id, user: user.name, type: 'tournament.create', summary: `Création du tournoi « ${state.name} »${demo ? ' (démonstration)' : ''}.` });
    return state;
  }

  // ------------------------------------------------------------- démonstration
  async function buildDemo(user, params, existingId = null) {
    const preset = PRESETS[params.preset] ? params.preset : 'reference';
    const config = PRESETS[preset].build();
    if (params.game) config.phases.forEach((p) => { p.game = params.game; });
    const count = Math.max(2, Math.min(128, Number(params.count) || config.maxParticipants || 8));
    if (config.maxParticipants && count > config.maxParticipants) config.maxParticipants = count;
    if (config.phases[0].type === 'pools' && params.poolCount) config.phases[0].poolCount = Number(params.poolCount);
    const rng = createRng(`demo:${Date.now()}`);
    const fakes = fakeParticipants(count, { mode: config.mode, teamSize: config.teamSize, rng }).map((p) => ({ ...p, status: 'confirmed', allowDuplicate: true }));
    const state = await createNew({ user, name: params.name || `Démo — ${PRESETS[preset].label}`, config, demo: true, targets: Number(params.targets) || 4, participants: fakes, demoParams: params });
    if (existingId) {
      stores.demo.delete(existingId);
    }
    return state;
  }

  async function simulate(id, user, scope) {
    const { state } = getTournament(id);
    if (!state.demo) throw httpError(400, 'La simulation est réservée aux tournois de démonstration.');
    requireMember(state, user, 'organizer');
    const rng = createRng(`sim:${id}:${state.version}`);
    let steps = 0;
    const max = scope === 'all' ? 2000 : 200;
    const run = (type, payload) => execute(id, user, { type, payload }, { now: Date.now() + steps * 1000 });
    const cur = () => stores.demo.get(id);
    // Préparation automatique si nécessaire (mêmes commandes qu'un organisateur).
    if (cur().registrationOpen) await run('registration.close', {});
    const ph0 = cur().phases[0];
    const cfg0 = cur().config.phases[0];
    if (ph0.status === 'pending') await run(cfg0.type === 'pools' ? 'pools.draw' : 'phase.generateKnockout', {});
    if (cur().phases[0].status === 'draft') await run('pools.validate', {});
    if (['draft', 'ready'].includes(cur().status)) await run('tournament.start', {});
    if (cur().status === 'paused') await run('tournament.resume', {});
    let played = 0;
    const snapshot = new Set(cur().matches.filter((x) => ['called', 'playing', 'suspended'].includes(x.status)).map((x) => x.id));
    const phaseIdx = cur().phases.findIndex((p) => p.status === 'active');
    while (steps++ < max && cur().status === 'running') {
      const s = cur();
      const pending = s.matches.find((m) => m.status === 'awaiting_validation');
      if (pending) { await run('match.validateResult', { matchId: pending.id }); continue; }
      const ph = s.phases.find((p) => p.awaitingDecision?.type === 'ties');
      if (ph) {
        for (const t of ph.awaitingDecision.ties) await run('phase.resolveTie', { phaseId: ph.id, poolId: t.poolId, method: 'lot' });
        continue;
      }
      if (scope === 'ready' && ![...snapshot].some((id) => s.matches.find((x) => x.id === id && ['called', 'playing', 'suspended'].includes(x.status)))) break;
      if (scope === 'phase' && phaseIdx >= 0 && s.phases[phaseIdx].status === 'completed') break;
      const pool = s.matches.filter((x) => ['called', 'playing'].includes(x.status) || (x.status === 'suspended' && x.targetId));
      const m = (scope === 'ready' ? pool.find((x) => snapshot.has(x.id)) : null) || pool[0];
      if (!m) break;
      if (m.status === 'suspended') { await run('match.resume', { matchId: m.id }); continue; }
      if (m.status === 'called') await run('match.start', { matchId: m.id });
      await run('match.submitResult', { matchId: m.id, result: simulateResult(m.rules, rng) });
      played++;
      if (scope === 'next') break;
    }
    return { played, status: cur().status };
  }

  // --------------------------------------------------------------- utilitaires
  function readBody(req, limit = 3 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(httpError(413, 'Requête trop volumineuse.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { reject(httpError(400, 'JSON invalide.')); }
      });
      req.on('error', reject);
    });
  }
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  }
  function currentUser(req) {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : cookies(req).session;
    return { user: auth.userForToken(token), token };
  }
  function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders, ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  }
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  };
  function download(res, filename, contentType, body) {
    send(res, 200, body, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"` });
  }
  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    let base = path.join(ROOT, 'public');
    if (rel.startsWith('/engine/')) { base = path.join(ROOT, 'src/engine'); rel = rel.slice('/engine'.length); }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Introuvable');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...securityHeaders });
    fs.createReadStream(file).pipe(res);
  }
  function summaryOf(t, user) {
    const m = memberOf(t, user);
    return { id: t.id, name: t.name, status: t.status, demo: t.demo, createdAt: t.createdAt, updatedAt: t.updatedAt, role: m?.role, participants: t.participants.length, mode: t.config.mode, winner: t.finalRanking?.find((e) => e.position === 1)?.name || null };
  }
  function lanAddresses(port) {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    return out;
  }

  // ------------------------------------------------------------------ routes
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/api/health', () => ({ ok: true }));
  route('GET', '/api/server-info', ({ req }) => ({ lan: lanAddresses(req.socket.localPort), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.label])) }));
  route('GET', '/api/presets/:key', ({ params }) => {
    const p = PRESETS[params.key];
    if (!p) throw httpError(404, 'Préréglage inconnu.');
    return p.build();
  });

  // Comptes
  route('POST', '/api/auth/register', async ({ body, res, req }) => {
    auth.register(body);
    const { token, user } = auth.login(body, req.socket.remoteAddress);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
    return { user: auth.publicUser(user) };
  });
  route('POST', '/api/auth/login', async ({ body, res, req }) => {
    const { token, user } = auth.login(body, req.socket.remoteAddress);
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
    return { user: auth.publicUser(user) };
  });
  route('POST', '/api/auth/logout', ({ token, res }) => {
    if (token) auth.logout(token);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });
  route('GET', '/api/auth/me', ({ user }) => ({ user: auth.publicUser(user) }));
  route('POST', '/api/auth/password', ({ user, body }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    auth.changePassword(user.id, body.oldPassword, body.newPassword);
    return { ok: true };
  });
  route('GET', '/api/me/export', ({ user }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const memberships = [];
    const registrations = [];
    for (const st of Object.values(stores)) for (const t of st.list()) {
      const m = t.members.find((x) => x.userId === user.id);
      if (m) memberships.push({ tournamentId: t.id, tournament: t.name, role: m.role });
      for (const p of t.participants) if (p.contact?.email && p.contact.email.toLowerCase() === user.email) registrations.push({ tournamentId: t.id, tournament: t.name, participant: p.name, players: p.players.map((x) => x.name), contact: p.contact });
    }
    return { exportedAt: new Date().toISOString(), account: auth.publicUser(user), memberships, registrations };
  });
  route('DELETE', '/api/me', ({ user, res }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const owned = stores.real.list().filter((t) => t.members.some((m) => m.userId === user.id && m.role === 'owner'));
    if (owned.length) throw httpError(409, `Vous êtes propriétaire de ${owned.length} tournoi(s) : les supprimer ou en transférer la propriété avant de supprimer votre compte.`, owned.map((t) => t.name));
    for (const st of Object.values(stores)) for (const t of st.list()) {
      if (!t.members.some((m) => m.userId === user.id)) continue;
      st.save({ ...t, members: t.members.filter((m) => m.userId !== user.id) });
    }
    for (const t of stores.demo.list()) if (t.members.some((m) => m.userId === user.id && m.role === 'owner')) stores.demo.delete(t.id);
    auth.deleteUser(user.id);
    res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  // Tournois
  route('GET', '/api/tournaments', ({ user, query }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const st = query.get('demo') === '1' ? stores.demo : stores.real;
    return st.list().filter((t) => memberOf(t, user) && (user.globalRole === 'superadmin' || t.members.some((m) => m.userId === user.id))).map((t) => summaryOf(t, user)).sort((a, b) => b.updatedAt - a.updatedAt);
  });
  route('POST', '/api/tournaments', async ({ user, body }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    let config = body.config;
    if (!config && body.preset) config = PRESETS[body.preset]?.build();
    if (!config && body.fromTournamentId) {
      const { state } = getTournament(body.fromTournamentId);
      requireMember(state, user, 'organizer');
      config = structuredClone(state.config);
    }
    config = config || defaultConfig();
    const { errors } = validateConfig(config);
    if (errors.length) throw httpError(422, 'Configuration incohérente.', errors);
    const t = await createNew({ user, name: body.name, config, targets: Number(body.targets) || 4 });
    return summaryOf(t, user);
  });
  route('POST', '/api/tournaments/import', async ({ user, body }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const src = body?.data?.tournament;
    if (body?.data?.format !== 'flechettes-tournoi' || !src?.config || !Array.isArray(src.participants) || !Array.isArray(src.matches)) throw httpError(400, 'Fichier d\'export non reconnu.');
    const { errors } = validateConfig(src.config);
    if (errors.length) throw httpError(422, 'Configuration du fichier incohérente.', errors);
    const id = `t_${crypto.randomBytes(6).toString('hex')}`;
    const state = { ...structuredClone(src), id, demo: false, members: [{ userId: user.id, role: 'owner', targetIds: [], label: user.name }], recentCommands: [], name: body.name || `${src.name} (importé)` };
    state.share = { spectatorToken: crypto.randomBytes(9).toString('hex'), registrationToken: crypto.randomBytes(9).toString('hex') };
    stores.real.save(state);
    stores.real.appendLog(id, { at: Date.now(), version: state.version, userId: user.id, user: user.name, type: 'tournament.import', summary: `Import du tournoi « ${src.name} ».` });
    return summaryOf(state, user);
  });
  route('GET', '/api/tournaments/:id', ({ user, params }) => {
    const { state } = getTournament(params.id);
    const m = requireMember(state, user);
    return buildView(state, m.role);
  });
  route('DELETE', '/api/tournaments/:id', ({ user, params }) => {
    const { store, state } = getTournament(params.id);
    const m = requireMember(state, user, 'owner');
    void m;
    store.delete(state.id);
    broadcast(state.id, { deleted: true });
    return { ok: true };
  });
  route('POST', '/api/tournaments/:id/commands', async ({ user, params, body }) => {
    const { state } = getTournament(params.id);
    requireMember(state, user);
    const r = await execute(params.id, user, { type: body.type, payload: body.payload || {} }, { expectedVersion: body.expectedVersion, commandId: body.commandId });
    return r;
  });
  route('POST', '/api/tournaments/:id/duplicate', async ({ user, params, body }) => {
    const { state } = getTournament(params.id);
    requireMember(state, user, 'organizer');
    const participants = body.withParticipants ? state.participants.filter((p) => !['withdrawn', 'disqualified'].includes(p.status)).map((p) => ({ name: p.name, players: p.players.map((x) => x.name), seed: p.seed, contact: p.contact, allowDuplicate: true })) : [];
    const t = await createNew({ user, name: body.name || `${state.name} (copie)`, config: structuredClone(state.config), demo: state.demo, targets: state.targets.length, participants });
    // Noms des cibles conservés.
    t.targets = state.targets.map((x) => ({ ...x, status: 'available', note: '' }));
    (state.demo ? stores.demo : stores.real).save(t);
    return summaryOf(t, user);
  });
  route('POST', '/api/tournaments/:id/members', async ({ user, params, body }) => {
    const { state } = getTournament(params.id);
    requireMember(state, user, 'admin');
    const target = auth.findByEmail(body.email);
    if (!target) throw httpError(404, 'Aucun compte avec cette adresse : la personne doit d\'abord créer un compte.');
    return execute(params.id, user, { type: 'members.set', payload: { userId: target.id, role: body.role, targetIds: body.targetIds || [], participantId: body.participantId || null, label: `${target.name} <${target.email}>` } });
  });
  route('GET', '/api/tournaments/:id/audit', ({ user, params, query }) => {
    const { store, state } = getTournament(params.id);
    requireMember(state, user, 'organizer');
    return store.readLog(state.id, Number(query.get('limit')) || 1000).reverse();
  });
  route('GET', '/api/tournaments/:id/export/:file', ({ user, params, res, query }) => {
    const { state } = getTournament(params.id);
    const m = requireMember(state, user);
    return exportFile(res, state, m.role, params.file, query);
  });
  route('POST', '/api/tournaments/:id/demo/simulate', async ({ user, params, body }) => simulate(params.id, user, body.scope || 'ready'));
  route('POST', '/api/tournaments/:id/demo/reset', async ({ user, params }) => {
    const { state } = getTournament(params.id);
    if (!state.demo) throw httpError(400, 'Réservé aux tournois de démonstration.');
    requireMember(state, user, 'organizer');
    const t = await buildDemo(user, state.demoParams || {}, state.id);
    broadcast(state.id, { deleted: true, replacedBy: t.id });
    return summaryOf(t, user);
  });
  route('POST', '/api/demo', async ({ user, body }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const t = await buildDemo(user, body || {});
    return summaryOf(t, user);
  });

  route('GET', '/api/stats', ({ user }) => {
    if (!user) throw httpError(401, 'Connexion requise.');
    const list = stores.real.list().filter((t) => memberOf(t, user) && (user.globalRole === 'superadmin' || t.members.some((m) => m.userId === user.id)));
    const done = list.filter((t) => ['finished', 'archived'].includes(t.status));
    const s = computeStats(done);
    s.totals.tournaments = list.length;
    return s;
  });

  // Accès public (spectateurs, inscriptions)
  route('GET', '/api/public/:token', ({ params }) => {
    const { state } = bySpectatorToken(params.token);
    return buildView(state, 'spectator');
  });
  route('GET', '/api/public/:token/export/:file', ({ params, res, query }) => {
    const { state } = bySpectatorToken(params.token);
    return exportFile(res, state, 'spectator', params.file, query);
  });
  route('GET', '/api/register/:token', ({ params }) => {
    const { state } = byRegistrationToken(params.token);
    return { name: state.name, mode: state.config.mode, teamSize: state.config.teamSize, open: state.registrationOpen && !!state.config.publicRegistration && !['running', 'paused', 'finished', 'archived'].includes(state.status), count: state.participants.length, max: state.config.maxParticipants };
  });
  route('POST', '/api/register/:token', async ({ params, body, req }) => {
    const { state } = byRegistrationToken(params.token);
    rateLimit(req.socket.remoteAddress);
    const payload = { name: body.name, players: body.players, contact: { email: body.email, phone: body.phone }, source: 'public' };
    const r = await execute(state.id, null, { type: 'participant.add', payload }, { member: { role: 'organizer' }, commandId: body.commandId });
    return { ok: true, summary: r.summary };
  });

  const regHits = new Map();
  function rateLimit(ip) {
    const now = Date.now();
    const list = (regHits.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= 10) throw httpError(429, 'Trop de demandes : patienter une minute.');
    list.push(now);
    regHits.set(ip, list);
  }

  function exportFile(res, state, role, file, query) {
    const base = state.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').slice(0, 40);
    const safe = redactFor(state, role);
    const organizer = atLeast(role, 'organizer');
    switch (file) {
      case 'participants.csv': return download(res, `${base}_participants.csv`, 'text/csv; charset=utf-8', X.participantsCsv(safe, { withContact: organizer && query.get('contact') === '1' }));
      case 'participants.json': return download(res, `${base}_participants.json`, 'application/json', JSON.stringify(safe.participants, null, 2));
      case 'calendrier.csv': return download(res, `${base}_calendrier.csv`, 'text/csv; charset=utf-8', X.scheduleCsv(safe));
      case 'resultats.csv': return download(res, `${base}_resultats.csv`, 'text/csv; charset=utf-8', X.resultsCsv(safe));
      case 'classements.csv': return download(res, `${base}_classements.csv`, 'text/csv; charset=utf-8', X.standingsCsv(safe));
      case 'tableau.csv': return download(res, `${base}_tableau.csv`, 'text/csv; charset=utf-8', X.bracketCsv(safe));
      case 'tournoi.json':
        if (!organizer) throw httpError(403, 'Export complet réservé aux organisateurs.');
        return download(res, `${base}_tournoi.json`, 'application/json', JSON.stringify(X.fullJson(state), null, 2));
      case 'rapport.pdf': return download(res, `${base}_rapport.pdf`, 'application/pdf', X.reportPdf(safe));
      case 'feuilles.pdf': {
        const ids = query.get('matches') ? query.get('matches').split(',') : null;
        return download(res, `${base}_feuilles_de_match.pdf`, 'application/pdf', X.matchSheetsPdf(safe, ids));
      }
      default: throw httpError(404, 'Export inconnu.');
    }
  }

  function sse(req, res, state, role) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: state.version })}\n\n`);
    const c = { res, role };
    if (!clients.has(state.id)) clients.set(state.id, new Set());
    clients.get(state.id).add(c);
    const hb = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(hb); clients.get(state.id)?.delete(c); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const started = Date.now();
    try {
      if (req.method === 'GET' && /^\/api\/(tournaments|public)\/[^/]+\/stream$/.test(url.pathname)) {
        const [, kind, key] = url.pathname.split('/').slice(1);
        if (kind === 'public') { const { state } = bySpectatorToken(key); return sse(req, res, state, 'spectator'); }
        const { state } = getTournament(key);
        const m = requireMember(state, currentUser(req).user);
        return sse(req, res, state, m.role);
      }
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw httpError(404, 'Route inconnue.');
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers['content-type'] && !req.headers['content-type'].includes('application/json'))
        throw httpError(415, 'Contenu JSON attendu.');
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const { user, token } = currentUser(req);
      const params = url.pathname.match(r.re).groups || {};
      const out = await r.handler({ req, res, body, user, token, params, query: url.searchParams });
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof DomainError) send(res, 422, { error: e.message, code: e.code, details: e.details });
      else if (e.status) send(res, e.status, { error: e.message, details: e.details });
      else {
        console.error(e);
        send(res, 500, { error: 'Erreur interne du serveur.' });
      }
    } finally {
      if (log && url.pathname.startsWith('/api/') && !url.pathname.endsWith('/stream')) console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  return { server, auth, stores, execute };
}
