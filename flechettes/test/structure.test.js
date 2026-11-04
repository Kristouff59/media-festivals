import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResult } from '../src/engine/match.js';
import { roundRobin, expectedMatchCount } from '../src/engine/roundRobin.js';
import { drawPools } from '../src/engine/pools.js';
import { seedOrder, buildBracket } from '../src/engine/bracket.js';
import { computeStandings, mathematicalStatus } from '../src/engine/standings.js';
import { defaultPoolsPhase, defaultKnockoutPhase, validateConfig, referenceScenarioConfig, defaultConfig } from '../src/engine/config.js';

const cr = (winner, pa, pb) => ({ endedBy: 'closed', winner, pointsA: pa, pointsB: pb, closedA: winner === 'a', closedB: winner === 'b' });
const BO = (bestOf, extra = {}) => ({ game: 'cricket', gameOptions: {}, bestOf, turnLimit: 20, allowDraw: false, ...extra });

test('Best of 3 : 2-0, 2-1, manche en trop, rencontre incomplète', () => {
  assert.equal(evaluateResult(BO(3), { legs: [cr('a', 10, 0), cr('a', 10, 0)] }).result.legsA, 2);
  const r = evaluateResult(BO(3), { legs: [cr('a', 10, 0), cr('b', 0, 10), cr('b', 0, 20)] });
  assert.equal(r.result.winner, 'b');
  assert.equal(r.result.legsB, 2);
  assert.equal(evaluateResult(BO(3), { legs: [cr('a', 1, 0), cr('a', 1, 0), cr('b', 0, 1)] }).ok, false, 'manche après la décision');
  assert.equal(evaluateResult(BO(3), { legs: [cr('a', 1, 0), cr('b', 0, 1)] }).ok, false, 'incomplète');
  assert.equal(evaluateResult(BO(5), { legs: [cr('a', 1, 0), cr('a', 1, 0), cr('a', 1, 0)] }).ok, true, 'BO5 3-0');
});

test('Nuls : autorisés seulement si la rencontre le permet ; jamais en élimination directe', () => {
  const tie = { endedBy: 'turnLimit', pointsA: 40, pointsB: 40 };
  assert.equal(evaluateResult(BO(1, { allowDraw: true }), { legs: [tie] }).result.winner, null);
  assert.equal(evaluateResult(BO(1), { legs: [tie] }).ok, false);
  assert.equal(evaluateResult(BO(1), { legs: [{ ...tie, tiebreakWinner: 'a' }] }).result.winner, 'a');
  // BO2 sans nul : 1-1 → manche décisive obligatoire puis acceptée
  assert.equal(evaluateResult(BO(2), { legs: [cr('a', 1, 0), cr('b', 0, 1)] }).ok, false);
  assert.equal(evaluateResult(BO(2), { legs: [cr('a', 1, 0), cr('b', 0, 1), cr('a', 1, 0)] }).result.winner, 'a');
  assert.equal(evaluateResult(BO(2, { allowDraw: true }), { legs: [cr('a', 1, 0), cr('b', 0, 1)] }).result.winner, null);
});

test('Forfait, abandon, disqualification', () => {
  const f = evaluateResult(BO(3), { outcome: 'forfeit', loser: 'b', legs: [] });
  assert.deepEqual([f.result.winner, f.result.legsA, f.result.legsB], ['a', 2, 0]);
  const r = evaluateResult(BO(3), { outcome: 'retired', loser: 'a', legs: [cr('a', 5, 0)] });
  assert.deepEqual([r.result.winner, r.result.legsA, r.result.legsB], ['b', 1, 2]);
  assert.equal(evaluateResult(BO(3), { outcome: 'forfeit', legs: [] }).ok, false, 'camp perdant manquant');
  assert.equal(evaluateResult(BO(3), { outcome: 'forfeit', loser: 'a', legs: [cr('a', 1, 0)] }).ok, false);
});

test('Round-robin : n(n-1)/2 rencontres uniques, personne deux fois par tour (2 à 13 participants)', () => {
  for (let n = 2; n <= 13; n++) {
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const rounds = roundRobin(ids);
    const pairs = rounds.flat();
    assert.equal(pairs.length, expectedMatchCount(n));
    assert.equal(new Set(pairs.map((p) => p.slice().sort().join('|'))).size, pairs.length, 'aucun doublon');
    for (const r of rounds) assert.equal(new Set(r.flat()).size, r.length * 2, 'un participant par tour au plus');
    assert.equal(rounds.length, n % 2 ? n : n - 1);
    for (const id of ids) assert.equal(pairs.filter((p) => p.includes(id)).length, n - 1);
  }
  assert.equal(expectedMatchCount(4), 6, 'exemple du cahier des charges : poule de 4 → 6 matchs');
});

