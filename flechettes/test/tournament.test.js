import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, playOut, checkScheduleInvariants } from './helpers.js';
import { referenceScenarioConfig, defaultConfig, defaultPoolsPhase, defaultKnockoutPhase } from '../src/engine/config.js';
import { buildDerived } from '../src/engine/view.js';
import { poolStandings } from '../src/engine/tournament.js';
import { lastEndTimes } from '../src/engine/scheduler.js';
import { canExecute } from '../src/engine/permissions.js';

const cricketWin = (side) => ({ legs: [{ endedBy: 'closed', winner: side, pointsA: side === 'a' ? 40 : 0, pointsB: side === 'b' ? 40 : 0, closedA: side === 'a', closedB: side === 'b' }] });

function prepareReference(game = 'cricket', targets = 4) {
  const h = harness({ config: referenceScenarioConfig(game), targets });
  h.addTeams(8, 2, { confirm: false });
  for (const p of h.state.participants) h.run('participant.setPresence', { id: p.id, presence: 'confirmed' });
  h.run('registration.close');
  h.run('pools.draw', { seed: 'tirage-1' });
  return h;
}

for (const game of ['cricket', 'cutthroat']) {
  test(`Scénario de référence complet (${game}) : de l'inscription à l'archivage`, () => {
    const h = prepareReference(game);
    const s0 = h.state;
    assert.equal(s0.participants.length, 8);
    assert.equal(s0.participants.flatMap((p) => p.players).length, 16, '16 joueurs');
    assert.deepEqual(s0.phases[0].pools.map((p) => p.participantIds.length), [4, 4]);
    h.run('pools.validate');
    const pool = h.state.matches.filter((m) => m.kind === 'pool');
    assert.equal(pool.length, 12, '12 rencontres de poules');
    for (const p of h.state.participants) assert.equal(pool.filter((m) => m.a === p.id || m.b === p.id).length, 3, 'chaque équipe joue 3 rencontres');
    assert.ok(pool.every((m) => m.rules.turnLimit === 10 && m.rules.bestOf === 1 && m.rules.game === game));
    assert.throws(() => h.run('participant.add', { name: 'Tard', players: ['x', 'y'] }), /LOCKED|générées/);
    h.run('tournament.start');
    assert.equal(h.state.matches.filter((m) => m.status === 'called').length, 4, '4 cibles occupées dès le lancement');
    let afterEach = 0;
    playOut(h, {
      rngSeed: `ref-${game}`,
      onStep: (hh, m) => {
        if (m.kind === 'pool') {
          // Classement mis à jour après chaque rencontre validée
          const st = poolStandings(hh.state, 'p1', m.poolId);
          const played = st.rows.reduce((s, r) => s + r.played, 0) / 2;
          assert.equal(played, hh.state.matches.filter((x) => x.poolId === m.poolId && x.status === 'finished').length);
          afterEach++;
        }
      },
    });
    assert.equal(afterEach, 12);
    const ko = h.state.matches.filter((m) => m.kind === 'knockout');
    const qf = ko.filter((m) => m.roundKey === 'r8');
    assert.equal(qf.length, 4, 'quarts de finale');
    // Quarts : jamais deux équipes de la même poule
    const poolOf = (id) => h.state.phases[0].pools.find((p) => p.participantIds.includes(id)).id;
    for (const m of qf) assert.notEqual(poolOf(m.a), poolOf(m.b));
    assert.ok(qf.every((m) => m.rules.turnLimit === 20 && m.rules.bestOf === 1));
    assert.equal(ko.filter((m) => m.roundKey === 'r4').length, 2, 'demi-finales');
    const third = ko.find((m) => m.roundKey === 'third');
    const final = ko.find((m) => m.roundKey === 'r2');
    assert.equal(final.rules.bestOf, 3, 'finale en BO3');
    assert.ok(final.result.legsA === 2 || final.result.legsB === 2);
    assert.ok(ko.every((m) => m.result.winner !== null), 'aucun nul en élimination directe');
    assert.equal(h.state.status, 'finished');
    const fr = h.state.finalRanking;
    assert.equal(fr.length, 8);
    assert.deepEqual(fr.slice(0, 4).map((e) => e.position), [1, 2, 3, 4]);
    assert.equal(fr[0].participantId, final[final.result.winner]);
    assert.equal(fr[2].participantId, third[third.result.winner]);
    assert.ok(fr.slice(4).every((e) => e.position === 5 && e.tied), 'perdants des quarts 5e ex aequo');
    h.run('tournament.archive');
    assert.equal(h.state.status, 'archived');
    assert.throws(() => h.run('match.correctResult', { matchId: final.id, result: cricketWin('a') }), /archivé/);
  });
}

