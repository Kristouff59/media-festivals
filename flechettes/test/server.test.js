import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import { participantsFromCsv, parseCsv } from '../src/engine/csv.js';

async function start(dataDir) {
  const app = createApp({ dataDir, log: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => new Promise((r) => { app.server.closeAllConnections?.(); app.server.close(r); }) };
}

function client(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, cmd: (id, type, payload = {}, extra = {}) => call('POST', `/api/tournaments/${id}/commands`, { type, payload, ...extra }) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flechettes-'));

test('API : parcours, autorisations, conflits, idempotence, temps réel, persistance', async () => {
  const dir = tmp();
  let srv = await start(dir);
  const owner = client(srv.base);
  const ref = client(srv.base);
  const anon = client(srv.base);
  assert.equal((await owner.call('POST', '/api/auth/register', { email: 'owner@x.fr', password: 'motdepasse1', name: 'Owner' })).status, 200);
  assert.equal((await ref.call('POST', '/api/auth/register', { email: 'ref@x.fr', password: 'motdepasse2', name: 'Arbitre' })).status, 200);
  assert.equal((await owner.call('POST', '/api/auth/register', { email: 'owner@x.fr', password: 'motdepasse1' })).status, 409, 'doublon de compte');
  assert.equal((await anon.call('GET', '/api/tournaments')).status, 401);

  const t = (await owner.call('POST', '/api/tournaments', { name: 'Open du club', preset: 'reference', targets: 4 })).data;
  assert.ok(t.id.startsWith('t_'));
  // L'arbitre n'est pas membre : accès refusé
  assert.equal((await ref.call('GET', `/api/tournaments/${t.id}`)).status, 403);
  assert.equal((await owner.call('POST', `/api/tournaments/${t.id}/members`, { email: 'ref@x.fr', role: 'referee' })).status, 200);
  assert.equal((await ref.cmd(t.id, 'participant.add', { name: 'X', players: ['a', 'b'] })).status, 403, 'un arbitre ne gère pas les inscriptions');

  const rows = participantsFromCsv('nom;joueur1;joueur2;email\n' + Array.from({ length: 8 }, (_, i) => `Équipe ${i + 1};J${i}a;J${i}b;e${i}@x.fr`).join('\n'), { mode: 'team', teamSize: 2 });
  assert.equal(rows.length, 8);
  const imp = await owner.cmd(t.id, 'participant.import', { rows });
  assert.equal(imp.data.result.added, 8);

  // Idempotence : la même commande rejouée (coupure réseau) n'est appliquée qu'une fois
  let view = (await owner.call('GET', `/api/tournaments/${t.id}`)).data;
  const pid = view.tournament.participants[0].id;
  const r1 = await owner.cmd(t.id, 'participant.setPresence', { id: pid, presence: 'confirmed' }, { commandId: 'abc-1' });
  const r2 = await owner.cmd(t.id, 'participant.setPresence', { id: pid, presence: 'confirmed' }, { commandId: 'abc-1' });
  assert.equal(r2.data.duplicate, true);
  assert.equal(r2.data.version, r1.data.version);
  // Conflit de modification simultanée
  const stale = await owner.cmd(t.id, 'tournament.update', { name: 'Nouveau nom' }, { expectedVersion: r1.data.version - 1 });
  assert.equal(stale.status, 409);

  // Spectateur : lien public sans données personnelles et sans écriture
  view = (await owner.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.ok(view.tournament.participants[0].contact.email, 'l\'organisateur voit les contacts');
  const token = view.tournament.share.spectatorToken;
  const pub = (await anon.call('GET', `/api/public/${token}`)).data;
  assert.equal(pub.role, 'spectator');
  assert.equal(pub.tournament.participants[0].contact, undefined, 'contacts masqués aux spectateurs');
  assert.equal(pub.tournament.share.spectatorToken, undefined);
  assert.equal((await anon.cmd(t.id, 'registration.close')).status, 401);
  const refView = (await ref.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.equal(refView.tournament.participants[0].contact, undefined, 'contacts masqués à l\'arbitre');

  // Temps réel : un spectateur connecté reçoit la mise à jour
  const ctrl = new AbortController();
  const sse = await fetch(`${srv.base}/api/public/${token}/stream`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const got = (async () => { let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) return buf; buf += new TextDecoder().decode(value); if (buf.includes('event: update')) return buf; } })();
  for (const p of view.tournament.participants) await owner.cmd(t.id, 'participant.setPresence', { id: p.id, presence: 'confirmed' });
  const buf = await got;
  assert.match(buf, /event: update/);
  ctrl.abort();

  await owner.cmd(t.id, 'registration.close');
  await owner.cmd(t.id, 'pools.draw', { seed: 'srv' });
  await owner.cmd(t.id, 'pools.validate');
  const st = await owner.cmd(t.id, 'tournament.start');
  assert.equal(st.status, 200);
  view = (await owner.call('GET', `/api/tournaments/${t.id}`)).data;
  const called = view.tournament.matches.filter((m) => m.status === 'called');
  assert.equal(called.length, 4);
  // L'arbitre saisit et valide directement
  const m = called[0];
  assert.equal((await ref.cmd(t.id, 'match.start', { matchId: m.id })).status, 200);
  const res = await ref.cmd(t.id, 'match.submitResult', { matchId: m.id, result: { legs: [{ endedBy: 'closed', winner: 'a', pointsA: 30, pointsB: 10, closedA: true }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const bad = await ref.cmd(t.id, 'match.submitResult', { matchId: m.id, result: { legs: [] } });
  assert.equal(bad.status, 422);
  assert.equal((await ref.cmd(t.id, 'match.correctResult', { matchId: m.id, result: { outcome: 'forfeit', loser: 'a' } })).status, 403, 'correction réservée aux organisateurs');
  // Responsable de cible : limité à sa cible, saisie soumise à validation
  const tm = client(srv.base);
  await tm.call('POST', '/api/auth/register', { email: 'tm@x.fr', password: 'motdepasse3' });
  const m2 = called[1];
  await owner.call('POST', `/api/tournaments/${t.id}/members`, { email: 'tm@x.fr', role: 'targetManager', targetIds: [m2.targetId] });
  assert.equal((await tm.cmd(t.id, 'match.start', { matchId: called[2].id })).status, 403);
  assert.equal((await tm.cmd(t.id, 'match.start', { matchId: m2.id })).status, 200);
  await tm.cmd(t.id, 'match.submitResult', { matchId: m2.id, result: { legs: [{ endedBy: 'closed', winner: 'b', pointsA: 0, pointsB: 5, closedB: true }] } });
  view = (await owner.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.equal(view.tournament.matches.find((x) => x.id === m2.id).status, 'awaiting_validation');
  assert.ok(view.derived.alerts.some((a) => a.type === 'validation'));
  assert.equal((await ref.cmd(t.id, 'match.validateResult', { matchId: m2.id })).status, 200);

  // Exports
  for (const f of ['rapport.pdf', 'feuilles.pdf', 'classements.csv', 'resultats.csv', 'calendrier.csv', 'tableau.csv', 'participants.csv', 'tournoi.json']) {
    const r = await fetch(`${srv.base}/api/tournaments/${t.id}/export/${f}`, { headers: { Cookie: '' } });
    assert.equal(r.status, 401, `${f} protégé`);
  }
  const pdf = await fetch(`${srv.base}/api/public/${token}/export/rapport.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await fetch(`${srv.base}/api/public/${token}/export/tournoi.json`)).status, 403, 'sauvegarde complète réservée');
  const csv = await (await fetch(`${srv.base}/api/public/${token}/export/participants.csv`)).text();
  assert.ok(!csv.includes('@x.fr'), 'pas de coordonnées dans l\'export public');
  const versionBefore = view.tournament.version;

  // Reprise après interruption du serveur : l'état est rechargé depuis le disque
  await srv.close();
  srv = await start(dir);
  const again = client(srv.base);
  await again.call('POST', '/api/auth/login', { email: 'owner@x.fr', password: 'motdepasse1' });
  const v2 = (await again.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.ok(v2.tournament.version >= versionBefore);
  assert.equal(v2.tournament.matches.filter((x) => x.status === 'finished').length, 2);
  // Fichier principal corrompu (coupure pendant une écriture) : repli sur la copie de sécurité
  await srv.close();
  const file = path.join(dir, 'real', 'tournaments', `${t.id}.json`);
  fs.writeFileSync(file, '{"corrompu":');
  srv = await start(dir);
  const c3 = client(srv.base);
  await c3.call('POST', '/api/auth/login', { email: 'owner@x.fr', password: 'motdepasse1' });
  const v3 = (await c3.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.equal(v3.tournament.id, t.id);
  // Journal des actions
  const audit = (await c3.call('GET', `/api/tournaments/${t.id}/audit`)).data;
  assert.ok(audit.length > 20);
  assert.ok(audit.some((e) => e.user === 'Arbitre' && e.type === 'match.submitResult'));
  // Sauvegarde → restauration (changement d'appareil)
  const full = (await c3.call('GET', `/api/tournaments/${t.id}/export/tournoi.json`)).data;
  const restored = (await c3.call('POST', '/api/tournaments/import', { data: full })).data;
  assert.notEqual(restored.id, t.id);
  const rv = (await c3.call('GET', `/api/tournaments/${restored.id}`)).data;
  assert.equal(rv.tournament.matches.length, v3.tournament.matches.length);
  await srv.close();
});

test('API : démonstration isolée, simulation complète, statistiques réelles uniquement', async () => {
  const dir = tmp();
  const srv = await start(dir);
  const c = client(srv.base);
  await c.call('POST', '/api/auth/register', { email: 'd@x.fr', password: 'motdepasse1' });
  const d = (await c.call('POST', '/api/demo', { preset: 'reference', count: 8, targets: 4, game: 'cutthroat' })).data;
  assert.ok(d.id.startsWith('demo_'));
  assert.equal((await c.call('GET', '/api/tournaments')).data.length, 0, 'démo absente des tournois réels');
  assert.equal((await c.call('GET', '/api/tournaments?demo=1')).data.length, 1);
  const sim = (await c.call('POST', `/api/tournaments/${d.id}/demo/simulate`, { scope: 'all' })).data;
  assert.equal(sim.status, 'finished');
  assert.equal(sim.played, 20, '12 poules + 4 quarts + 2 demies + petite finale + finale');
  const v = (await c.call('GET', `/api/tournaments/${d.id}`)).data;
  assert.equal(v.derived.finalRanking[0].position, 1);
  const stats = (await c.call('GET', '/api/stats')).data;
  assert.equal(stats.totals.matches, 0, 'la démo n\'alimente pas les statistiques');
  // La simulation est refusée sur un tournoi réel
  const real = (await c.call('POST', '/api/tournaments', { name: 'Réel', preset: 'reference' })).data;
  assert.equal((await c.call('POST', `/api/tournaments/${real.id}/demo/simulate`, { scope: 'all' })).status, 400);
  // Réinitialisation complète
  const reset = (await c.call('POST', `/api/tournaments/${d.id}/demo/reset`, {})).data;
  assert.notEqual(reset.id, d.id);
  assert.equal((await c.call('GET', `/api/tournaments/${d.id}`)).status, 404);
  assert.equal((await c.call('GET', `/api/tournaments/${reset.id}`)).data.tournament.matches.length, 0);
  await srv.close();
});

test('API : inscriptions publiques, statistiques, palmarès, données personnelles', async () => {
  const dir = tmp();
  const srv = await start(dir);
  const c = client(srv.base);
  await c.call('POST', '/api/auth/register', { email: 'o@x.fr', password: 'motdepasse1' });
  const t = (await c.call('POST', '/api/tournaments', { name: 'Coupe', preset: 'knockoutOnly', targets: 2 })).data;
  let v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
  const cfg = v.tournament.config;
  cfg.publicRegistration = true;
  cfg.phases[0].roundOverrides = {};
  cfg.phases[0].bestOf = 1;
  assert.equal((await c.cmd(t.id, 'config.update', { config: cfg }, { expectedVersion: v.tournament.version })).status, 200);
  v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
  const rt = v.tournament.share.registrationToken;
  const anon = client(srv.base);
  assert.equal((await anon.call('GET', `/api/register/${rt}`)).data.open, true);
  for (const n of ['Alice', 'Bruno', 'Chloé', 'David']) assert.equal((await anon.call('POST', `/api/register/${rt}`, { name: n, email: `${n.toLowerCase()}@mail.fr` })).status, 200);
  assert.equal((await anon.call('POST', `/api/register/${rt}`, { name: 'alice' })).status, 422, 'doublon refusé');
  await c.cmd(t.id, 'registration.close');
  assert.equal((await anon.call('POST', `/api/register/${rt}`, { name: 'Tard' })).status, 422, 'inscriptions closes');
  v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
  for (const p of v.tournament.participants) await c.cmd(t.id, 'participant.setPresence', { id: p.id, presence: 'confirmed' });
  await c.cmd(t.id, 'phase.generateKnockout', { seed: 'pub' });
  await c.cmd(t.id, 'tournament.start');
  for (let i = 0; i < 4; i++) {
    v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
    const m = v.tournament.matches.find((x) => x.status === 'called');
    const r = await c.cmd(t.id, 'match.submitResult', { matchId: m.id, result: { legs: [{ endedBy: 'checkout', remainingA: 0, remainingB: 100 }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.equal(v.tournament.status, 'finished');
  await c.cmd(t.id, 'tournament.archive');
  const stats = (await c.call('GET', '/api/stats')).data;
  assert.equal(stats.palmares.length, 1);
  assert.equal(stats.totals.matches, 4, 'petite finale comprise');
  const winner = stats.entities.find((e) => e.titles === 1);
  assert.equal(winner.wins, 2);
  assert.equal(winner.winRate, 100);
  // Données personnelles
  const exp = (await c.call('GET', '/api/me/export')).data;
  assert.equal(exp.account.email, 'o@x.fr');
  assert.equal((await c.call('DELETE', '/api/me')).status, 409, 'propriétaire d\'un tournoi');
  const p0 = v.tournament.participants[0];
  assert.equal((await c.cmd(t.id, 'participant.anonymize', { id: p0.id })).status, 200, 'anonymisation possible même archivé');
  v = (await c.call('GET', `/api/tournaments/${t.id}`)).data;
  assert.match(v.tournament.participants[0].name, /anonyme/);
  assert.equal(v.tournament.participants[0].contact.email, '');
  await srv.close();
});

test('CSV : séparateurs, guillemets, en-têtes', () => {
  assert.deepEqual(parseCsv('a;"b;c";"d""e"\n1;2;3'), [['a', 'b;c', 'd"e'], ['1', '2', '3']]);
  assert.deepEqual(participantsFromCsv('Nom,Joueurs\n"Les As","Ana / Bea"', { mode: 'team', teamSize: 2 })[0].players, ['Ana', 'Bea']);
  assert.equal(participantsFromCsv('Alice\nBob', { mode: 'individual' }).length, 2);
});
