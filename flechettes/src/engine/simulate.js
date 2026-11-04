// Simulation (mode démonstration) : un « bot » lance les fléchettes une à une
// à travers les VRAIS moteurs de jeu ; le résultat produit passe ensuite par
// la même validation que les saisies réelles.
import * as x01 from './games/x01.js';
import * as cricket from './games/cricket.js';
import * as cutthroat from './games/cutthroat.js';
import { NUMBERS, isClosed } from './games/cricketBoard.js';
import { evaluateResult } from './match.js';

const BOARD = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

function throwAt(rng, segment, multiplier, skill) {
  const r = rng();
  if (segment === 25) {
    if (r < skill * 0.5) return { segment: 25, multiplier };
    if (r < skill) return { segment: 25, multiplier: 1 };
    return { segment: BOARD[Math.floor(rng() * 20)], multiplier: 1 };
  }
  if (r < skill) return { segment, multiplier };
  if (r < skill + (1 - skill) * 0.5) return { segment, multiplier: 1 };
  if (r < 0.97) {
    const i = BOARD.indexOf(segment);
    return { segment: BOARD[(i + (rng() < 0.5 ? 1 : 19)) % 20], multiplier: 1 };
  }
  return { segment: 0, multiplier: 1 };
}

function x01Aim(rem) {
  if (rem === 50) return [25, 2];
  if (rem <= 40 && rem % 2 === 0) return [rem / 2, 2];
  if (rem <= 40) return [1, 1];
  if (rem <= 60) return [rem - 40, 1];
  if (rem <= 100 && rem - 60 <= 40 && (rem - 60) % 2 === 0) return [20, 3];
  if (rem < 100) return [Math.min(20, rem - 40), 1];
  return [20, 3];
}

function cricketAim(leg, side, variant) {
  const opp = 1 - side;
  const own = NUMBERS.find((n) => !isClosed(leg, side, n));
  const scoringTargets = NUMBERS.filter((n) => isClosed(leg, side, n) && !isClosed(leg, opp, n));
  const better = variant === 'cutthroat' ? leg.points[side] <= leg.points[opp] : leg.points[side] >= leg.points[opp];
  if (own && (better || !scoringTargets.length)) return [own, own === 25 ? 1 : 3];
  if (scoringTargets.length) return [scoringTargets[0], scoringTargets[0] === 25 ? 1 : 3];
  return [own ?? 20, 3];
}

export function simulateLeg(rules, rng, skills = [0.35, 0.35]) {
  const engines = { '501': x01, cricket, cutthroat };
  const eng = engines[rules.game];
  const leg = eng.createLeg(rules.gameOptions || {});
  let guard = 0;
  while (!leg.finished && !eng.isTurnLimitReached(leg, rules.turnLimit) && guard++ < 5000) {
    const side = leg.current;
    const [seg, mult] = rules.game === '501' ? x01Aim(leg.remaining[side]) : cricketAim(leg, side, rules.game);
    eng.throwDart(leg, throwAt(rng, seg, mult, skills[side]));
  }
  if (!leg.finished && !rules.turnLimit) {
    // Sécurité théorique : sans limite de tours, on force une fin par limite artificielle.
    return null;
  }
  return eng.legToSummary(leg, rules.turnLimit);
}

/** Produit une saisie de résultat complète et valide pour une rencontre. */
export function simulateResult(rules, rng, { skills } = {}) {
  const sk = skills || [0.25 + rng() * 0.25, 0.25 + rng() * 0.25];
  const legs = [];
  for (let i = 0; i < 25; i++) {
    let summary = simulateLeg(rules, rng, sk);
    if (!summary) summary = simulateLeg({ ...rules, turnLimit: 60 }, rng, sk);
    const test = evaluateResult(rules, { legs: [...legs, summary] });
    if (!test.ok && test.errors.some((e) => /départage est obligatoire|départage \(ex\. bull-off\)/.test(e))) summary.tiebreakWinner = rng() < 0.5 ? 'a' : 'b';
    legs.push(summary);
    const r = evaluateResult(rules, { legs });
    if (r.ok) return { legs };
    if (!r.partial) {
      // Résultat invalide : impossible par construction — on le signale.
      throw new Error(`Simulation invalide : ${r.errors.join(' ')}`);
    }
  }
  throw new Error('Simulation : rencontre non conclue.');
}

const FIRST = ['Alex', 'Camille', 'Sam', 'Charlie', 'Dominique', 'Lou', 'Noa', 'Eden', 'Sacha', 'Maxime', 'Andréa', 'Claude', 'Morgan', 'Jules', 'Robin', 'Yaël', 'Ange', 'Lilou', 'Mika', 'Swann', 'Tom', 'Léa', 'Hugo', 'Inès'];
const LAST = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier'];
const TEAM = ['Les Triples', 'Bull’s Eye', 'Les Flèches d’Or', 'Double Top', 'Les Pointus', 'Cible Mouvante', 'Les Tontons Darts', 'Shanghai Club', 'Les Ailettes', 'Treble Twenty', 'Les Bustés', 'Checkout Crew', 'Les Volées', 'Mad Darts', 'Les Plumes', 'Oche Boys'];

/** Participants fictifs (mode démo uniquement). */
export function fakeParticipants(count, { mode = 'team', teamSize = 2, rng = Math.random } = {}) {
  const used = new Set();
  const person = () => {
    for (;;) {
      const n = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
  return Array.from({ length: count }, (_, i) => {
    if (mode === 'individual') return { name: person(), players: [] };
    const name = i < TEAM.length ? TEAM[i] : `Équipe démo ${i + 1}`;
    return { name, players: Array.from({ length: teamSize }, person) };
  });
}