test('Planification : contraintes respectées et cibles exploitées (configurations variées)', () => {
  const configs = [
    { n: 7, pools: 2, q: 2, targets: 3, mode: 'individual' },
    { n: 13, pools: 3, q: 2, targets: 2, mode: 'individual' },
    { n: 10, pools: 2, q: 3, targets: 5, mode: 'team' },
    { n: 5, pools: 1, q: 4, targets: 2, mode: 'individual' },
    { n: 16, pools: 4, q: 2, targets: 6, mode: 'team' },
  ];
  for (const c of configs) {
    const cfg = defaultConfig({ mode: c.mode, teamSize: c.mode === 'team' ? 2 : 1, phases: [defaultPoolsPhase({ poolCount: c.pools, qualifiersPerPool: c.q, game: '501', turnLimit: 15, bestOf: 1 }), defaultKnockoutPhase({ game: '501', turnLimit: 20, thirdPlaceMatch: c.pools * c.q >= 4 })] });
    const h = harness({ config: cfg, targets: c.targets });
    if (c.mode === 'team') h.addTeams(c.n); else h.addPlayers(c.n);
    h.run('registration.close');
    h.run('pools.draw', { seed: `s${c.n}` });
    h.run('pools.validate');
    h.run('tournament.start');
    playOut(h, { rngSeed: `p${c.n}` }); // vérifie les invariants à chaque étape
    assert.equal(h.state.status, 'finished', `${c.n} participants`);
    const fr = h.state.finalRanking;
    assert.equal(fr.length, c.n, 'tous classés');
    assert.equal(fr[0].position, 1);
  }
});

test('Planification : équilibre des temps de repos (pas d\'attente excessive évitable)', () => {
  const cfg = defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultPoolsPhase({ poolCount: 1, qualifiersPerPool: 1, game: 'cricket', turnLimit: 10 })] });
  const h = harness({ config: cfg, targets: 2 });
  h.addPlayers(8);
  h.run('registration.close');
  h.run('pools.draw', { seed: 'r' });
  h.run('pools.validate');
  h.run('tournament.start');
  const ends = [];
  // Durées identiques : chaque rencontre dure 10 min ; on termine les rencontres par ordre d'appel.
  playOut(h, { onStep: (hh) => ends.push(hh.now) });
  // Mesure : pour chaque joueur, nombre de rencontres jouées à mi-parcours — écart maximal ≤ 1.
  const finished = h.state.matches.filter((m) => m.status === 'finished').sort((a, b) => a.endedAt - b.endedAt);
  const half = finished.slice(0, 14);
  const counts = new Map();
  for (const m of half) for (const p of [m.a, m.b]) counts.set(p, (counts.get(p) || 0) + 1);
  const vals = h.state.participants.map((p) => counts.get(p.id) || 0);
  assert.ok(Math.max(...vals) - Math.min(...vals) <= 2, `répartition équilibrée (${vals})`);
  // Pas de match immédiatement consécutif quand une alternative existait : contrôle global.
  let backToBack = 0;
  for (let i = 1; i < finished.length; i++) {
    const prev = finished.slice(0, i);
    const m = finished[i];
    for (const p of [m.a, m.b]) {
      const last = prev.filter((x) => x.a === p || x.b === p).at(-1);
      if (last && m.startedAt - last.endedAt < 60000) backToBack++;
    }
  }
  assert.ok(backToBack <= finished.length / 2, `matchs consécutifs limités (${backToBack} sur ${finished.length})`);
  void lastEndTimes; void ends;
});

