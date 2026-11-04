// Cricket standard.
//  - Cibles : 15 à 20 et bull (simple = 1 marque, double = 2, triple = 3 ; bull 25 = 1, 50 = 2).
//  - Une cible est fermée à 3 marques. Les marques suivantes rapportent leur
//    valeur AU TIREUR tant que l'adversaire n'a pas fermé cette cible.
//  - Victoire : avoir fermé toutes les cibles ET avoir au moins autant de points
//    que l'adversaire.
//  - Limite de tours atteinte : le plus grand nombre de points l'emporte ;
//    égalité → nul si autorisé, sinon départage obligatoire.
import * as B from './cricketBoard.js';

export const id = 'cricket';
export const label = 'Cricket';
export const defaultOptions = {};
export const higherIsBetter = true;

export function createLeg(options = {}, sides = 2) {
  return { game: id, options, ...B.createBoard(sides) };
}

function checkWin(leg, side) {
  if (!B.allClosed(leg, side)) return;
  const others = leg.points.filter((_, i) => i !== side);
  if (leg.points[side] >= Math.max(...others)) {
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
      const opponentsOpen = leg.points.some((_, i) => i !== side && !B.isClosed(leg, i, n));
      if (opponentsOpen) leg.points[side] += extra * n;
    }
  }
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

/** Comparaison des scores : >0 si A est mieux placé que B. */
export function compare(pointsA, pointsB) {
  return pointsA - pointsB;
}

export function validateLeg(input, ctx) {
  return validateCricketFamily(input, ctx, { compare, label, orient: (a, b) => ({ forA: a, forB: b }) });
}

/**
 * Validation résumée commune aux deux variantes, paramétrée par la règle de
 * comparaison du variant (jamais partagée implicitement).
 * input : { endedBy: 'closed'|'turnLimit', winner?, pointsA, pointsB, closedA, closedB, turns?, tiebreakWinner? }
 */
export function validateCricketFamily(input, ctx, variant) {
  const errors = [];
  const { endedBy, pointsA, pointsB, turns, tiebreakWinner } = input || {};
  const closedA = !!input?.closedA;
  const closedB = !!input?.closedB;
  for (const [k, v] of [['A', pointsA], ['B', pointsB]]) {
    if (!Number.isInteger(v) || v < 0 || v > 100000) errors.push(`Points du camp ${k} invalides (entier positif).`);
  }
  if (turns !== undefined && turns !== null) {
    if (!Number.isInteger(turns) || turns < 1) errors.push('Nombre de tours invalide.');
    else if (ctx.turnLimit && turns > ctx.turnLimit) errors.push(`Nombre de tours supérieur à la limite (${ctx.turnLimit}).`);
  }
  if (errors.length) return { ok: false, errors };
  const cmp = variant.compare(pointsA, pointsB); // >0 : A mieux placé
  // Un camp ayant tout fermé avec un score au moins équivalent a gagné dès cet instant.
  const aWinsByClose = closedA && cmp >= 0;
  const bWinsByClose = closedB && cmp <= 0;
  let winner = null;
  let decidedBy;
  if (endedBy === 'closed') {
    const w = input.winner;
    if (w !== 'a' && w !== 'b') return { ok: false, errors: ['Indiquer le camp vainqueur de la manche.'] };
    const wClosed = w === 'a' ? closedA : closedB;
    const wCmp = w === 'a' ? cmp : -cmp;
    if (!wClosed) return { ok: false, errors: [`${variant.label} : le vainqueur doit avoir fermé toutes les cibles.`] };
    if (wCmp < 0) return { ok: false, errors: [`${variant.label} : le vainqueur doit avoir un score au moins équivalent à celui de l'adversaire (${variant.compareText || 'points ≥ adversaire'}).`] };
    // Si le perdant a aussi tout fermé, il l'a fait en étant derrière au score
    // (sinon il aurait gagné) : situation valide, le vainqueur déclaré fait foi.
    winner = w;
    decidedBy = 'closed';
  } else if (endedBy === 'turnLimit') {
    if (!ctx.turnLimit) return { ok: false, errors: ['Aucune limite de tours n\'est définie pour cette rencontre.'] };
    if (aWinsByClose || bWinsByClose) return { ok: false, errors: ['Un camp remplissait la condition de victoire (tout fermé, score suffisant) : la manche s\'est terminée par fermeture, pas à la limite de tours.'] };
    decidedBy = 'turnLimit';
    if (cmp !== 0) winner = cmp > 0 ? 'a' : 'b';
    else if (tiebreakWinner === 'a' || tiebreakWinner === 'b') {
      winner = tiebreakWinner;
      decidedBy = 'tiebreak';
    } else if (!ctx.allowDrawLeg) {
      return { ok: false, errors: ['Égalité de points à la limite de tours : un départage est obligatoire, indiquer son vainqueur.'] };
    }
  } else {
    return { ok: false, errors: ['Indiquer comment la manche s\'est terminée (fermeture ou limite de tours).'] };
  }
  const { forA, forB } = variant.orient(pointsA, pointsB);
  return {
    ok: true,
    leg: {
      winner,
      decidedBy,
      forA,
      forB,
      detail: {
        endedBy, winner: endedBy === 'closed' ? winner : undefined, pointsA, pointsB, closedA, closedB, turns: turns ?? null,
        marksA: Number.isInteger(input.marksA) ? input.marksA : null,
        marksB: Number.isInteger(input.marksB) ? input.marksB : null,
        tiebreakWinner: decidedBy === 'tiebreak' ? winner : null,
      },
    },
  };
}
