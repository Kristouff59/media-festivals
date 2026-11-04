// Règles du 501 (et plus généralement X01) — module indépendant des Cricket.
//
// Règles appliquées :
//  - chaque camp part de `startScore` (501 par défaut) ;
//  - double-out (configurable, activé par défaut) : la manche ne se termine
//    que sur un double (bull 50 compris) amenant le reste exactement à 0 ;
//  - « bust » : score dépassant le reste, reste à 1 en double-out, ou 0 sans
//    double → la volée ne compte pas et le reste revient à sa valeur initiale ;
//  - limite de tours : si personne n'a terminé, la manche est arbitrée selon
//    la règle de la phase (reste le plus faible gagne ; égalité → nul si autorisé,
//    sinon départage obligatoire saisi par l'arbitre).
import { DomainError } from '../errors.js';

export const id = '501';
export const label = '501 (double-out)';

export const defaultOptions = { startScore: 501, doubleOut: true };

// Totaux de volée (3 fléchettes) impossibles à réaliser.
const IMPOSSIBLE_VISITS = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);
// Finitions double-out impossibles en une volée.
const IMPOSSIBLE_CHECKOUTS = new Set([159, 162, 163, 165, 166, 168, 169]);

export function isValidVisitScore(score) {
  return Number.isInteger(score) && score >= 0 && score <= 180 && !IMPOSSIBLE_VISITS.has(score);
}

export function isPossibleCheckout(remaining, doubleOut = true) {
  if (!doubleOut) return remaining >= 1 && remaining <= 180 && !IMPOSSIBLE_VISITS.has(remaining);
  return remaining >= 2 && remaining <= 170 && !IMPOSSIBLE_CHECKOUTS.has(remaining);
}

// ----- Moteur de saisie en direct (par volée ou par fléchette) -----

export function createLeg(options = {}, sides = 2) {
  const o = { ...defaultOptions, ...options };
  return {
    game: id,
    options: o,
    remaining: Array(sides).fill(o.startScore),
    visits: Array.from({ length: sides }, () => []),
    current: 0,
    dartsInVisit: 0,
    visitStart: o.startScore,
    turn: 1, // tour en cours (un tour = une volée de chaque camp)
    winner: null,
    finished: false,
  };
}

function endVisit(leg, scored, bust) {
  const side = leg.current;
  leg.visits[side].push({ scored: bust ? 0 : scored, bust });
  leg.dartsInVisit = 0;
  if (leg.finished) return;
  leg.current = (side + 1) % leg.remaining.length;
  if (leg.current === 0) leg.turn += 1;
  leg.visitStart = leg.remaining[leg.current];
}

/** Fléchette : segment 0..20 ou 25, multiplicateur 1..3 (bull : 1 ou 2). */
export function throwDart(leg, { segment, multiplier }) {
  if (leg.finished) throw new DomainError('LEG_FINISHED', 'La manche est terminée.');
  if (!(Number.isInteger(segment) && ((segment >= 0 && segment <= 20) || segment === 25)))
    throw new DomainError('INVALID_DART', 'Segment invalide.');
  if (![1, 2, 3].includes(multiplier) || (segment === 25 && multiplier === 3))
    throw new DomainError('INVALID_DART', 'Multiplicateur invalide.');
  const side = leg.current;
  const value = segment * (segment === 0 ? 0 : multiplier);
  const after = leg.remaining[side] - value;
  const { doubleOut } = leg.options;
  const bust = after < 0 || (doubleOut && after === 1) || (after === 0 && doubleOut && multiplier !== 2);
  if (bust) {
    leg.remaining[side] = leg.visitStart;
    endVisit(leg, 0, true);
    return { bust: true };
  }
  leg.remaining[side] = after;
  leg.dartsInVisit += 1;
  if (after === 0) {
    leg.finished = true;
    leg.winner = side;
    endVisit(leg, leg.visitStart, false);
    return { checkout: true };
  }
  if (leg.dartsInVisit === 3) endVisit(leg, leg.visitStart - after, false);
  return {};
}