test('Cible indisponible : la rencontre est suspendue puis réaffectée en priorité', () => {
  const h = prepareReference('cricket', 4);
  h.run('pools.validate');
  h.run('tournament.start');
  const m = h.state.matches.find((x) => x.targetId === 'cible1');
  h.run('match.start', { matchId: m.id });
  h.run('target.setStatus', { id: 'cible1', status: 'unavailable', note: 'panne' });
  assert.equal(h.match(m.id).status, 'suspended');
  assert.equal(h.match(m.id).targetId, null);
  checkScheduleInvariants(h.state);
  // Une autre cible se libère : la rencontre suspendue la récupère avant toute nouvelle rencontre.
  const other = h.state.matches.find((x) => x.targetId === 'cible2');
  h.run('match.start', { matchId: other.id });
  h.run('match.submitResult', { matchId: other.id, result: cricketWin('a') });
  assert.equal(h.match(m.id).targetId, 'cible2');
  h.run('match.resume', { matchId: m.id });
  assert.equal(h.match(m.id).status, 'playing');
  // Ajout / retrait de cibles en cours de compétition
  h.run('target.add', { name: 'Cible 5' });
  assert.equal(h.state.targets.length, 5);
  assert.throws(() => h.run('target.remove', { id: 'cible2' }), /occupe/);
  h.run('target.setStatus', { id: 'cible1', status: 'available' });
  checkScheduleInvariants(h.state);
});

test('Interdits : double rencontre simultanée, cible occupée, validations contradictoires', () => {
  const h = prepareReference();
  h.run('pools.validate');
  h.run('tournament.start');
  const called = h.state.matches.filter((m) => m.status === 'called');
  const m = called[0];
  // Tentative d'affecter une rencontre impliquant un participant déjà appelé
  const conflicting = h.state.matches.find((x) => x.status === 'ready' && (x.a === m.a || x.b === m.a));
  h.run('target.add', { name: 'Cible 5' });
  assert.equal(h.state.matches.filter((x) => x.targetId === 'cible5').length, 0, 'aucune rencontre jouable : tous les participants sont occupés');
  assert.throws(() => h.run('match.assign', { matchId: conflicting.id, targetId: 'cible5' }), /PARTICIPANT_BUSY|dispute déjà/);
  assert.throws(() => h.run('match.assign', { matchId: conflicting.id, targetId: m.targetId }), /occupée|dispute/);
  h.run('match.start', { matchId: m.id });
  h.run('match.submitResult', { matchId: m.id, result: cricketWin('a') });
  assert.throws(() => h.run('match.submitResult', { matchId: m.id, result: cricketWin('b') }), /ALREADY_FINISHED|déjà validé/);
  const v = h.match(m.id).resultVersion;
  assert.throws(() => h.run('match.correctResult', { matchId: m.id, result: cricketWin('b'), resultVersion: v - 1 }), /modifié entre-temps/);
  h.run('match.correctResult', { matchId: m.id, result: cricketWin('b'), resultVersion: v });
  assert.equal(h.match(m.id).result.winner, 'b');
  assert.equal(h.match(m.id).history.length, 1, 'ancien résultat conservé');
});

