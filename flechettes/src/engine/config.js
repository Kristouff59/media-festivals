// Configuration d'un tournoi : aucune limite ni aucun format codé en dur ;
// tout est paramétrable, avec des valeurs par défaut documentées (docs/DECISIONS.md).
import { GAMES } from './games/index.js';

export const TIEBREAKERS = {
  points: 'Points de classement',
  wins: 'Nombre de victoires',
  headToHead: 'Confrontation(s) directe(s)',
  legDiff: 'Différence de manches',
  legsWon: 'Manches gagnées',
  pointDiff: 'Différence de points (orientée selon le jeu)',
  pointsFor: 'Points marqués (Cut-Throat : points infligés)',
  lot: 'Tirage au sort reproductible',
};

export const DEFAULT_TIEBREAKERS = ['points', 'headToHead', 'legDiff', 'pointDiff', 'legsWon'];

export function defaultPoolsPhase(overrides = {}) {
  return {
    id: 'p1',
    name: 'Phase de poules',
    type: 'pools',
    game: 'cricket',
    gameOptions: {},
    poolCount: 2,
    qualifiersPerPool: 2,
    drawMethod: 'random', // random | seeded (têtes de série réparties en serpentin)
    bestOf: 1,
    turnLimit: 10,
    allowDraw: false,
    points: { win: 2, draw: 1, loss: 0, forfeitLoss: 0 },
    tiebreakers: DEFAULT_TIEBREAKERS.slice(),
    ...overrides,
  };
}

export function defaultKnockoutPhase(overrides = {}) {
  return {
    id: 'p2',
    name: 'Phase finale',
    type: 'knockout',
    game: 'cricket',
    gameOptions: {},
    bestOf: 1,
    turnLimit: 20,
    thirdPlaceMatch: true,
    avoidSamePool: true,
    seeding: 'ranking', // ranking : classement inter-poules ; random : tirage intégral
    placement: 'tied', // tied : perdants d'un même tour ex aequo ; bySeed : départagés par leur tête de série
    roundOverrides: {}, // clés : r2 (finale), r4 (demies), r8 (quarts), ..., third (petite finale)
    ...overrides,
  };
}

export function defaultConfig(overrides = {}) {
  return {
    mode: 'team', // individual | team
    teamSize: 2,
    maxParticipants: null,
    requirePresenceConfirmation: true,
    allowReplacement: true,
    publicRegistration: false,
    withdrawalPolicy: 'forfeitRemaining', // forfeitRemaining | annulAll (poules)
    disqualificationPolicy: 'annulAll', // forfeitRemaining | annulAll (poules)
    requireResultValidation: true, // les saisies d'un responsable de cible doivent être validées
    scheduling: {
      autoAssign: true,
      minRestMinutes: 5,
      allowBackToBack: true,
      estimatedLegMinutes: { '501': 8, cricket: 10, cutthroat: 10 },
      lateAfterMinutes: 10,
    },
    phases: [defaultPoolsPhase(), defaultKnockoutPhase()],
    ...overrides,
  };
}

/** Scénario de référence du cahier des charges (section 20). */
export function referenceScenarioConfig(game = 'cricket') {
  return defaultConfig({
    mode: 'team',
    teamSize: 2,
    maxParticipants: 8,
    phases: [
      defaultPoolsPhase({ game, poolCount: 2, qualifiersPerPool: 4, turnLimit: 10, bestOf: 1, allowDraw: false }),
      defaultKnockoutPhase({
        game,
        bestOf: 1,
        turnLimit: 20,
        thirdPlaceMatch: true,
        roundOverrides: { r2: { bestOf: 3, turnLimit: 20 } },
      }),
    ],
  });
}

