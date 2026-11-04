// Évaluation d'une rencontre : enchaînement des manches, format Best of,
// issues particulières (forfait, abandon, disqualification, exemption).
import { getGame } from './games/index.js';

export const OUTCOMES = ['normal', 'forfeit', 'retired', 'disqualified', 'bye'];

export function legsToWin(bestOf) {
  return Math.floor(bestOf / 2) + 1;
}

/**
 * Règles d'une rencontre, figées sur le match à sa génération :
 * { game, gameOptions, bestOf, turnLimit, allowDraw }
 * input : { outcome?: 'normal'|'forfeit'|'retired'|'disqualified', loser?: 'a'|'b', legs: [...] }
 */
export function evaluateResult(rules, input) {
  const errors = [];
  const game = getGame(rules.game);
  const outcome = input?.outcome || 'normal';
  if (!OUTCOMES.includes(outcome) || outcome === 'bye') return { ok: false, errors: ['Issue de rencontre invalide.'] };
  const legsIn = Array.isArray(input?.legs) ? input.legs : [];
  const need = legsToWin(rules.bestOf);
  const legs = [];
  let la = 0;
  let lb = 0;
  let forA = 0;
  let forB = 0;
  for (let i = 0; i < legsIn.length; i++) {
    if (la >= need || lb >= need) {
      errors.push(`Manche ${i + 1} : la rencontre était déjà décidée (${la}-${lb}).`);
      break;
    }
    const decisive = legs.length >= rules.bestOf; // manche de départage au-delà du Best of
    if (decisive && (la !== lb || rules.allowDraw)) {
      errors.push(`Manche ${i + 1} : au-delà du Best of ${rules.bestOf}, aucune manche supplémentaire n'est prévue.`);
      break;
    }
    // Une manche ne peut être nulle que si la rencontre peut l'être.
    const r = game.validateLeg(legsIn[i], { options: rules.gameOptions, turnLimit: rules.turnLimit, allowDrawLeg: !!rules.allowDraw && !decisive });
    if (!r.ok) {
      errors.push(...r.errors.map((e) => `Manche ${i + 1} : ${e}`));
      continue;
    }
    legs.push(r.leg);
    if (r.leg.winner === 'a') la++;
    else if (r.leg.winner === 'b') lb++;
    forA += r.leg.forA;
    forB += r.leg.forB;
  }
  if (errors.length) return { ok: false, errors };

  const special = outcome !== 'normal';
  if (special) {
    if (input.loser !== 'a' && input.loser !== 'b') return { ok: false, errors: ['Indiquer le camp concerné par le forfait / l\'abandon / la disqualification.'] };
    const winner = input.loser === 'a' ? 'b' : 'a';
    if (outcome !== 'retired' && legs.length) return { ok: false, errors: ['Un forfait ou une disqualification ne comporte pas de manches jouées (utiliser « abandon » si le match avait commencé).'] };
    if (outcome === 'retired' && (la >= need || lb >= need)) return { ok: false, errors: ['La rencontre était déjà décidée : un abandon n\'est plus possible.'] };
    // Le vainqueur est crédité des manches nécessaires à la victoire ; les manches jouées sont conservées.
    const legsA = winner === 'a' ? need : la;
    const legsB = winner === 'b' ? need : lb;
    return { ok: true, result: { outcome, winner, loser: input.loser, legs, legsA, legsB, forA, forB, complete: true } };
  }

  const played = legs.length;
  let complete = false;
  let winner = null;
  if (la >= need || lb >= need) {
    complete = true;
    winner = la > lb ? 'a' : 'b';
  } else if (played >= rules.bestOf) {
    if (la !== lb) {
      complete = true;
      winner = la > lb ? 'a' : 'b';
    } else if (rules.allowDraw) {
      complete = true;
      winner = null;
    }
  }
  if (!complete) {
    const msg = played >= rules.bestOf
      ? `Égalité ${la}-${lb} après ${played} manches : match nul interdit, une manche de départage est nécessaire.`
      : `Rencontre incomplète : ${la}-${lb}, il faut ${need} manche(s) gagnée(s) (Best of ${rules.bestOf}).`;
    return { ok: false, errors: [msg], partial: { legsA: la, legsB: lb } };
  }
  return { ok: true, result: { outcome: 'normal', winner, loser: winner ? (winner === 'a' ? 'b' : 'a') : null, legs, legsA: la, legsB: lb, forA, forB, complete: true } };
}

export function byeResult(side) {
  return { outcome: 'bye', winner: side, loser: side === 'a' ? 'b' : 'a', legs: [], legsA: 0, legsB: 0, forA: 0, forB: 0, complete: true };
}

export function sameDecision(r1, r2) {
  if (!r1 || !r2) return false;
  return r1.winner === r2.winner;
}