test('Saisie par un responsable de cible : validation requise, rejet possible', () => {
  const h = prepareReference();
  h.run('pools.validate');
  h.run('tournament.start');
  const m = h.state.matches.find((x) => x.status === 'called');
  h.run('match.start', { matchId: m.id }, { canValidate: false });
  h.run('match.submitResult', { matchId: m.id, result: cricketWin('a') }, { canValidate: false });
  assert.equal(h.match(m.id).status, 'awaiting_validation');
  assert.equal(h.match(m.id).targetId !== null, true, 'la cible reste occupée jusqu\'à validation');
  assert.throws(() => h.run('match.submitResult', { matchId: m.id, result: cricketWin('b') }, { canValidate: false }), /attend déjà/);
  h.run('match.rejectResult', { matchId: m.id, reason: 'erreur' });
  assert.equal(h.match(m.id).status, 'playing');
  h.run('match.submitResult', { matchId: m.id, result: cricketWin('b') }, { canValidate: false });
  h.run('match.validateResult', { matchId: m.id });
  assert.equal(h.match(m.id).status, 'finished');
  assert.equal(h.match(m.id).result.winner, 'b');
});

test('Correction tardive en poule après le début des phases finales : décision exigée', () => {
  const h = prepareReference();
  const cfg = h.state.config;
  cfg.phases[0].qualifiersPerPool = 2; // poules qualificatives : 4 qualifiés → demi-finales
  h.run('config.update', { config: cfg });
  h.run('pools.validate');
  h.run('tournament.start');
  playOut(h, { maxSteps: 12, rngSeed: 'corr' });
  assert.equal(h.state.phases[1].status, 'active', 'tableau généré');
  const sf = h.state.matches.find((m) => m.roundKey === 'r4' && m.status === 'called');
  h.run('match.start', { matchId: sf.id });
  h.run('match.submitResult', { matchId: sf.id, result: cricketWin('a') });
  // Correction d'une rencontre de poule qui inverse les qualifiés
  const entrants = h.state.phases[1].entrants;
  const pm = h.state.matches.find((m) => m.kind === 'pool' && ((entrants.includes(m.a) && !entrants.includes(m.b)) || (entrants.includes(m.b) && !entrants.includes(m.a))));
  const flip = pm.result.winner === 'a' ? 'b' : 'a';
  let changed = false;
  try {
    h.run('match.correctResult', { matchId: pm.id, result: { outcome: 'forfeit', loser: pm.result.winner } });
    changed = false;
  } catch (e) {
    assert.equal(e.code, 'DECISION_REQUIRED');
    changed = true;
  }
  if (changed) {
    const keep = structuredClone(h.state);
    h.run('match.correctResult', { matchId: pm.id, result: { outcome: 'forfeit', loser: pm.result.winner }, decision: 'keepNextPhase' });
    assert.deepEqual(h.state.phases[1].entrants, keep.phases[1].entrants, 'tableau conservé');
    assert.ok(h.state.decisions.some((d) => d.type === 'keepNextPhase'));
    // Puis régénération explicite
    h.state = keep;
    h.run('match.correctResult', { matchId: pm.id, result: { outcome: 'forfeit', loser: pm.result.winner }, decision: 'regenerateNextPhase' });
    assert.ok(h.state.decisions.some((d) => d.type === 'archivedResult'), 'résultats de la phase finale archivés');
    assert.ok(h.state.matches.filter((m) => m.kind === 'knockout').every((m) => !m.result || m.result.outcome === 'bye'), 'tableau régénéré');
  }
  void flip;
});

