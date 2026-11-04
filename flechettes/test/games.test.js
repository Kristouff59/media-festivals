import test from 'node:test';
import assert from 'node:assert/strict';
import * as x01 from '../src/engine/games/x01.js';
import * as cricket from '../src/engine/games/cricket.js';
import * as cutthroat from '../src/engine/games/cutthroat.js';

const dart = (segment, multiplier = 1) => ({ segment, multiplier });

test('501 : bust si le score dépasse le reste, laisse 1, ou finit sans double', () => {
  let leg = x01.createLeg();
  leg.remaining[0] = 40; leg.visitStart = 40;
  x01.throwDart(leg, dart(20, 3)); // 60 > 40
  assert.equal(leg.remaining[0], 40);
  assert.equal(leg.visits[0].at(-1).bust, true);
  assert.equal(leg.current, 1, 'le bust termine la volée');

  leg = x01.createLeg();
  leg.remaining[0] = 21; leg.visitStart = 21;
  x01.throwDart(leg, dart(20)); // laisse 1
  assert.equal(leg.remaining[0], 21);

  leg = x01.createLeg();
  leg.remaining[0] = 20; leg.visitStart = 20;
  x01.throwDart(leg, dart(20)); // 0 sans double
  assert.equal(leg.remaining[0], 20);
  assert.equal(leg.finished, false);
});

test('501 : finition sur double et sur bull (50)', () => {
  let leg = x01.createLeg();
  leg.remaining[0] = 40; leg.visitStart = 40;
  x01.throwDart(leg, dart(20, 2));
  assert.equal(leg.finished, true);
  assert.equal(leg.winner, 0);
  leg = x01.createLeg();
  leg.remaining[0] = 50; leg.visitStart = 50;
  x01.throwDart(leg, dart(25, 2));
  assert.equal(leg.finished, true);
});

test('501 : volées impossibles et finitions impossibles', () => {
  assert.equal(x01.isValidVisitScore(180), true);
  assert.equal(x01.isValidVisitScore(179), false);
  assert.equal(x01.isValidVisitScore(181), false);
  assert.equal(x01.isPossibleCheckout(170), true);
  assert.equal(x01.isPossibleCheckout(169), false);
  assert.equal(x01.isPossibleCheckout(1), false);
  const leg = x01.createLeg();
  assert.throws(() => x01.applyVisit(leg, 179));
  leg.remaining[0] = 168;
  x01.applyVisit(leg, 168, { checkoutOnDouble: true });
  assert.equal(leg.finished, false, '168 (T20 T20 T16) n\'est pas une finition possible');
  assert.equal(leg.remaining[0], 168);
});

test('501 : validation résumée d\'une manche', () => {
  const ctx = { turnLimit: 10, allowDrawLeg: false };
  assert.equal(x01.validateLeg({ endedBy: 'checkout', remainingA: 0, remainingB: 32 }, ctx).leg.winner, 'a');
  assert.equal(x01.validateLeg({ endedBy: 'checkout', remainingA: 0, remainingB: 0 }, ctx).ok, false);
  assert.equal(x01.validateLeg({ endedBy: 'checkout', remainingA: 1, remainingB: 0 }, ctx).ok, false, 'reste 1 impossible en double-out');
  assert.equal(x01.validateLeg({ endedBy: 'checkout', remainingA: 0, remainingB: 40, turns: 2 }, ctx).ok, false, '501 points en 2 tours impossible');
  const lim = x01.validateLeg({ endedBy: 'turnLimit', remainingA: 60, remainingB: 32 }, ctx);
  assert.equal(lim.leg.winner, 'b', 'le reste le plus faible gagne à la limite');
  assert.equal(lim.leg.forA, 441);
  assert.equal(lim.leg.forB, 469);
  assert.equal(x01.validateLeg({ endedBy: 'turnLimit', remainingA: 40, remainingB: 40 }, ctx).ok, false, 'égalité : départage obligatoire');
  assert.equal(x01.validateLeg({ endedBy: 'turnLimit', remainingA: 40, remainingB: 40, tiebreakWinner: 'b' }, ctx).leg.decidedBy, 'tiebreak');
  assert.equal(x01.validateLeg({ endedBy: 'turnLimit', remainingA: 40, remainingB: 40 }, { turnLimit: 10, allowDrawLeg: true }).leg.winner, null, 'nul permis si autorisé');
  assert.equal(x01.validateLeg({ endedBy: 'turnLimit', remainingA: 40, remainingB: 30 }, { turnLimit: null }).ok, false, 'pas de limite définie');
});

test('Cricket : marquage, points pour le tireur seulement si l\'adversaire n\'a pas fermé', () => {
  const leg = cricket.createLeg();
  cricket.throwDart(leg, dart(20, 3)); // A ferme le 20
  cricket.throwDart(leg, dart(20, 2)); // +40
  assert.equal(leg.points[0], 40);
  cricket.throwDart(leg, dart(0));
  // B ferme le 20
  cricket.throwDart(leg, dart(20, 3));
  cricket.throwDart(leg, dart(0)); cricket.throwDart(leg, dart(0));
  // A tire encore sur le 20 : fermé des deux côtés → 0 point
  cricket.throwDart(leg, dart(20, 3));
  assert.equal(leg.points[0], 40);
  assert.equal(leg.points[1], 0);
});

