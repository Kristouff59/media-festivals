// Cricket Cut-Throat.
//  - Mêmes cibles et même fermeture que le Cricket (marquage partagé).
//  - Les marques excédentaires sur une cible fermée ajoutent leur valeur AUX
//    ADVERSAIRES qui n'ont pas encore fermé cette cible (points de pénalité).
//  - Le score le plus FAIBLE est le meilleur.
//  - Victoire : avoir fermé toutes les cibles ET avoir un score inférieur ou
//    égal à celui de chaque adversaire.
//  - Limite de tours : le score le plus faible l'emporte ; égalité → nul si
//    autorisé, sinon départage obligatoire.
//  - Différence de points orientée : « points pour » = points infligés à
//    l'adversaire (= son score), « points contre » = points reçus (= son propre score).
import * as B from './cricketBoard.js';
import { validateCricketFamily } from './cricket.js';

export const id = 'cutthroat';
export const label = 'Cricket Cut-Throat';
export const defaultOptions = {};
export const higherIsBetter = false;

export function createLeg(options = {}, sides = 2) {
  return { game: id, options, ...B.createBoard(sides) };
}

function checkWin(leg, side) {
  if (!B.allClosed(leg, side)) return;
  const others = leg.points.filter((_, i) => i !== side);
  if (leg.points[side] <= Math.min(...others)) {
    leg.finished = true;
    leg.winner = side;
  }
}

export function throwDart(leg, dart) {
  if (leg.finished) throw new Error('Manche terminée');
  B.checkDart(dart);
  const side = leg.current;
  const { segment: n, multiplier } = dart;
  if (B.NUMBERS.includes(n)) {
    const extra = B.addMarks(leg, side, n, multiplier);
    if (extra > 0) {
      leg.points.forEach((_, i) => {
        if (i !== side && !B.isClosed(leg, i, n)) leg.points[i] += extra * n;
      });
    }
  }
  // Un tir peut faire gagner le tireur ; il ne peut pas faire gagner un adversaire
  // (ses points ne diminuent jamais), on ne teste donc que le tireur.
  checkWin(leg, side);
  if (!leg.finished) B.advance(leg);
  return {};
}

export function endVisitEarly(leg) {
  if (!leg.finished) B.endVisit(leg);
}

export const isTurnLimitReached = B.isTurnLimitReached;

export function legToSummary(leg, turnLimit) {
  return {
    endedBy: leg.finished ? 'closed' : 'turnLimit',
    winner: leg.finished ? (leg.winner === 0 ? 'a' : 'b') : undefined,
    pointsA: leg.points[0],
    pointsB: leg.points[1],
    closedA: B.allClosed(leg, 0),
    closedB: B.allClosed(leg, 1),
    marksA: B.totalMarks(leg, 0),
    marksB: B.totalMarks(leg, 1),
    turns: leg.finished ? leg.turn : turnLimit,
  };
}

/** >0 si A est mieux placé : en Cut-Throat, le score le plus bas est meilleur. */
export function compare(pointsA, pointsB) {
  return pointsB - pointsA;
}

export function validateLeg(input, ctx) {
  return validateCricketFamily(input, ctx, {
    compare,
    label,
    compareText: 'points ≤ adversaire',
    // points pour A = score de B (infligés), points pour B = score de A.
    orient: (a, b) => ({ forA: b, forB: a }),
  });
}