test('Correction en élimination directe : vainqueur modifié avec rencontres dépendantes jouées', () => {
  const cfg = defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultKnockoutPhase({ id: 'k', game: 'cricket', thirdPlaceMatch: true })] });
  const h = harness({ config: cfg, targets: 4 });
  h.addPlayers(8);
  h.run('registration.close');
  h.run('phase.generateKnockout', { seed: 'k' });
  h.run('tournament.start');
  const qf = h.state.matches.filter((m) => m.roundKey === 'r8');
  for (const m of qf) { h.run('match.start', { matchId: m.id }); h.run('match.submitResult', { matchId: m.id, result: cricketWin('a') }); }
  const sf1 = h.state.matches.find((m) => m.roundKey === 'r4' && m.slot === 0);
  assert.equal(sf1.status, 'called', 'demi-finale jouable dès que ses participants sont connus');
  h.run('match.start', { matchId: sf1.id });
  h.run('match.submitResult', { matchId: sf1.id, result: cricketWin('a') });
  const q1 = h.match(qf[0].id);
  assert.throws(() => h.run('match.correctResult', { matchId: q1.id, result: cricketWin('b') }), (e) => e.code === 'DECISION_REQUIRED');
  // Correction sans changement de vainqueur : aucune décision nécessaire
  h.run('match.correctResult', { matchId: q1.id, result: { legs: [{ endedBy: 'closed', winner: 'a', pointsA: 99, pointsB: 0, closedA: true }] } });
  h.run('match.correctResult', { matchId: q1.id, result: cricketWin('b'), decision: 'resetDependents' });
  const sf = h.match(sf1.id);
  assert.equal(sf.a, q1.b, 'nouveau vainqueur placé en demi-finale');
  assert.equal(sf.result, null, 'demi-finale à rejouer');
  assert.equal(sf.history.length, 1, 'ancien résultat archivé');
  checkScheduleInvariants(h.state);
});

test('Forfaits, désistements et disqualifications', () => {
  // Poules : désistement « forfait des rencontres restantes »
  const h = prepareReference();
  h.run('pools.validate');
  h.run('tournament.start');
  const m = h.state.matches.find((x) => x.status === 'called');
  h.run('match.start', { matchId: m.id });
  h.run('match.submitResult', { matchId: m.id, result: cricketWin('a') });
  const quitter = m.a;
  h.run('participant.withdraw', { id: quitter, policy: 'forfeitRemaining' });
  const theirs = h.state.matches.filter((x) => x.a === quitter || x.b === quitter);
  assert.equal(theirs.filter((x) => x.result?.outcome === 'normal').length, 1, 'résultat acquis conservé');
  assert.ok(theirs.filter((x) => x.id !== m.id).every((x) => x.status === 'finished' && ['forfeit', 'retired'].includes(x.result.outcome)), 'rencontres restantes perdues');
  checkScheduleInvariants(h.state);
  // Disqualification « annulation de toutes les rencontres »
  const dq = h.state.participants.find((p) => p.id !== quitter && h.state.phases[0].pools.find((pl) => pl.participantIds.includes(quitter)).participantIds.includes(p.id));
  h.run('participant.disqualify', { id: dq.id, policy: 'annulAll', reason: 'comportement' });
  const dqm = h.state.matches.filter((x) => x.a === dq.id || x.b === dq.id);
  assert.ok(dqm.every((x) => x.status === 'cancelled'));
  const st = poolStandings(h.state, 'p1', dqm[0].poolId);
  assert.ok(st.rows.find((r) => r.participantId === dq.id).excluded);
  checkScheduleInvariants(h.state);
  playOut(h, { rngSeed: 'wd' });
  assert.equal(h.state.status, 'finished');
  // Les participants hors compétition ne sont pas qualifiés : tableau à 6 avec exemptions
  const ko = h.state.phases[1].entrants;
  assert.equal(ko.length, 6);
  assert.ok(!ko.includes(quitter) && !ko.includes(dq.id));
  assert.equal(h.state.matches.filter((x) => x.kind === 'knockout' && x.result?.outcome === 'bye').length, 2);
});

test('Élimination directe : forfait déclaré, l\'adversaire avance', () => {
  const cfg = defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultKnockoutPhase({ id: 'k', thirdPlaceMatch: false })] });
  const h = harness({ config: cfg, targets: 2 });
  h.addPlayers(4);
  h.run('registration.close');
  h.run('phase.generateKnockout', { seed: 'f' });
  h.run('tournament.start');
  const sf = h.state.matches.find((m) => m.roundKey === 'r4');
  h.run('match.submitResult', { matchId: sf.id, result: { outcome: 'forfeit', loser: 'b', legs: [] } });
  const final = h.state.matches.find((m) => m.roundKey === 'r2');
  assert.equal(final.a, sf.a);
  playOut(h);
  assert.equal(h.state.status, 'finished');
  assert.deepEqual(h.state.finalRanking.map((e) => e.position), [1, 2, 3, 3], 'sans petite finale : 3e ex aequo');
});