test('Tirage des poules : équilibré, reproductible, têtes de série en serpentin', () => {
  const ent = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, seed: i < 3 ? i + 1 : null }));
  const pools = drawPools(ent, 3, { seed: 'x' });
  const sizes = pools.map((p) => p.participantIds.length).sort();
  assert.deepEqual(sizes, [3, 4, 4]);
  assert.deepEqual(drawPools(ent, 3, { seed: 'x' }), pools, 'même graine → même tirage');
  assert.notDeepEqual(drawPools(ent, 3, { seed: 'y' }), pools);
  const seeded = drawPools(ent, 3, { method: 'seeded', seed: 'x' });
  assert.deepEqual(seeded.map((p) => p.participantIds[0]), ['p0', 'p1', 'p2'], 'une tête de série par poule');
  assert.throws(() => drawPools(ent.slice(0, 5), 3));
});

test('Tableau : ordre des têtes de série, exemptions, petite finale', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const ph = defaultKnockoutPhase({ id: 'ko', thirdPlaceMatch: true, roundOverrides: { r2: { bestOf: 3 } } });
  const { size, matches } = buildBracket(Array.from({ length: 5 }, (_, i) => ({ participantId: `p${i + 1}`, tier: 1 })), ph);
  assert.equal(size, 8);
  const first = matches.filter((m) => m.roundIndex === 0);
  assert.equal(first.filter((m) => m.byeA || m.byeB).length, 3, '3 exemptions');
  for (const s of ['p1', 'p2', 'p3']) assert.ok(first.find((m) => (m.a === s || m.b === s) && (m.byeA || m.byeB)), `${s} exempté`);
  assert.equal(matches.find((m) => m.roundKey === 'r2').rules.bestOf, 3, 'finale BO3');
  assert.equal(matches.find((m) => m.roundKey === 'r4').rules.bestOf, 1);
  const third = matches.find((m) => m.roundKey === 'third');
  assert.deepEqual([third.sourceA.take, third.sourceB.take], ['loser', 'loser']);
});

test('Tableau : séparation des participants d\'une même poule au premier tour', () => {
  // 3 poules × 2 qualifiés = 6 → tableau de 8 avec 2 exemptions
  const ent = [['A', 1], ['B', 1], ['C', 1], ['A', 2], ['B', 2], ['C', 2]].map(([pool, tier], i) => ({ participantId: `${pool}${tier}`, poolId: pool, tier, i }));
  const { matches } = buildBracket(ent, defaultKnockoutPhase({ id: 'ko', avoidSamePool: true }));
  for (const m of matches.filter((x) => x.roundIndex === 0 && x.a && x.b)) assert.notEqual(m.a[0], m.b[0], `${m.a} vs ${m.b}`);
  // 2 poules de 4 : A1-B4, B2-A3, B1-A4, A2-B3
  const e8 = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4'].map((id) => ({ participantId: id, poolId: id[0], tier: Number(id[1]) }));
  const r8 = buildBracket(e8, defaultKnockoutPhase({ id: 'ko' })).matches.filter((m) => m.roundIndex === 0).map((m) => `${m.a}-${m.b}`);
  assert.deepEqual(r8, ['A1-B4', 'B2-A3', 'B1-A4', 'A2-B3']);
});

const pts = defaultPoolsPhase();
function fin(a, b, la, lb, fa = 0, fb = 0, outcome = 'normal') {
  return { status: 'finished', a, b, result: { outcome, winner: la > lb ? 'a' : lb > la ? 'b' : null, loser: la > lb ? 'b' : lb > la ? 'a' : null, legsA: la, legsB: lb, forA: fa, forB: fb, legs: [] } };
}

test('Classement : points configurables, confrontation directe, différences', () => {
  const matches = [fin('A', 'B', 1, 0, 50, 10), fin('C', 'A', 1, 0, 30, 20), fin('B', 'C', 1, 0, 40, 20), fin('A', 'D', 1, 0), fin('B', 'D', 1, 0), fin('D', 'C', 1, 0)];
  const st = computeStandings({ participantIds: ['A', 'B', 'C', 'D'], matches, phase: pts });
  // A, B : 4 pts ; C, D : 2 pts. A bat B (confrontation directe) ; D bat C.
  assert.deepEqual(st.rows.map((r) => r.participantId), ['A', 'B', 'D', 'C']);
  assert.equal(st.rows[0].points, 4);
  assert.equal(st.unresolvedTies.length, 0);
  const custom = computeStandings({ participantIds: ['A', 'B', 'C', 'D'], matches, phase: { ...pts, points: { win: 3, draw: 1, loss: 1, forfeitLoss: 0 } } });
  assert.equal(custom.rows[0].points, 7, 'barème 3-1-1');
});