test('Cricket : victoire = tout fermé ET points ≥ adversaire', () => {
  const leg = cricket.createLeg();
  leg.points[1] = 50; // B devant
  for (const n of [20, 19, 18, 17, 16, 15]) leg.marks[0][n] = 3;
  leg.marks[0][25] = 2;
  cricket.throwDart(leg, dart(25)); // A ferme tout mais est derrière
  assert.equal(leg.finished, false);
  cricket.throwDart(leg, dart(20, 3)); // +60 (B n'a pas fermé le 20)
  assert.equal(leg.finished, true);
  assert.equal(leg.winner, 0);
});

test('Cut-Throat : les points vont aux adversaires, le score le plus bas gagne', () => {
  const leg = cutthroat.createLeg();
  cutthroat.throwDart(leg, dart(20, 3));
  cutthroat.throwDart(leg, dart(20, 2)); // B reçoit 40
  assert.deepEqual(leg.points, [0, 40]);
  // A ferme tout avec 0 point ≤ 40 → victoire
  for (const n of [19, 18, 17, 16, 15]) leg.marks[0][n] = 3;
  leg.marks[0][25] = 2;
  cutthroat.throwDart(leg, dart(25));
  assert.equal(leg.finished, true);
  assert.equal(leg.winner, 0);
});

test('Cut-Throat : tout fermer avec plus de points ne suffit pas', () => {
  const leg = cutthroat.createLeg();
  leg.points[0] = 30;
  for (const n of [20, 19, 18, 17, 16, 15]) leg.marks[0][n] = 3;
  leg.marks[0][25] = 2;
  cutthroat.throwDart(leg, dart(25));
  assert.equal(leg.finished, false);
});

test('Cricket vs Cut-Throat : règles jamais mélangées (même saisie, vainqueurs opposés)', () => {
  const input = { endedBy: 'turnLimit', pointsA: 120, pointsB: 80, closedA: false, closedB: false };
  const ctx = { turnLimit: 10 };
  const c = cricket.validateLeg(input, ctx);
  const ct = cutthroat.validateLeg(input, ctx);
  assert.equal(c.leg.winner, 'a');
  assert.equal(ct.leg.winner, 'b');
  assert.equal(c.leg.forA - c.leg.forB, 40, 'Cricket : différence = points A - points B');
  assert.equal(ct.leg.forA - ct.leg.forB, -40, 'Cut-Throat : différence = points infligés - points reçus');
});

test('Cricket : validation résumée (fermeture, limite, incohérences)', () => {
  const ctx = { turnLimit: 10 };
  assert.equal(cricket.validateLeg({ endedBy: 'closed', winner: 'a', pointsA: 100, pointsB: 60, closedA: true }, ctx).ok, true);
  assert.equal(cricket.validateLeg({ endedBy: 'closed', winner: 'a', pointsA: 50, pointsB: 60, closedA: true }, ctx).ok, false, 'vainqueur derrière au score');
  assert.equal(cricket.validateLeg({ endedBy: 'closed', winner: 'a', pointsA: 100, pointsB: 60, closedA: false }, ctx).ok, false, 'vainqueur non fermé');
  assert.equal(cricket.validateLeg({ endedBy: 'turnLimit', pointsA: 100, pointsB: 60, closedA: true }, ctx).ok, false, 'condition de victoire déjà remplie');
  assert.equal(cricket.validateLeg({ endedBy: 'turnLimit', pointsA: 60, pointsB: 60 }, ctx).ok, false, 'égalité sans départage');
  assert.equal(cricket.validateLeg({ endedBy: 'turnLimit', pointsA: 60, pointsB: 60, tiebreakWinner: 'b' }, ctx).leg.winner, 'b');
  assert.equal(cutthroat.validateLeg({ endedBy: 'closed', winner: 'b', pointsA: 100, pointsB: 60, closedB: true }, ctx).ok, true);
  assert.equal(cutthroat.validateLeg({ endedBy: 'closed', winner: 'a', pointsA: 100, pointsB: 60, closedA: true }, ctx).ok, false);
});

test('Limites de tours : les moteurs détectent la fin de la manche', () => {
  const leg = cricket.createLeg();
  for (let i = 0; i < 6 * 2; i++) cricket.throwDart(leg, dart(0)), cricket.throwDart(leg, dart(0)), cricket.throwDart(leg, dart(0));
  assert.equal(cricket.isTurnLimitReached(leg, 6), true);
  assert.equal(cricket.isTurnLimitReached(leg, 7), false);
  const s = cricket.legToSummary(leg, 6);
  assert.equal(s.endedBy, 'turnLimit');
});