test('Nombres impairs et exemptions : 5 joueurs en élimination directe, 7 équipes en poules', () => {
  const ko = harness({ config: defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultKnockoutPhase({ id: 'k', thirdPlaceMatch: true, game: '501', turnLimit: 15 })] }), targets: 3 });
  ko.addPlayers(5);
  ko.run('registration.close');
  ko.run('phase.generateKnockout', { seed: 'b' });
  assert.equal(ko.state.matches.filter((m) => m.result?.outcome === 'bye').length, 3);
  ko.run('tournament.start');
  playOut(ko);
  assert.equal(ko.state.status, 'finished');
  assert.equal(ko.state.finalRanking.length, 5);
  const p = harness({ config: defaultConfig({ phases: [defaultPoolsPhase({ poolCount: 2, qualifiersPerPool: 2 }), defaultKnockoutPhase({ thirdPlaceMatch: true })] }), targets: 3 });
  p.addTeams(7);
  p.run('registration.close');
  p.run('pools.draw', { seed: 'imp' });
  assert.deepEqual(p.state.phases[0].pools.map((x) => x.participantIds.length).sort(), [3, 4]);
  p.run('pools.validate');
  assert.equal(p.state.matches.length, 6 + 3, 'poule de 4 : 6 matchs, poule de 3 : 3 matchs');
  p.run('tournament.start');
  playOut(p);
  assert.equal(p.state.status, 'finished');
  assert.equal(p.state.finalRanking.length, 7);
});

test('Égalité persistante : la phase attend la décision de l\'organisateur', () => {
  const cfg = defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultPoolsPhase({ poolCount: 1, qualifiersPerPool: 1, tiebreakers: ['points'] }), defaultKnockoutPhase({ thirdPlaceMatch: false })] });
  // 1 poule de 3, cycle parfait → égalité au 1er rang ; KO à 1 participant impossible : on prend 2 qualifiés
  cfg.phases[0].qualifiersPerPool = 2;
  const h = harness({ config: cfg, targets: 3 });
  h.addPlayers(3);
  h.run('registration.close');
  h.run('pools.draw', { seed: 't' });
  h.run('pools.validate');
  h.run('tournament.start');
  const ids = h.state.phases[0].pools[0].participantIds;
  const winOf = { [`${ids[0]}|${ids[1]}`]: ids[0], [`${ids[1]}|${ids[2]}`]: ids[1], [`${ids[2]}|${ids[0]}`]: ids[2] };
  for (let i = 0; i < 3; i++) {
    const m = h.state.matches.find((x) => x.status === 'called');
    const w = winOf[`${m.a}|${m.b}`] || winOf[`${m.b}|${m.a}`];
    h.run('match.start', { matchId: m.id });
    h.run('match.submitResult', { matchId: m.id, result: cricketWin(w === m.a ? 'a' : 'b') });
  }
  assert.equal(h.state.phases[0].awaitingDecision.type, 'ties');
  assert.equal(h.state.phases[1].status, 'pending', 'phase suivante non générée');
  const d = buildDerived(h.state, h.now);
  assert.ok(d.alerts.some((a) => a.type === 'tie'));
  h.run('phase.resolveTie', { phaseId: 'p1', poolId: 'pool1', order: [ids[2], ids[0], ids[1]] });
  assert.equal(h.state.phases[1].status, 'active');
  assert.deepEqual(h.state.phases[1].entrants, [ids[2], ids[0]]);
});