test('Classement : égalité circulaire départagée par la différence de points, égalité parfaite signalée', () => {
  const cyc = [fin('A', 'B', 1, 0, 60, 0), fin('B', 'C', 1, 0, 30, 0), fin('C', 'A', 1, 0, 10, 0)];
  const st = computeStandings({ participantIds: ['A', 'B', 'C'], matches: cyc, phase: pts });
  // Diff. de points : A +60-10 = +50, B -60+30 = -30, C -30+10 = -20
  assert.deepEqual(st.rows.map((r) => r.participantId), ['A', 'C', 'B']);
  const perfect = [fin('A', 'B', 1, 0, 10, 0), fin('B', 'C', 1, 0, 10, 0), fin('C', 'A', 1, 0, 10, 0)];
  const st2 = computeStandings({ participantIds: ['A', 'B', 'C'], matches: perfect, phase: pts });
  assert.equal(st2.unresolvedTies.length, 1);
  assert.ok(st2.rows.every((r) => r.tied && r.rank === 1));
  const manual = computeStandings({ participantIds: ['A', 'B', 'C'], matches: perfect, phase: pts, manualOrder: ['C', 'A', 'B'] });
  assert.deepEqual(manual.rows.map((r) => r.participantId), ['C', 'A', 'B']);
  const lot1 = computeStandings({ participantIds: ['A', 'B', 'C'], matches: perfect, phase: { ...pts, tiebreakers: [...pts.tiebreakers, 'lot'] }, seed: 's', poolId: 'p' });
  const lot2 = computeStandings({ participantIds: ['A', 'B', 'C'], matches: perfect, phase: { ...pts, tiebreakers: [...pts.tiebreakers, 'lot'] }, seed: 's', poolId: 'p' });
  assert.equal(lot1.unresolvedTies.length, 0);
  assert.deepEqual(lot1.rows.map((r) => r.participantId), lot2.rows.map((r) => r.participantId), 'déterministe');
});

test('Classement : déterminisme (ordre des rencontres indifférent)', () => {
  const ms = [fin('A', 'B', 1, 0, 5, 3), fin('C', 'D', 0, 1, 2, 9), fin('A', 'C', 1, 0, 8, 1), fin('B', 'D', 1, 0, 4, 4), fin('A', 'D', 0, 1, 1, 7), fin('B', 'C', 1, 0, 3, 2)];
  const r1 = computeStandings({ participantIds: ['A', 'B', 'C', 'D'], matches: ms, phase: pts }).rows.map((r) => r.participantId);
  const r2 = computeStandings({ participantIds: ['D', 'C', 'B', 'A'], matches: ms.slice().reverse(), phase: pts }).rows.map((r) => r.participantId);
  assert.deepEqual(r1, r2);
});

test('Qualification mathématique', () => {
  const ids = ['A', 'B', 'C', 'D'];
  const pending = (a, b) => ({ status: 'ready', a, b });
  // A a gagné 2 matchs, D a perdu 2 matchs ; 2 qualifiés.
  const matches = [fin('A', 'B', 1, 0), fin('A', 'C', 1, 0), fin('B', 'D', 1, 0), fin('C', 'D', 1, 0), pending('A', 'D'), pending('B', 'C')];
  const st = mathematicalStatus({ participantIds: ids, matches, phase: pts, qualifiers: 2 });
  assert.equal(st.status.A, 'qualified', 'A (4 pts) : au plus un autre peut atteindre 4');
  assert.equal(st.status.D, 'eliminated', 'D (2 pts max) : A et le vainqueur de B-C auront 4 pts');
  assert.equal(st.status.B, 'open');
  assert.equal(st.status.C, 'open');
  const st1 = mathematicalStatus({ participantIds: ids, matches, phase: pts, qualifiers: 1 });
  assert.equal(st1.status.A, 'open', 'A peut être rejoint à 4 points');
  const st3 = mathematicalStatus({ participantIds: ids, matches, phase: pts, qualifiers: 3 });
  assert.equal(st3.status.B, 'open');
  assert.equal(st3.status.A, 'qualified');
});

test('Vérification de cohérence de la configuration', () => {
  assert.deepEqual(validateConfig(referenceScenarioConfig(), 8).errors, []);
  const w = validateConfig(referenceScenarioConfig(), 8).warnings.join(' ');
  assert.match(w, /tous les participants sont qualifiés/);
  assert.ok(validateConfig(referenceScenarioConfig(), 7).errors.some((e) => /qualifié/.test(e)), '4 qualifiés pour une poule de 3');
  const bad = defaultConfig({ phases: [defaultKnockoutPhase({ id: 'k', allowDraw: true })] });
  assert.ok(validateConfig(bad).errors.some((e) => /nuls sont interdits/.test(e)));
  const tb = defaultConfig({ phases: [defaultPoolsPhase({ tiebreakers: ['legDiff'] })] });
  assert.ok(validateConfig(tb).errors.some((e) => /premier critère/.test(e)));
  assert.ok(validateConfig(defaultConfig(), 3).errors.length, '3 participants pour 2 poules');
  const ko3 = defaultConfig({ phases: [defaultPoolsPhase({ poolCount: 1, qualifiersPerPool: 3 }), defaultKnockoutPhase({ thirdPlaceMatch: true })] });
  assert.ok(validateConfig(ko3, 5).errors.some((e) => /petite finale/.test(e)));
});