export const PRESETS = {
  reference: { label: 'Scénario de référence : 8 équipes de 2, 2 poules, quarts → finale BO3', build: () => referenceScenarioConfig('cricket') },
  referenceCutthroat: { label: 'Scénario de référence en Cut-Throat', build: () => referenceScenarioConfig('cutthroat') },
  poolsOnly: { label: 'Championnat en poules uniquement', build: () => defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultPoolsPhase({ poolCount: 1, qualifiersPerPool: 1, game: '501', bestOf: 3, turnLimit: null })] }) },
  knockoutOnly: { label: 'Élimination directe uniquement', build: () => defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultKnockoutPhase({ id: 'p1', game: '501', bestOf: 3, turnLimit: null, roundOverrides: { r2: { bestOf: 5 } } })] }) },
  pools501: { label: '501 individuel : poules puis élimination directe', build: () => defaultConfig({ mode: 'individual', teamSize: 1, phases: [defaultPoolsPhase({ game: '501', poolCount: 4, qualifiersPerPool: 2, bestOf: 3, turnLimit: 15 }), defaultKnockoutPhase({ game: '501', bestOf: 3, turnLimit: null, roundOverrides: { r2: { bestOf: 5 } } })] }) },
};

export function roundKey(matchesInRound) {
  return `r${matchesInRound * 2}`;
}

export function roundName(matchesInRound) {
  switch (matchesInRound) {
    case 1: return 'Finale';
    case 2: return 'Demi-finales';
    case 4: return 'Quarts de finale';
    case 8: return 'Huitièmes de finale';
    case 16: return 'Seizièmes de finale';
    case 32: return 'Trente-deuxièmes de finale';
    default: return `Tour à ${matchesInRound * 2}`;
  }
}

function isPosInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Vérifie la cohérence de la configuration (et, si fourni, du nombre de
 * participants effectifs). Retourne { errors, warnings }.
 */