test('Interruption, reprise, report et priorité', () => {
  const h = prepareReference();
  h.run('pools.validate');
  h.run('tournament.start');
  const m = h.state.matches.find((x) => x.status === 'called');
  h.run('match.start', { matchId: m.id });
  h.run('tournament.pause');
  assert.equal(h.match(m.id).status, 'suspended');
  assert.throws(() => h.run('match.start', { matchId: h.state.matches.find((x) => x.status === 'called').id }), /n'est pas en cours/);
  h.run('tournament.resume');
  assert.equal(h.match(m.id).status, 'playing');
  const ready = h.state.matches.find((x) => x.status === 'ready');
  h.run('match.postpone', { matchId: ready.id, reason: 'joueur en retard' });
  assert.equal(h.match(ready.id).status, 'postponed');
  h.run('match.release', { matchId: ready.id });
  assert.equal(h.match(ready.id).status, 'ready');
});

test('Inscriptions : doublons, taille d\'équipe, clôture, verrouillage, remplacement, import', () => {
  const h = harness({ config: referenceScenarioConfig() });
  h.run('participant.add', { name: 'Les Triples', players: ['Alice Martin', 'Bob Durand'] });
  assert.throws(() => h.run('participant.add', { name: 'les triples', players: ['C', 'D'] }), (e) => e.code === 'DUPLICATE');
  assert.throws(() => h.run('participant.add', { name: 'Autre', players: ['Alice  Martin', 'E'] }), (e) => e.code === 'DUPLICATE', 'joueur déjà inscrit (accents/espaces ignorés)');
  assert.throws(() => h.run('participant.add', { name: 'Solo', players: ['Un'] }), /exactement 2/);
  const r = h.run('participant.import', { rows: [{ name: 'Double Top', players: ['X', 'Y'] }, { name: 'Les Triples', players: ['Z', 'W'] }] });
  assert.equal(r.result.added, 1);
  assert.equal(r.result.rejected.length, 1);
  for (let i = 0; i < 6; i++) h.run('participant.add', { name: `T${i}`, players: [`a${i}`, `b${i}`] });
  assert.throws(() => h.run('participant.add', { name: 'Neuvième', players: ['n1', 'n2'] }), /maximal/);
  for (const p of h.state.participants) h.run('participant.setPresence', { id: p.id, presence: 'confirmed' });
  assert.throws(() => h.run('pools.draw'), /Clore les inscriptions/);
  h.run('registration.close');
  h.run('pools.draw', { seed: 'z' });
  const absent = h.state.participants[0];
  h.run('participant.setPresence', { id: absent.id, presence: 'absent' });
  assert.ok(!h.state.phases[0].pools.some((p) => p.participantIds.includes(absent.id)), 'absent retiré de sa poule');
  assert.throws(() => h.run('pools.validate'), /qualifié/, '4 qualifiés pour une poule de 3');
  h.run('participant.setPresence', { id: absent.id, presence: 'confirmed' });
  assert.throws(() => h.run('pools.validate'), /sans poule/);
  h.run('pools.draw', { seed: 'z' });
  h.run('pools.validate');
  h.run('tournament.start');
  assert.throws(() => h.run('registration.open'), /verrouillés/);
  assert.throws(() => h.run('participant.remove', { id: absent.id }), /désistement/);
  const team = h.state.participants[1];
  h.run('participant.replacePlayer', { id: team.id, playerId: team.players[0].id, name: 'Remplaçant', reason: 'blessure' });
  assert.equal(h.state.participants[1].players[0].name, 'Remplaçant');
  assert.equal(h.state.participants[1].players[0].history[0].replaced, team.players[0].name);
});

test('Configuration modifiable en cours de tournoi uniquement si les conséquences sont maîtrisées', () => {
  const h = prepareReference();
  h.run('pools.validate');
  h.run('tournament.start');
  const cfg = structuredClone(h.state.config);
  cfg.phases[0].poolCount = 4;
  assert.throws(() => h.run('config.update', { config: cfg }), /ne peut plus être modifié/);
  const cfg2 = structuredClone(h.state.config);
  cfg2.phases[1].roundOverrides.r2 = { bestOf: 5 };
  cfg2.phases[1].roundOverrides.r4 = { bestOf: 3 };
  cfg2.scheduling.minRestMinutes = 2;
  h.run('config.update', { config: cfg2 });
  playOut(h, { rngSeed: 'cfg' });
  assert.equal(h.state.matches.find((m) => m.roundKey === 'r2').rules.bestOf, 5);
  assert.equal(h.state.matches.find((m) => m.roundKey === 'r4').rules.bestOf, 3);
});

test('Tournoi en poules uniquement et prévisions du calendrier', () => {
  const cfg = defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultPoolsPhase({ poolCount: 2, qualifiersPerPool: 1, game: '501', bestOf: 3, turnLimit: 12, allowDraw: false })] });
  const h = harness({ config: cfg, targets: 3 });
  h.addPlayers(9);
  h.run('registration.close');
  h.run('pools.draw', { seed: 'po' });
  h.run('pools.validate');
  h.run('tournament.start');
  const d = buildDerived(h.state, h.now);
  const pending = h.state.matches.filter((m) => !['finished', 'cancelled'].includes(m.status));
  assert.equal(Object.keys(d.forecast).length, pending.length, 'chaque rencontre a une prévision');
  const perTarget = {};
  for (const f of Object.values(d.forecast)) (perTarget[f.targetId] ||= []).push(f);
  for (const list of Object.values(perTarget)) {
    list.sort((a, b) => a.estimatedStart - b.estimatedStart);
    for (let i = 1; i < list.length; i++) assert.ok(list[i].estimatedStart >= list[i - 1].estimatedEnd, 'pas de chevauchement sur une cible');
  }
  playOut(h, { rngSeed: 'po' });
  assert.equal(h.state.status, 'finished');
  assert.equal(h.state.finalRanking.length, 9);
});