/** Volée saisie en total : `checkoutOnDouble` indique que la dernière fléchette était un double. */
export function applyVisit(leg, score, { checkoutOnDouble = false } = {}) {
  if (leg.finished) throw new DomainError('LEG_FINISHED', 'La manche est terminée.');
  if (!isValidVisitScore(score)) throw new DomainError('INVALID_VISIT', `Score de volée impossible : ${score}.`);
  const side = leg.current;
  const rem = leg.remaining[side];
  const after = rem - score;
  const { doubleOut } = leg.options;
  let bust = after < 0 || (doubleOut && after === 1);
  if (after === 0) {
    if (!isPossibleCheckout(rem, doubleOut)) bust = true;
    if (doubleOut && !checkoutOnDouble) bust = true;
  }
  if (bust) {
    endVisit(leg, 0, true);
    return { bust: true };
  }
  leg.remaining[side] = after;
  if (after === 0) {
    leg.finished = true;
    leg.winner = side;
  }
  endVisit(leg, score, false);
  return after === 0 ? { checkout: true } : {};
}

/** Clôture par limite de tours atteinte. */
export function isTurnLimitReached(leg, turnLimit) {
  return !!turnLimit && !leg.finished && leg.turn > turnLimit;
}

/** Convertit l'état d'une manche jouée en saisie résumée. */
export function legToSummary(leg, turnLimit) {
  if (leg.finished) {
    return {
      endedBy: 'checkout',
      remainingA: leg.remaining[0],
      remainingB: leg.remaining[1],
      turns: Math.max(leg.visits[0].length, leg.visits[1].length),
    };
  }
  return { endedBy: 'turnLimit', remainingA: leg.remaining[0], remainingB: leg.remaining[1], turns: turnLimit };
}

// ----- Validation d'une manche saisie en résumé -----

function intIn(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/**
 * input : { endedBy: 'checkout'|'turnLimit', remainingA, remainingB, turns?, tiebreakWinner? }
 * ctx   : { options, turnLimit, allowDrawLeg }
 * Retour : manche normalisée { winner: 'a'|'b'|null, decidedBy, forA, forB, detail }
 *   forA/forB : points marqués (startScore - reste), base de la différence de points.
 */
export function validateLeg(input, ctx) {
  const o = { ...defaultOptions, ...(ctx.options || {}) };
  const errors = [];
  const { endedBy, remainingA, remainingB, turns, tiebreakWinner } = input || {};
  const S = o.startScore;
  for (const [k, v] of [['A', remainingA], ['B', remainingB]]) {
    if (!intIn(v, 0, S)) errors.push(`Reste du camp ${k} invalide (entier entre 0 et ${S}).`);
    else if (o.doubleOut && v === 1) errors.push(`Reste du camp ${k} impossible en double-out (1).`);
  }
  if (turns !== undefined && turns !== null) {
    if (!intIn(turns, 1, 10000)) errors.push('Nombre de tours invalide.');
    else if (ctx.turnLimit && turns > ctx.turnLimit) errors.push(`Nombre de tours supérieur à la limite (${ctx.turnLimit}).`);
    else {
      for (const [k, v] of [['A', remainingA], ['B', remainingB]]) {
        if (Number.isInteger(v) && S - v > 180 * turns) errors.push(`Camp ${k} : ${S - v} points impossibles en ${turns} tour(s).`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  let winner = null;
  let decidedBy;
  if (endedBy === 'checkout') {
    if ((remainingA === 0) === (remainingB === 0)) return { ok: false, errors: ['En fin de manche par finition, exactement un camp doit avoir un reste de 0.'] };
    winner = remainingA === 0 ? 'a' : 'b';
    decidedBy = 'checkout';
  } else if (endedBy === 'turnLimit') {
    if (!ctx.turnLimit) return { ok: false, errors: ['Aucune limite de tours n\'est définie pour cette rencontre.'] };
    if (remainingA === 0 || remainingB === 0) return { ok: false, errors: ['Un reste de 0 signifie une finition : choisir « finition ».'] };
    decidedBy = 'turnLimit';
    if (remainingA !== remainingB) winner = remainingA < remainingB ? 'a' : 'b';
    else if (tiebreakWinner === 'a' || tiebreakWinner === 'b') {
      winner = tiebreakWinner;
      decidedBy = 'tiebreak';
    } else if (!ctx.allowDrawLeg) {
      return { ok: false, errors: ['Égalité à la limite de tours : un départage (ex. bull-off) est obligatoire, indiquer son vainqueur.'] };
    }
  } else {
    return { ok: false, errors: ['Indiquer comment la manche s\'est terminée (finition ou limite de tours).'] };
  }
  return {
    ok: true,
    leg: {
      winner,
      decidedBy,
      forA: S - remainingA,
      forB: S - remainingB,
      detail: { endedBy, remainingA, remainingB, turns: turns ?? null, tiebreakWinner: decidedBy === 'tiebreak' ? winner : null },
    },
  };
}