export function validateConfig(config, participantCount = null) {
  const errors = [];
  const warnings = [];
  if (!['individual', 'team'].includes(config.mode)) errors.push('Mode de tournoi invalide (individuel ou équipes).');
  if (config.mode === 'team' && !isPosInt(config.teamSize)) errors.push('Nombre de joueurs par équipe invalide.');
  if (config.maxParticipants !== null && config.maxParticipants !== undefined && !isPosInt(config.maxParticipants)) errors.push('Nombre maximal de participants invalide.');
  if (!['forfeitRemaining', 'annulAll'].includes(config.withdrawalPolicy)) errors.push('Politique de désistement invalide.');
  if (!['forfeitRemaining', 'annulAll'].includes(config.disqualificationPolicy)) errors.push('Politique de disqualification invalide.');
  const phases = config.phases || [];
  if (!phases.length) errors.push('Au moins une phase est nécessaire.');
  const ids = new Set();
  let entrants = participantCount;
  let previous = null;
  phases.forEach((ph, i) => {
    const P = `Phase ${i + 1} (${ph.name || ph.type})`;
    if (!ph.id || ids.has(ph.id)) errors.push(`${P} : identifiant manquant ou en double.`);
    ids.add(ph.id);
    if (!GAMES[ph.game]) errors.push(`${P} : jeu inconnu.`);
    if (!isPosInt(ph.bestOf)) errors.push(`${P} : Best of invalide.`);
    if (ph.turnLimit !== null && ph.turnLimit !== undefined && !isPosInt(ph.turnLimit)) errors.push(`${P} : limite de tours invalide.`);
    if (ph.type === 'pools') {
      if (!isPosInt(ph.poolCount)) errors.push(`${P} : nombre de poules invalide.`);
      if (!isPosInt(ph.qualifiersPerPool)) errors.push(`${P} : nombre de qualifiés par poule invalide.`);
      if (ph.allowDraw && ph.bestOf % 2 === 1) warnings.push(`${P} : nuls autorisés avec un Best of impair — un nul n'est possible que via une manche nulle à la limite de tours.`);
      const pts = ph.points || {};
      for (const k of ['win', 'draw', 'loss', 'forfeitLoss']) if (!Number.isFinite(pts[k])) errors.push(`${P} : barème « ${k} » manquant.`);
      if (Number.isFinite(pts.win) && Number.isFinite(pts.loss) && pts.win <= pts.loss) errors.push(`${P} : une victoire doit rapporter plus qu'une défaite.`);
      const tb = ph.tiebreakers || [];
      if (!tb.length || tb[0] !== 'points') errors.push(`${P} : le premier critère de classement doit être les points.`);
      for (const t of tb) if (!TIEBREAKERS[t]) errors.push(`${P} : critère de départage inconnu « ${t} ».`);
      if (new Set(tb).size !== tb.length) errors.push(`${P} : critère de départage en double.`);
      if (entrants !== null) {
        if (entrants < ph.poolCount * 2) errors.push(`${P} : ${entrants} participant(s) pour ${ph.poolCount} poule(s) — il faut au moins 2 participants par poule.`);
        const minPool = Math.floor(entrants / ph.poolCount);
        if (ph.qualifiersPerPool > minPool) errors.push(`${P} : ${ph.qualifiersPerPool} qualifié(s) par poule mais la plus petite poule n'aura que ${minPool} participant(s).`);
        if (entrants % ph.poolCount) warnings.push(`${P} : poules de tailles inégales (${entrants} participants / ${ph.poolCount} poules).`);
      }
      if (i < phases.length - 1) {
        if (entrants !== null) entrants = Math.min(entrants, ph.poolCount * ph.qualifiersPerPool);
        else entrants = ph.poolCount * ph.qualifiersPerPool;
      }
    } else if (ph.type === 'knockout') {
      if (ph.allowDraw) errors.push(`${P} : les matchs nuls sont interdits en élimination directe.`);
      if (i !== phases.length - 1) errors.push(`${P} : une phase à élimination directe doit être la dernière phase.`);
      if (!['ranking', 'random'].includes(ph.seeding)) errors.push(`${P} : mode de placement invalide.`);
      for (const [k, o] of Object.entries(ph.roundOverrides || {})) {
        if (!/^r\d+$|^third$/.test(k)) errors.push(`${P} : tour inconnu « ${k} ».`);
        if (o.bestOf !== undefined && !isPosInt(o.bestOf)) errors.push(`${P} : Best of invalide pour ${k}.`);
        if (o.turnLimit !== undefined && o.turnLimit !== null && !isPosInt(o.turnLimit)) errors.push(`${P} : limite de tours invalide pour ${k}.`);
        if (o.game !== undefined && !GAMES[o.game]) errors.push(`${P} : jeu inconnu pour ${k}.`);
      }
      if (entrants !== null) {
        if (entrants < 2) errors.push(`${P} : au moins 2 participants sont nécessaires.`);
        const size = 2 ** Math.ceil(Math.log2(Math.max(2, entrants)));
        if (entrants !== size && entrants >= 2) warnings.push(`${P} : ${entrants} qualifiés — tableau de ${size} avec ${size - entrants} exemption(s).`);
        if (ph.thirdPlaceMatch && entrants < 4) errors.push(`${P} : une petite finale nécessite au moins 4 participants.`);
        if (previous?.type === 'pools' && entrants === participantCount && participantCount !== null)
          warnings.push(`${P} : tous les participants sont qualifiés — la phase de poules sert uniquement au placement dans le tableau.`);
      }
    } else {
      errors.push(`${P} : type de phase inconnu.`);
    }
    previous = ph;
  });
  if (participantCount !== null && config.maxParticipants && participantCount > config.maxParticipants)
    errors.push(`${participantCount} participants pour un maximum de ${config.maxParticipants}.`);
  return { errors, warnings };
}

/** Règles d'un match de phase finale selon le tour (avec surcharges éventuelles). */
export function knockoutRules(phase, key) {
  const o = (phase.roundOverrides || {})[key] || {};
  return {
    game: o.game || phase.game,
    gameOptions: o.gameOptions || phase.gameOptions || {},
    bestOf: o.bestOf ?? phase.bestOf,
    turnLimit: o.turnLimit !== undefined ? o.turnLimit : phase.turnLimit ?? null,
    allowDraw: false,
  };
}

export function poolRules(phase) {
  return {
    game: phase.game,
    gameOptions: phase.gameOptions || {},
    bestOf: phase.bestOf,
    turnLimit: phase.turnLimit ?? null,
    allowDraw: !!phase.allowDraw,
  };
}