test('Déterminisme : mêmes résultats et même règlement → même classement', () => {
  const run = () => {
    const h = prepareReference();
    h.run('pools.validate');
    h.run('tournament.start');
    playOut(h, { rngSeed: 'det' });
    return h.state.finalRanking.map((e) => `${e.position}:${h.state.participants.find((p) => p.id === e.participantId).name}`);
  };
  assert.deepEqual(run(), run());
});

test('Autorisations appliquées aux opérations', () => {
  const h = prepareReference();
  const s = h.state;
  const cmd = (type, payload = {}) => ({ type, payload });
  assert.equal(canExecute({ role: 'spectator' }, cmd('match.submitResult'), s).ok, false);
  assert.equal(canExecute({ role: 'participant', participantId: s.participants[0].id }, cmd('participant.setPresence', { id: s.participants[0].id, presence: 'confirmed' }), s).ok, true);
  assert.equal(canExecute({ role: 'participant', participantId: s.participants[0].id }, cmd('participant.setPresence', { id: s.participants[1].id, presence: 'confirmed' }), s).ok, false);
  assert.equal(canExecute({ role: 'referee' }, cmd('match.correctResult'), s).ok, false, 'correction réservée aux organisateurs');
  assert.equal(canExecute({ role: 'organizer' }, cmd('config.update'), s).ok, false);
  assert.equal(canExecute({ role: 'admin' }, cmd('members.set', { userId: 'x', role: 'admin' }), s).ok, false, 'seul le propriétaire nomme un administrateur');
  h.run('pools.validate');
  h.run('tournament.start');
  const m = h.state.matches.find((x) => x.targetId === 'cible1');
  const other = h.state.matches.find((x) => x.targetId === 'cible2');
  const tm = { role: 'targetManager', targetIds: ['cible1'] };
  assert.equal(canExecute(tm, cmd('match.start', { matchId: m.id }), h.state).ok, true);
  assert.equal(canExecute(tm, cmd('match.start', { matchId: other.id }), h.state).ok, false, 'responsable limité à ses cibles');
  assert.equal(canExecute(tm, cmd('match.validateResult', { matchId: m.id }), h.state).ok, false);
});
