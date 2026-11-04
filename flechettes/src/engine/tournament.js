// Agrégat « tournoi » : toutes les modifications passent par applyCommand(),
// qui valide la commande, l'applique sur une copie de l'état, recalcule les
// données dépendantes (tableau, phases, cibles) et renvoie un nouvel état.
// Une commande invalide lève une DomainError et ne modifie rien.
import { DomainError, assert, normalizeName } from './errors.js';
import { validateConfig, poolRules, defaultConfig } from './config.js';
import { drawPools } from './pools.js';
import { roundRobin } from './roundRobin.js';
import { buildBracket } from './bracket.js';
import { evaluateResult, byeResult } from './match.js';
import { computeStandings, crossPoolCompare } from './standings.js';
import { proposeAssignments, busyParticipants, targetOccupancy, OCCUPYING_STATUSES } from './scheduler.js';
import { createRng, shuffle, randomSeed } from './rng.js';
import { computeFinalRanking } from './ranking.js';

export const SCHEMA_VERSION = 1;
const OUT_STATUSES = new Set(['withdrawn', 'disqualified']);
const PLAYED = new Set(['playing', 'suspended', 'awaiting_validation', 'finished']);

let idCounter = 0;
function uid(prefix) {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${idCounter.toString(36)}`;
}

export function createTournament({ name, config, ownerId = null, demo = false, now = Date.now(), seed = randomSeed(), id = uid('t'), targets = 4 }) {
  assert(String(name || '').trim(), 'INVALID_NAME', 'Le tournoi doit avoir un nom.');
  const cfg = config || defaultConfig();
  const { errors } = validateConfig(cfg);
  assert(!errors.length, 'INVALID_CONFIG', 'Configuration incohérente.', errors);
  return {
    schema: SCHEMA_VERSION,
    id,
    name: String(name).trim(),
    description: '',
    seed,
    demo: !!demo,
    status: 'draft', // draft | ready | running | paused | finished | archived
    registrationOpen: true,
    createdAt: now,
    updatedAt: now,
    version: 0,
    config: structuredClone(cfg),
    participants: [],
    targets: Array.from({ length: targets }, (_, i) => ({ id: `cible${i + 1}`, name: `Cible ${i + 1}`, status: 'available', note: '' })),
    phases: cfg.phases.map((p) => ({ id: p.id, status: 'pending', pools: [], entrants: [] })),
    matches: [],
    members: ownerId ? [{ userId: ownerId, role: 'owner', targetIds: [] }] : [],
    share: { spectatorToken: uid('s').replace('s_', ''), registrationToken: uid('r').replace('r_', '') },
    recentCommands: [],
    seqCounter: 0,
    decisions: [],
    finalRanking: null,
  };
}

// ---------------------------------------------------------------- utilitaires

export function phaseConfig(state, phaseId) {
  const p = state.config.phases.find((x) => x.id === phaseId);
  assert(p, 'NOT_FOUND', 'Phase introuvable.');
  return p;
}
function phaseRuntime(state, phaseId) {
  const p = state.phases.find((x) => x.id === phaseId);
  assert(p, 'NOT_FOUND', 'Phase introuvable.');
  return p;
}
function getParticipant(state, id) {
  const p = state.participants.find((x) => x.id === id);
  assert(p, 'NOT_FOUND', 'Participant introuvable.');
  return p;
}
function getMatch(state, id) {
  const m = state.matches.find((x) => x.id === id);
  assert(m, 'NOT_FOUND', 'Rencontre introuvable.');
  return m;
}
function getTarget(state, id) {
  const t = state.targets.find((x) => x.id === id);
  assert(t, 'NOT_FOUND', 'Cible introuvable.');
  return t;
}
function started(state) {
  return ['running', 'paused', 'finished', 'archived'].includes(state.status);
}
function assertNotArchived(state) {
  assert(state.status !== 'archived', 'ARCHIVED', 'Le tournoi est archivé : réouvrir l\'archive pour le modifier.');
}
function pname(state, id) {
  return state.participants.find((p) => p.id === id)?.name || '—';
}
export function matchTitle(state, m) {
  return `${m.label} : ${m.a ? pname(state, m.a) : '?'} – ${m.b ? pname(state, m.b) : '?'}`;
}
function participantInMatches(state, id) {
  return state.matches.some((m) => m.a === id || m.b === id);
}
function participantInPools(state, id) {
  return state.phases.some((ph) => ph.pools.some((pool) => pool.participantIds.includes(id)));
}
export function activeEntrants(state) {
  const needConfirm = state.config.requirePresenceConfirmation;
  return state.participants.filter((p) => (needConfirm ? p.status === 'confirmed' : ['confirmed', 'registered'].includes(p.status)));
}
function checkDuplicates(state, name, players, excludeId) {
  const n = normalizeName(name);
  const dups = [];
  for (const p of state.participants) {
    if (p.id === excludeId) continue;
    if (normalizeName(p.name) === n) dups.push(`« ${name} » est déjà inscrit.`);
    for (const pl of players) {
      if (!pl) continue;
      if (p.players.some((x) => normalizeName(x.name) === normalizeName(pl))) dups.push(`Le joueur « ${pl} » est déjà inscrit (${p.name}).`);
    }
  }
  const seen = new Set();
  for (const pl of players) {
    const k = normalizeName(pl);
    if (seen.has(k)) dups.push(`Le joueur « ${pl} » apparaît deux fois.`);
    seen.add(k);
  }
  return dups;
}
function sanitizePlayers(state, name, players) {
  const cfg = state.config;
  if (cfg.mode === 'individual') return [{ id: uid('pl'), name: String(name).trim(), history: [] }];
  const list = (players || []).map((x) => String(x || '').trim());
  assert(list.length === cfg.teamSize && list.every(Boolean), 'INVALID_TEAM', `Une équipe doit comporter exactement ${cfg.teamSize} joueur(s) nommé(s).`);
  return list.map((n) => ({ id: uid('pl'), name: n, history: [] }));
}
function nextSeq(state) {
  state.seqCounter += 1;
  return state.seqCounter;
}

// ----------------------------------------------------------- génération matchs

function newMatch(state, fields) {
  return {
    seq: nextSeq(state),
    status: 'waiting',
    targetId: null,
    pinnedTargetId: null,
    priority: 0,
    notBefore: null,
    calledAt: null,
    startedAt: null,
    endedAt: null,
    result: null,
    pendingResult: null,
    resultVersion: 0,
    history: [],
    ...fields,
  };
}

function generatePoolMatches(state, phaseId) {
  const ph = phaseRuntime(state, phaseId);
  const cfg = phaseConfig(state, phaseId);
  const rules = poolRules(cfg);
  const perPool = ph.pools.map((pool) => roundRobin(pool.participantIds));
  const maxRounds = Math.max(0, ...perPool.map((r) => r.length));
  const created = [];
  const seenPairs = new Set();
  for (let r = 0; r < maxRounds; r++) {
    ph.pools.forEach((pool, pi) => {
      (perPool[pi][r] || []).forEach(([a, b], k) => {
        const key = [a, b].sort().join('|');
        assert(!seenPairs.has(key), 'DUPLICATE_MATCH', 'Rencontre générée deux fois.'); // garde-fou
        seenPairs.add(key);
        const n = created.filter((m) => m.poolId === pool.id).length + 1;
        created.push(newMatch(state, {
          id: `${phaseId}-${pool.id}-${n}`,
          phaseId,
          kind: 'pool',
          poolId: pool.id,
          round: r,
          label: `${pool.name} · M${n}`,
          a,
          b,
          rules,
          status: 'ready',
        }));
        void k;
      });
    });
  }
  state.matches.push(...created);
  return created;
}

/** Liste ordonnée des qualifiés d'une phase de poules (pour la phase suivante). */
export function qualifiersOf(state, phaseId) {
  const cfg = phaseConfig(state, phaseId);
  const ph = phaseRuntime(state, phaseId);
  const list = [];
  ph.pools.forEach((pool, poolIndex) => {
    const st = poolStandings(state, phaseId, pool.id);
    const eligible = st.rows.filter((r) => !r.excluded && !OUT_STATUSES.has(getParticipant(state, r.participantId).status));
    eligible.slice(0, cfg.qualifiersPerPool).forEach((row, i) => list.push({ participantId: row.participantId, poolId: pool.id, poolIndex, tier: i + 1, row: { ...row, poolIndex } }));
  });
  list.sort((x, y) => x.tier - y.tier || crossPoolCompare(x.row, y.row));
  return list;
}

export function poolStandings(state, phaseId, poolId) {
  const cfg = phaseConfig(state, phaseId);
  const ph = phaseRuntime(state, phaseId);
  const pool = ph.pools.find((p) => p.id === poolId);
  const matches = state.matches.filter((m) => m.phaseId === phaseId && m.poolId === poolId);
  const excluded = new Set(pool.participantIds.filter((id) => state.participants.find((p) => p.id === id)?.excludedFrom?.includes(phaseId)));
  return computeStandings({ participantIds: pool.participantIds, matches, phase: cfg, seed: state.seed, poolId: `${phaseId}:${poolId}`, manualOrder: pool.manualOrder || [], excluded });
}

function entrantsForPhase(state, index) {
  if (index === 0) return activeEntrants(state).map((p) => ({ participantId: p.id, seed: p.seed, tier: 1 }));
  const prev = state.config.phases[index - 1];
  assert(prev.type === 'pools', 'INVALID_FORMAT', 'Seule une phase de poules peut précéder une autre phase.');
  return qualifiersOf(state, prev.id);
}

function generateKnockout(state, phaseId, seed) {
  const idx = state.config.phases.findIndex((p) => p.id === phaseId);
  const cfg = state.config.phases[idx];
  const ph = state.phases[idx];
  let entrants = entrantsForPhase(state, idx);
  assert(entrants.length >= 2, 'NOT_ENOUGH', 'Au moins deux participants sont nécessaires pour un tableau.');
  if (cfg.thirdPlaceMatch) assert(entrants.length >= 4, 'NOT_ENOUGH', 'Une petite finale nécessite au moins 4 participants.');
  const drawSeed = seed || `${state.seed}:${phaseId}`;
  if (cfg.seeding === 'random' || idx === 0) {
    const rng = createRng(`ko:${drawSeed}`);
    if (idx === 0) {
      const seeded = entrants.filter((e) => Number.isInteger(e.seed)).sort((a, b) => a.seed - b.seed);
      const rest = shuffle(entrants.filter((e) => !Number.isInteger(e.seed)), rng);
      entrants = seeded.concat(rest).map((e) => ({ ...e, tier: 1 }));
    } else entrants = shuffle(entrants, rng).map((e) => ({ ...e, tier: 1 }));
  }
  const { matches } = buildBracket(entrants.map((e) => ({ participantId: e.participantId, poolId: e.poolId ?? null, tier: e.tier })), cfg);
  state.matches = state.matches.filter((m) => m.phaseId !== phaseId);
  for (const m of matches) state.matches.push(newMatch(state, m));
  ph.entrants = entrants.map((e) => e.participantId);
  ph.drawSeed = drawSeed;
  ph.status = 'active';
  ph.generatedAt = Date.now();
}

function generatePoolsFromPrevious(state, index) {
  const cfg = state.config.phases[index];
  const ph = state.phases[index];
  const entrants = entrantsForPhase(state, index).map((e, i) => ({ id: e.participantId, seed: i + 1 }));
  ph.pools = drawPools(entrants, cfg.poolCount, { method: 'seeded', seed: `${state.seed}:${cfg.id}` });
  ph.entrants = entrants.map((e) => e.id);
  ph.status = 'active';
  generatePoolMatches(state, cfg.id);
}

// ------------------------------------------------------- recalculs dépendants

function sourceSide(state, src) {
  const s = state.matches.find((m) => m.id === src.matchId);
  if (!s || s.status !== 'finished' || !s.result) return { unknown: true };
  const side = src.take === 'winner' ? s.result.winner : s.result.loser;
  const pid = side ? s[side] : null;
  if (!pid) return { bye: true };
  return { pid };
}

function resetMatchForReplay(m, reason, now) {
  if (m.result || m.pendingResult) m.history.push({ at: now, reason, result: m.result, pendingResult: m.pendingResult, a: m.a, b: m.b });
  m.result = null;
  m.pendingResult = null;
  m.targetId = null;
  m.calledAt = null;
  m.startedAt = null;
  m.endedAt = null;
  m.resultVersion += 1;
}

function propagateBracket(state, now) {
  const ko = state.matches.filter((m) => m.kind === 'knockout').sort((x, y) => x.roundIndex - y.roundIndex || x.slot - y.slot);
  for (const m of ko) {
    if (m.roundIndex === 0 && !m.sourceA) {
      if ((m.byeA || m.byeB) && m.status !== 'finished') {
        m.result = byeResult(m.byeA ? 'b' : 'a');
        m.status = 'finished';
        m.endedAt = now;
      } else if (m.a && m.b && m.status === 'waiting') m.status = 'ready';
      continue;
    }
    const sa = sourceSide(state, m.sourceA);
    const sb = sourceSide(state, m.sourceB);
    const a = sa.pid || null;
    const b = sb.pid || null;
    if (PLAYED.has(m.status) && m.result?.outcome !== 'bye') {
      m.conflict = m.a !== a || m.b !== b; // ne doit pas arriver : les corrections l'empêchent
      continue;
    }
    if (m.status === 'finished' && m.result?.outcome === 'bye') {
      if (m.a === a && m.b === b) continue;
      m.result = null;
      m.status = 'waiting';
    }
    if (m.a !== a || m.b !== b) {
      if (m.status === 'called') { m.targetId = null; m.calledAt = null; }
      m.a = a;
      m.b = b;
      if (m.status !== 'cancelled') m.status = 'waiting';
    }
    if (m.status === 'cancelled' || m.status === 'postponed') continue;
    if ((sa.bye && b) || (sb.bye && a)) {
      m.result = byeResult(sa.bye ? 'b' : 'a');
      m.status = 'finished';
      m.endedAt = now;
      continue;
    }
    if (sa.bye && sb.bye) {
      m.result = { ...byeResult('a'), winner: null, loser: null };
      m.status = 'finished';
      continue;
    }
    if (a && b && m.status === 'waiting') m.status = 'ready';
    if (!(a && b) && m.status === 'ready') m.status = 'waiting';
  }
}

function autoForfeits(state, now) {
  for (const m of state.matches) {
    if (!['ready', 'called', 'waiting'].includes(m.status) || !m.a || !m.b) continue;
    const outA = OUT_STATUSES.has(getParticipant(state, m.a).status);
    const outB = OUT_STATUSES.has(getParticipant(state, m.b).status);
    if (!outA && !outB) continue;
    if (m.kind === 'pool') {
      const who = getParticipant(state, outA ? m.a : m.b);
      if (who.excludedFrom?.includes(m.phaseId)) { m.status = 'cancelled'; m.targetId = null; continue; }
    }
    const loser = outA ? 'a' : 'b';
    const disq = getParticipant(state, m[loser]).status === 'disqualified';
    m.result = { outcome: disq ? 'disqualified' : 'forfeit', winner: loser === 'a' ? 'b' : 'a', loser, legs: [], legsA: loser === 'a' ? 0 : Math.floor(m.rules.bestOf / 2) + 1, legsB: loser === 'b' ? 0 : Math.floor(m.rules.bestOf / 2) + 1, forA: 0, forB: 0, complete: true, auto: true };
    m.status = 'finished';
    m.targetId = null;
    m.endedAt = now;
    m.resultVersion += 1;
  }
}

/** Égalités non résolues qui ont une incidence (qualification, placement, titre). */
export function blockingTies(state, phaseId) {
  const idx = state.config.phases.findIndex((p) => p.id === phaseId);
  const cfg = state.config.phases[idx];
  const isLast = idx === state.config.phases.length - 1;
  const ph = state.phases[idx];
  const out = [];
  for (const pool of ph.pools) {
    const st = poolStandings(state, phaseId, pool.id);
    for (const ids of st.unresolvedTies) {
      const ranks = st.rows.filter((r) => ids.includes(r.participantId)).map((r) => r.rank);
      const firstRank = Math.min(...ranks);
      const limit = isLast ? 1 : cfg.qualifiersPerPool;
      if (firstRank <= limit) out.push({ poolId: pool.id, poolName: pool.name, participantIds: ids, fromRank: firstRank });
    }
  }
  return out;
}

function phaseMatchesDone(state, phaseId) {
  const ms = state.matches.filter((m) => m.phaseId === phaseId);
  return ms.length > 0 && ms.every((m) => m.status === 'finished' || m.status === 'cancelled');
}

function settlePhases(state, now, events) {
  for (let i = 0; i < state.phases.length; i++) {
    const ph = state.phases[i];
    const cfg = state.config.phases[i];
    if (ph.status !== 'active') continue;
    if (!phaseMatchesDone(state, cfg.id)) { ph.awaitingDecision = null; continue; }
    if (cfg.type === 'pools') {
      const ties = blockingTies(state, cfg.id);
      if (ties.length) { ph.awaitingDecision = { type: 'ties', ties }; continue; }
    }
    ph.awaitingDecision = null;
    ph.status = 'completed';
    ph.completedAt = now;
    events.push(`Phase « ${cfg.name} » terminée.`);
    const next = state.phases[i + 1];
    if (next && next.status === 'pending') {
      const ncfg = state.config.phases[i + 1];
      if (ncfg.type === 'knockout') generateKnockout(state, ncfg.id);
      else generatePoolsFromPrevious(state, i + 1);
      events.push(`Phase « ${ncfg.name} » générée automatiquement.`);
      propagateBracket(state, now);
    }
  }
  const allDone = state.phases.every((p) => p.status === 'completed');
  if (allDone && ['running', 'paused'].includes(state.status)) {
    state.status = 'finished';
    state.finishedAt = now;
    state.finalRanking = computeFinalRanking(state);
    events.push('Tournoi terminé : classement final établi.');
  }
}

function dispatch(state, now) {
  if (state.status !== 'running') return [];
  const unavailable = new Set(state.participants.filter((p) => OUT_STATUSES.has(p.status)).map((p) => p.id));
  const props = proposeAssignments({ ...state, unavailableParticipants: unavailable }, now);
  for (const { matchId, targetId } of props) {
    const m = getMatch(state, matchId);
    m.targetId = targetId;
    if (m.status === 'suspended') {
      m.resumeFirst = false; // reste suspendue, mais a retrouvé une cible
    } else {
      m.status = 'called';
      m.calledAt = now;
    }
  }
  return props;
}

export function settle(state, now, events = []) {
  for (let pass = 0; pass < 5; pass++) {
    const before = JSON.stringify([state.matches.map((m) => [m.status, m.a, m.b]), state.phases.map((p) => p.status)]);
    propagateBracket(state, now);
    autoForfeits(state, now);
    settlePhases(state, now, events);
    const after = JSON.stringify([state.matches.map((m) => [m.status, m.a, m.b]), state.phases.map((p) => p.status)]);
    if (before === after) break;
  }
  if (state.status === 'finished' && !state.incomplete) state.finalRanking = computeFinalRanking(state);
  if (state.config.scheduling?.autoAssign) dispatch(state, now);
  return events;
}

// ------------------------------------------------------- corrections & impact

function dependentsOf(state, matchId) {
  const out = [];
  const queue = [matchId];
  while (queue.length) {
    const id = queue.shift();
    for (const m of state.matches) {
      if ((m.sourceA?.matchId === id || m.sourceB?.matchId === id) && !out.includes(m)) {
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  return out;
}

function laterPhasesStarted(state, phaseId) {
  const idx = state.config.phases.findIndex((p) => p.id === phaseId);
  const later = state.config.phases.slice(idx + 1).map((p) => p.id);
  const generated = state.phases.filter((p) => later.includes(p.id) && p.status !== 'pending');
  const played = state.matches.filter((m) => later.includes(m.phaseId) && PLAYED.has(m.status) && m.result?.outcome !== 'bye' && !m.result?.auto);
  return { later, generated, played };
}

function resetLaterPhases(state, phaseId, now) {
  const { later } = laterPhasesStarted(state, phaseId);
  for (const m of state.matches.filter((x) => later.includes(x.phaseId))) {
    if (m.result || m.pendingResult) state.decisions.push({ at: now, type: 'archivedResult', matchId: m.id, result: m.result, a: m.a, b: m.b });
  }
  state.matches = state.matches.filter((m) => !later.includes(m.phaseId));
  for (const ph of state.phases) if (later.includes(ph.id)) Object.assign(ph, { status: 'pending', pools: [], entrants: [], awaitingDecision: null, completedAt: null });
  const idx = state.config.phases.findIndex((p) => p.id === phaseId);
  state.phases[idx].status = 'active';
  state.phases[idx].completedAt = null;
  if (state.status === 'finished') { state.status = 'running'; state.finalRanking = null; state.finishedAt = null; }
}

/**
 * Applique une modification de résultat (correction, annulation) en gérant
 * ses conséquences. `apply` modifie le match ; `decision` est le choix de l'organisateur.
 */
function withImpactControl(state, m, apply, decision, now, events) {
  const before = state.matches.map((x) => ({ id: x.id, a: x.a, b: x.b }));
  const previousWinner = m.result?.winner;
  if (m.kind === 'pool') {
    const { generated, played } = laterPhasesStarted(state, m.phaseId);
    if (!generated.length) {
      apply();
      const ph = phaseRuntime(state, m.phaseId);
      if (ph.status === 'completed') { ph.status = 'active'; ph.completedAt = null; }
      if (state.status === 'finished') { state.status = 'running'; state.finalRanking = null; state.finishedAt = null; }
      return;
    }
    // Simule la correction pour savoir si les qualifiés / le placement changent.
    const oldEntrants = state.phases.find((p) => p.id === generated[0].id).entrants.slice();
    const oldPools = JSON.stringify(state.phases.find((p) => p.id === generated[0].id).pools.map((p) => p.participantIds));
    apply();
    const idx = state.config.phases.findIndex((p) => p.id === m.phaseId);
    let newEntrants;
    try {
      newEntrants = entrantsForPhase(state, idx + 1).map((e) => e.participantId);
    } catch {
      newEntrants = null;
    }
    const ties = blockingTies(state, m.phaseId);
    const nextCfg = state.config.phases[idx + 1];
    const norm = (l) => (nextCfg.type === 'knockout' && nextCfg.seeding === 'random' ? l.slice().sort() : l);
    const same = newEntrants && JSON.stringify(norm(newEntrants)) === JSON.stringify(norm(oldEntrants)) && !ties.length;
    if (same) { events.push('Correction sans incidence sur la phase suivante.'); return; }
    if (decision === 'keepNextPhase') {
      state.decisions.push({ at: now, type: 'keepNextPhase', matchId: m.id, note: 'Classement corrigé ; phase suivante conservée telle quelle sur décision de l\'organisateur.' });
      events.push('Phase suivante conservée sur décision de l\'organisateur (le classement corrigé diffère du placement).');
      return;
    }
    if (decision === 'regenerateNextPhase') {
      resetLaterPhases(state, m.phaseId, now);
      events.push('Phase suivante réinitialisée : elle sera régénérée à partir du classement corrigé.');
      state.decisions.push({ at: now, type: 'regenerateNextPhase', matchId: m.id });
      return;
    }
    if (!played.length && decision !== 'keepNextPhase') {
      // Aucune rencontre de la phase suivante jouée : régénération sûre, signalée.
      resetLaterPhases(state, m.phaseId, now);
      events.push('La correction modifie les qualifiés ou le placement : phase suivante régénérée (aucune rencontre n\'y avait été jouée).');
      return;
    }
    void oldPools;
    throw new DomainError('DECISION_REQUIRED', 'Cette correction modifie le classement qualificatif alors que la phase suivante a commencé. Choisir : conserver la phase suivante telle quelle, ou la régénérer (ses résultats seront archivés).', {
      options: ['keepNextPhase', 'regenerateNextPhase'],
      playedMatches: played.map((x) => matchTitle(state, x)),
    });
  }
  // Élimination directe
  apply();
  const winnerChanged = m.result?.winner !== previousWinner || !m.result;
  if (!winnerChanged) return;
  const deps = dependentsOf(state, m.id);
  const playedDeps = deps.filter((d) => PLAYED.has(d.status) && d.result?.outcome !== 'bye' && !d.result?.auto);
  if (playedDeps.length && decision !== 'resetDependents') {
    throw new DomainError('DECISION_REQUIRED', 'Ce changement de vainqueur affecte des rencontres déjà commencées ou jouées. Confirmer leur réinitialisation (leurs résultats seront archivés) ou annuler la correction.', {
      options: ['resetDependents'],
      playedMatches: playedDeps.map((x) => matchTitle(state, x)),
    });
  }
  for (const d of deps) {
    if (PLAYED.has(d.status) || (d.status === 'finished')) {
      resetMatchForReplay(d, `Réinitialisé suite à la correction de ${m.label}`, now);
      d.status = 'waiting';
      d.conflict = false;
    } else if (d.status === 'called') {
      d.targetId = null;
      d.calledAt = null;
      d.status = 'waiting';
    }
  }
  if (playedDeps.length) {
    state.decisions.push({ at: now, type: 'resetDependents', matchId: m.id, reset: playedDeps.map((d) => d.id) });
    events.push(`${playedDeps.length} rencontre(s) dépendante(s) réinitialisée(s).`);
  }
  // Ré-ouvre la phase et le tournoi si nécessaire.
  const ph = phaseRuntime(state, m.phaseId);
  if (ph.status === 'completed') { ph.status = 'active'; ph.completedAt = null; }
  if (state.status === 'finished') { state.status = 'running'; state.finalRanking = null; state.finishedAt = null; }
  void before;
}

// ------------------------------------------------------------------ commandes

function finalizeResult(state, m, result, ctx) {
  m.result = { ...result, validatedBy: ctx.userId || null, validatedAt: ctx.now };
  m.pendingResult = null;
  m.status = 'finished';
  m.endedAt = ctx.now;
  if (!m.startedAt) m.startedAt = m.calledAt || ctx.now;
  m.resultVersion += 1;
}

function checkResult(m, input) {
  const r = evaluateResult(m.rules, input);
  if (!r.ok) throw new DomainError('INVALID_RESULT', 'Résultat invalide.', r.errors);
  return r.result;
}

function assertMatchPlayable(state, m) {
  assertNotArchived(state);
  assert(m.a && m.b, 'NOT_READY', 'Les deux adversaires de cette rencontre ne sont pas encore connus.');
  const ph = phaseRuntime(state, m.phaseId);
  assert(ph.status === 'active', 'PHASE_NOT_ACTIVE', 'La phase de cette rencontre n\'est pas en cours.');
}

function assertNoParticipantConflict(state, m) {
  const busy = busyParticipants(state.matches.filter((x) => x.id !== m.id));
  for (const p of [m.a, m.b]) {
    if (busy.has(p)) throw new DomainError('PARTICIPANT_BUSY', `${pname(state, p)} dispute déjà une autre rencontre (${busy.get(p)}).`);
  }
}

function assertTargetFree(state, targetId, matchId) {
  const t = getTarget(state, targetId);
  assert(t.status === 'available', 'TARGET_UNAVAILABLE', `${t.name} est indisponible.`);
  const occ = targetOccupancy(state.matches);
  if (occ.has(targetId) && occ.get(targetId) !== matchId) throw new DomainError('TARGET_BUSY', `${t.name} est déjà occupée.`);
}

function applyWithdrawal(state, p, kind, policy, ctx, events) {
  p.status = kind;
  p.statusAt = ctx.now;
  // Poules : application de la politique choisie.
  for (const ph of state.phases) {
    const cfg = phaseConfig(state, ph.id);
    if (cfg.type !== 'pools' || ph.status !== 'active') continue;
    if (!ph.pools.some((pool) => pool.participantIds.includes(p.id))) continue;
    if (policy === 'annulAll') {
      p.excludedFrom = [...new Set([...(p.excludedFrom || []), ph.id])];
      for (const m of state.matches) {
        if (m.phaseId !== ph.id || (m.a !== p.id && m.b !== p.id)) continue;
        if (OCCUPYING_STATUSES.has(m.status) || m.status === 'finished') {
          if (m.result) m.history.push({ at: ctx.now, reason: `Annulé : ${kind === 'withdrawn' ? 'désistement' : 'disqualification'} de ${p.name}`, result: m.result });
        }
        m.status = 'cancelled';
        m.targetId = null;
        m.result = null;
        m.pendingResult = null;
      }
      events.push(`Rencontres de ${p.name} annulées dans « ${cfg.name} ».`);
    }
  }
  // Rencontre en cours : forfait / disqualification dans la rencontre.
  for (const m of state.matches) {
    if ((m.a !== p.id && m.b !== p.id) || !OCCUPYING_STATUSES.has(m.status)) continue;
    const loser = m.a === p.id ? 'a' : 'b';
    const legsDone = (m.pendingResult?.legs || []).length;
    const res = checkResult(m, { outcome: kind === 'disqualified' ? 'disqualified' : legsDone ? 'retired' : 'forfeit', loser, legs: kind === 'disqualified' ? [] : (m.pendingResult?.legs || []) });
    finalizeResult(state, m, res, ctx);
  }
  // Les rencontres non jouées sont déclarées forfait par autoForfeits() lors du recalcul.
}

const handlers = {
  'tournament.update'(s, p) {
    assertNotArchived(s);
    if (p.name !== undefined) {
      assert(String(p.name).trim(), 'INVALID_NAME', 'Le tournoi doit avoir un nom.');
      s.name = String(p.name).trim();
    }
    if (p.description !== undefined) s.description = String(p.description);
    return 'Informations du tournoi modifiées.';
  },

  'config.update'(s, p) {
    assertNotArchived(s);
    const next = structuredClone(p.config);
    const { errors } = validateConfig(next);
    assert(!errors.length, 'INVALID_CONFIG', 'Configuration incohérente.', errors);
    // Changements permis selon l'avancement : une phase générée ne peut plus changer de structure.
    const oldIds = s.config.phases.map((x) => x.id);
    const newIds = next.phases.map((x) => x.id);
    s.phases.forEach((ph, i) => {
      if (ph.status === 'pending') return;
      const o = s.config.phases[i];
      const n = next.phases[i];
      assert(n && n.id === o.id && n.type === o.type, 'LOCKED', `La phase « ${o.name} » a déjà commencé : sa structure ne peut plus être modifiée.`);
      const locked = o.type === 'pools' ? ['poolCount', 'qualifiersPerPool', 'game'] : ['game', 'thirdPlaceMatch', 'seeding', 'avoidSamePool'];
      for (const k of locked) assert(JSON.stringify(o[k]) === JSON.stringify(n[k]), 'LOCKED', `« ${k} » de la phase « ${o.name} » ne peut plus être modifié.`);
      if (ph.status === 'completed') {
        for (const k of ['points', 'tiebreakers', 'bestOf', 'turnLimit', 'allowDraw', 'roundOverrides']) {
          assert(JSON.stringify(o[k]) === JSON.stringify(n[k]), 'LOCKED', `La phase « ${o.name} » est terminée : « ${k} » ne peut plus être modifié.`);
        }
      }
    });
    if (started(s)) {
      assert(next.mode === s.config.mode && next.teamSize === s.config.teamSize, 'LOCKED', 'Le mode et la taille des équipes ne peuvent plus changer après le lancement.');
    }
    // Les règles de match s'appliquent aux rencontres non encore commencées.
    s.config = next;
    s.phases = next.phases.map((pc) => s.phases.find((ph) => ph.id === pc.id) || { id: pc.id, status: 'pending', pools: [], entrants: [] });
    for (const m of s.matches) {
      if (['finished', 'playing', 'suspended', 'awaiting_validation', 'cancelled'].includes(m.status)) continue;
      const cfg = next.phases.find((x) => x.id === m.phaseId);
      if (!cfg) continue;
      if (m.kind === 'pool') m.rules = poolRules(cfg);
      else {
        const o = cfg.roundOverrides?.[m.roundKey] || {};
        m.rules = { game: o.game || cfg.game, gameOptions: o.gameOptions || cfg.gameOptions || {}, bestOf: o.bestOf ?? cfg.bestOf, turnLimit: o.turnLimit !== undefined ? o.turnLimit : cfg.turnLimit ?? null, allowDraw: false };
      }
    }
    void oldIds; void newIds;
    return 'Configuration modifiée.';
  },

  'registration.open'(s) {
    assertNotArchived(s);
    assert(!started(s), 'LOCKED', 'Le tournoi est lancé : les participants sont verrouillés.');
    s.registrationOpen = true;
    return 'Inscriptions ouvertes.';
  },
  'registration.close'(s) {
    s.registrationOpen = false;
    return 'Inscriptions closes.';
  },

  'participant.add'(s, p, ctx) {
    assertNotArchived(s);
    assert(!started(s), 'LOCKED', 'Le tournoi est lancé : impossible d\'ajouter un participant.');
    assert(s.phases[0].status === 'pending' || s.phases[0].status === 'draft', 'LOCKED', 'Les rencontres sont générées : réinitialiser les poules avant d\'ajouter un participant.');
    if (p.source === 'public') assert(s.registrationOpen && s.config.publicRegistration, 'REGISTRATION_CLOSED', 'Les inscriptions publiques sont fermées.');
    const name = String(p.name || '').trim();
    assert(name, 'INVALID_NAME', 'Nom obligatoire.');
    const players = sanitizePlayers(s, name, p.players);
    const max = s.config.maxParticipants;
    const counted = s.participants.filter((x) => !OUT_STATUSES.has(x.status)).length;
    assert(!max || counted < max, 'FULL', `Nombre maximal de participants atteint (${max}).`);
    const dups = checkDuplicates(s, name, s.config.mode === 'team' ? players.map((x) => x.name) : [], null);
    if (dups.length && !(p.allowDuplicate && p.source !== 'public')) throw new DomainError('DUPLICATE', 'Doublon détecté.', dups);
    const part = {
      id: p.id || uid('p'),
      name,
      players,
      status: p.status === 'confirmed' ? 'confirmed' : 'registered',
      seed: Number.isInteger(p.seed) ? p.seed : null,
      contact: { email: String(p.contact?.email || '').trim(), phone: String(p.contact?.phone || '').trim() },
      source: p.source || 'manual',
      createdAt: ctx.now,
      history: [],
    };
    s.participants.push(part);
    ctx.result.participantId = part.id;
    return `Inscription de ${name}.`;
  },

  'participant.import'(s, p, ctx) {
    const rows = Array.isArray(p.rows) ? p.rows : [];
    assert(rows.length, 'EMPTY', 'Aucune ligne à importer.');
    const added = [];
    const rejected = [];
    for (const [i, r] of rows.entries()) {
      try {
        handlers['participant.add'](s, { ...r, source: 'import', allowDuplicate: false }, ctx);
        added.push(r.name);
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        rejected.push({ line: i + 1, name: r.name, reason: e.details ? [].concat(e.details).join(' ') : e.message });
      }
    }
    ctx.result.added = added.length;
    ctx.result.rejected = rejected;
    return `Import : ${added.length} ajout(s), ${rejected.length} rejet(s).`;
  },

  'participant.update'(s, p) {
    assertNotArchived(s);
    const part = getParticipant(s, p.id);
    if (p.name !== undefined) {
      const name = String(p.name).trim();
      assert(name, 'INVALID_NAME', 'Nom obligatoire.');
      const dups = checkDuplicates(s, name, [], part.id);
      if (dups.length && !p.allowDuplicate) throw new DomainError('DUPLICATE', 'Doublon détecté.', dups);
      if (name !== part.name) part.history.push({ at: Date.now(), field: 'name', from: part.name, to: name });
      part.name = name;
      if (s.config.mode === 'individual') part.players[0].name = name;
    }
    if (p.players !== undefined && s.config.mode === 'team') {
      assert(!started(s), 'LOCKED', 'Après le lancement, utiliser le remplacement de joueur.');
      const names = p.players.map((x) => String(x || '').trim());
      assert(names.length === s.config.teamSize && names.every(Boolean), 'INVALID_TEAM', `Une équipe doit comporter exactement ${s.config.teamSize} joueur(s).`);
      const dups = checkDuplicates(s, `\u0000${part.id}`, names, part.id);
      if (dups.length && !p.allowDuplicate) throw new DomainError('DUPLICATE', 'Doublon détecté.', dups);
      part.players = names.map((n, i) => (part.players[i] && part.players[i].name === n ? part.players[i] : { id: uid('pl'), name: n, history: [] }));
    }
    if (p.seed !== undefined) {
      assert(!participantInPools(s, part.id) || s.phases[0].status === 'draft', 'LOCKED', 'Les poules sont validées : la tête de série ne peut plus changer.');
      part.seed = Number.isInteger(p.seed) ? p.seed : null;
    }
    if (p.contact !== undefined) part.contact = { email: String(p.contact.email || '').trim(), phone: String(p.contact.phone || '').trim() };
    return `Inscription de ${part.name} modifiée.`;
  },

  'participant.remove'(s, p) {
    assertNotArchived(s);
    const part = getParticipant(s, p.id);
    assert(!participantInMatches(s, part.id), 'LOCKED', 'Ce participant figure dans des rencontres générées : utiliser « désistement » ou « disqualification ».');
    for (const ph of s.phases) for (const pool of ph.pools) pool.participantIds = pool.participantIds.filter((x) => x !== part.id);
    s.participants = s.participants.filter((x) => x.id !== part.id);
    s.members.forEach((m) => { if (m.participantId === part.id) m.participantId = null; });
    return `Inscription de ${part.name} supprimée.`;
  },

  'participant.setPresence'(s, p) {
    assertNotArchived(s);
    const part = getParticipant(s, p.id);
    assert(['confirmed', 'absent', 'registered'].includes(p.presence), 'INVALID', 'Présence invalide.');
    assert(!OUT_STATUSES.has(part.status), 'LOCKED', 'Participant désisté ou disqualifié.');
    if (participantInMatches(s, part.id) && p.presence === 'absent') {
      throw new DomainError('USE_WITHDRAW', 'Les rencontres de ce participant sont générées : déclarer un désistement ou un forfait plutôt qu\'une absence.');
    }
    if (p.presence !== 'confirmed') {
      // Absent alors que les poules sont tirées (non validées) : retiré de sa poule.
      for (const ph of s.phases) if (ph.status === 'draft') for (const pool of ph.pools) pool.participantIds = pool.participantIds.filter((x) => x !== part.id);
    }
    part.status = p.presence;
    return `${part.name} : ${p.presence === 'confirmed' ? 'présence confirmée' : p.presence === 'absent' ? 'absent' : 'présence non confirmée'}.`;
  },

  'participant.withdraw'(s, p, ctx, events) {
    assertNotArchived(s);
    const part = getParticipant(s, p.id);
    assert(!OUT_STATUSES.has(part.status), 'ALREADY', 'Déjà désisté ou disqualifié.');
    if (!participantInMatches(s, part.id)) {
      for (const ph of s.phases) for (const pool of ph.pools) pool.participantIds = pool.participantIds.filter((x) => x !== part.id);
      part.status = 'withdrawn';
      return `Désistement de ${part.name} (aucune rencontre générée).`;
    }
    applyWithdrawal(s, part, 'withdrawn', p.policy || s.config.withdrawalPolicy, ctx, events);
    return `Désistement de ${part.name} (${(p.policy || s.config.withdrawalPolicy) === 'annulAll' ? 'rencontres de poule annulées' : 'rencontres restantes perdues par forfait'}).`;
  },

  'participant.disqualify'(s, p, ctx, events) {
    assertNotArchived(s);
    const part = getParticipant(s, p.id);
    assert(!OUT_STATUSES.has(part.status), 'ALREADY', 'Déjà désisté ou disqualifié.');
    part.disqualificationReason = String(p.reason || '');
    applyWithdrawal(s, part, 'disqualified', p.policy || s.config.disqualificationPolicy, ctx, events);
    return `Disqualification de ${part.name}${p.reason ? ` : ${p.reason}` : ''}.`;
  },

  'participant.replacePlayer'(s, p, ctx) {
    assertNotArchived(s);
    assert(s.config.allowReplacement, 'NOT_ALLOWED', 'Le règlement de ce tournoi n\'autorise pas les remplacements.');
    const part = getParticipant(s, p.id);
    const pl = part.players.find((x) => x.id === p.playerId);
    assert(pl, 'NOT_FOUND', 'Joueur introuvable.');
    const name = String(p.name || '').trim();
    assert(name, 'INVALID_NAME', 'Nom du remplaçant obligatoire.');
    const dups = checkDuplicates(s, '\u0000', [name], null);
    if (dups.length && !p.allowDuplicate) throw new DomainError('DUPLICATE', 'Doublon détecté.', dups);
    pl.history.push({ at: ctx.now, replaced: pl.name, by: name, reason: String(p.reason || '') });
    const old = pl.name;
    pl.name = name;
    if (s.config.mode === 'individual') { part.history.push({ at: ctx.now, field: 'name', from: part.name, to: name, replacement: true }); part.name = name; }
    return `Remplacement dans ${part.name} : ${old} → ${name}.`;
  },

  'participant.anonymize'(s, p) {
    const part = getParticipant(s, p.id);
    const n = s.participants.indexOf(part) + 1;
    part.name = s.config.mode === 'team' ? `Équipe anonyme ${n}` : `Joueur anonyme ${n}`;
    part.players.forEach((pl, i) => { pl.name = `Joueur anonyme ${n}.${i + 1}`; pl.history = []; });
    part.contact = { email: '', phone: '' };
    part.history = [];
    part.anonymized = true;
    return `Données personnelles du participant n°${n} anonymisées.`;
  },

  'target.add'(s, p) {
    assertNotArchived(s);
    const name = String(p.name || '').trim() || `Cible ${s.targets.length + 1}`;
    assert(!s.targets.some((t) => normalizeName(t.name) === normalizeName(name)), 'DUPLICATE', 'Une cible porte déjà ce nom.');
    let i = s.targets.length + 1;
    while (s.targets.some((t) => t.id === `cible${i}`)) i++;
    s.targets.push({ id: `cible${i}`, name, status: 'available', note: '' });
    return `Cible ajoutée : ${name}.`;
  },
  'target.rename'(s, p) {
    const t = getTarget(s, p.id);
    const name = String(p.name || '').trim();
    assert(name, 'INVALID_NAME', 'Nom obligatoire.');
    assert(!s.targets.some((x) => x.id !== t.id && normalizeName(x.name) === normalizeName(name)), 'DUPLICATE', 'Une cible porte déjà ce nom.');
    t.name = name;
    return `Cible renommée : ${name}.`;
  },
  'target.setStatus'(s, p, ctx, events) {
    const t = getTarget(s, p.id);
    assert(['available', 'unavailable'].includes(p.status), 'INVALID', 'Statut de cible invalide.');
    t.status = p.status;
    t.note = String(p.note || '');
    if (p.status === 'unavailable') {
      for (const m of s.matches) {
        if (m.targetId !== t.id) continue;
        if (m.status === 'called') { m.status = 'ready'; m.targetId = null; m.calledAt = null; m.priority = Math.max(m.priority, 1); }
        else if (m.status === 'playing' || m.status === 'suspended') {
          m.status = 'suspended'; m.targetId = null; m.resumeFirst = true;
          events.push(`${matchTitle(s, m)} suspendue : en attente d'une autre cible.`);
        } else if (m.status === 'awaiting_validation') { /* le résultat est saisi, la cible sera libérée à la validation */ }
      }
      return `${t.name} indisponible${t.note ? ` (${t.note})` : ''}.`;
    }
    return `${t.name} de nouveau disponible.`;
  },
  'target.remove'(s, p) {
    const t = getTarget(s, p.id);
    assert(!s.matches.some((m) => m.targetId === t.id && OCCUPYING_STATUSES.has(m.status)), 'TARGET_BUSY', 'Une rencontre occupe cette cible.');
    for (const m of s.matches) if (m.pinnedTargetId === t.id) m.pinnedTargetId = null;
    s.targets = s.targets.filter((x) => x.id !== t.id);
    return `${t.name} retirée.`;
  },

  'pools.draw'(s, p) {
    assertNotArchived(s);
    const phaseId = p.phaseId || s.config.phases[0].id;
    const idx = s.config.phases.findIndex((x) => x.id === phaseId);
    const cfg = phaseConfig(s, phaseId);
    const ph = phaseRuntime(s, phaseId);
    assert(cfg.type === 'pools', 'INVALID', 'Cette phase n\'est pas une phase de poules.');
    assert(idx === 0, 'INVALID', 'Les poules des phases suivantes sont constituées automatiquement à partir des qualifiés.');
    assert(['pending', 'draft'].includes(ph.status), 'LOCKED', 'Les poules sont déjà validées.');
    assert(!s.registrationOpen, 'REGISTRATION_OPEN', 'Clore les inscriptions avant le tirage au sort.');
    const entrants = activeEntrants(s);
    const { errors } = validateConfig(s.config, entrants.length);
    assert(!errors.length, 'INVALID_CONFIG', 'Configuration incompatible avec les participants présents.', errors);
    const seed = p.seed || `${s.seed}:${Date.now().toString(36)}`;
    ph.pools = drawPools(entrants.map((e) => ({ id: e.id, seed: e.seed })), cfg.poolCount, { method: p.method || cfg.drawMethod, seed });
    ph.drawSeed = seed;
    ph.status = 'draft';
    return `Tirage au sort des poules (graine ${seed}).`;
  },
  'pools.move'(s, p) {
    const ph = phaseRuntime(s, p.phaseId || s.config.phases[0].id);
    assert(ph.status === 'draft', 'LOCKED', 'Les poules ne sont modifiables qu\'avant leur validation.');
    const to = ph.pools.find((x) => x.id === p.toPoolId);
    assert(to, 'NOT_FOUND', 'Poule introuvable.');
    const part = getParticipant(s, p.participantId);
    for (const pool of ph.pools) pool.participantIds = pool.participantIds.filter((x) => x !== part.id);
    to.participantIds.push(part.id);
    return `${part.name} déplacé(e) vers ${to.name}.`;
  },
  'pools.swap'(s, p) {
    const ph = phaseRuntime(s, p.phaseId || s.config.phases[0].id);
    assert(ph.status === 'draft', 'LOCKED', 'Les poules ne sont modifiables qu\'avant leur validation.');
    const pa = ph.pools.find((x) => x.participantIds.includes(p.a));
    const pb = ph.pools.find((x) => x.participantIds.includes(p.b));
    assert(pa && pb, 'NOT_FOUND', 'Participant hors poule.');
    pa.participantIds[pa.participantIds.indexOf(p.a)] = p.b;
    pb.participantIds[pb.participantIds.indexOf(p.b)] = p.a;
    return `Échange : ${pname(s, p.a)} ↔ ${pname(s, p.b)}.`;
  },
  'pools.validate'(s, p) {
    const phaseId = p.phaseId || s.config.phases[0].id;
    const cfg = phaseConfig(s, phaseId);
    const ph = phaseRuntime(s, phaseId);
    assert(ph.status === 'draft', 'INVALID', 'Effectuer le tirage au sort avant de valider les poules.');
    const all0 = ph.pools.flatMap((x) => x.participantIds);
    const missing = activeEntrants(s).filter((e) => !all0.includes(e.id));
    assert(!missing.length, 'INVALID_POOLS', `Participant(s) présent(s) sans poule : ${missing.map((x) => x.name).join(', ')}. Les placer dans une poule ou refaire le tirage.`);
    assert(ph.pools.every((pool) => pool.participantIds.length >= 2), 'INVALID_POOLS', 'Chaque poule doit compter au moins 2 participants.');
    const min = Math.min(...ph.pools.map((x) => x.participantIds.length));
    assert(cfg.qualifiersPerPool <= min, 'INVALID_POOLS', `La plus petite poule compte ${min} participant(s) pour ${cfg.qualifiersPerPool} qualifié(s).`);
    const all = ph.pools.flatMap((x) => x.participantIds);
    assert(new Set(all).size === all.length, 'INVALID_POOLS', 'Un participant figure dans plusieurs poules.');
    for (const id of all) assert(getParticipant(s, id).status === 'confirmed' || !s.config.requirePresenceConfirmation, 'INVALID_POOLS', `${pname(s, id)} n'a pas confirmé sa présence.`);
    ph.entrants = all;
    ph.status = 'active';
    const created = generatePoolMatches(s, phaseId);
    if (s.status === 'draft') s.status = 'ready';
    return `Poules validées : ${created.length} rencontres générées.`;
  },
  'pools.reset'(s, p) {
    const phaseId = p.phaseId || s.config.phases[0].id;
    const ph = phaseRuntime(s, phaseId);
    assert(ph.status === 'active' || ph.status === 'draft', 'INVALID', 'Rien à réinitialiser.');
    assert(!s.matches.some((m) => m.phaseId === phaseId && (PLAYED.has(m.status) || m.status === 'called')), 'LOCKED', 'Des rencontres ont commencé : les poules ne peuvent plus être réinitialisées.');
    s.matches = s.matches.filter((m) => m.phaseId !== phaseId);
    ph.status = 'draft';
    if (s.status === 'ready') s.status = 'draft';
    return 'Validation des poules annulée (rencontres supprimées).';
  },

  'phase.generateKnockout'(s, p) {
    const phaseId = p.phaseId || s.config.phases[0].id;
    const idx = s.config.phases.findIndex((x) => x.id === phaseId);
    const cfg = phaseConfig(s, phaseId);
    const ph = phaseRuntime(s, phaseId);
    assert(cfg.type === 'knockout', 'INVALID', 'Cette phase n\'est pas une élimination directe.');
    assert(idx === 0, 'INVALID', 'Le tableau final est généré automatiquement à la fin de la phase précédente.');
    assert(!s.registrationOpen, 'REGISTRATION_OPEN', 'Clore les inscriptions avant le tirage du tableau.');
    assert(!s.matches.some((m) => m.phaseId === phaseId && PLAYED.has(m.status) && m.result?.outcome !== 'bye'), 'LOCKED', 'Des rencontres du tableau ont été jouées.');
    const { errors } = validateConfig(s.config, activeEntrants(s).length);
    assert(!errors.length, 'INVALID_CONFIG', 'Configuration incompatible avec les participants présents.', errors);
    generateKnockout(s, phaseId, p.seed || `${s.seed}:${Date.now().toString(36)}`);
    void ph;
    if (s.status === 'draft') s.status = 'ready';
    return 'Tableau à élimination directe généré.';
  },

  'phase.resolveTie'(s, p, ctx) {
    const ph = phaseRuntime(s, p.phaseId);
    const pool = ph.pools.find((x) => x.id === p.poolId);
    assert(pool, 'NOT_FOUND', 'Poule introuvable.');
    const st = poolStandings(s, p.phaseId, p.poolId);
    let order = p.order;
    const tieIds = st.unresolvedTies.flat();
    if (p.method === 'lot') {
      const rng = createRng(`tie:${s.seed}:${p.poolId}:${ctx.now}`);
      order = [];
      for (const g of st.unresolvedTies) order.push(...shuffle(g, rng));
    }
    assert(Array.isArray(order) && order.length, 'INVALID', 'Ordre de départage manquant.');
    for (const id of order) assert(pool.participantIds.includes(id), 'INVALID', 'Participant hors de la poule.');
    pool.manualOrder = [...(pool.manualOrder || []).filter((x) => !order.includes(x)), ...order];
    s.decisions.push({ at: ctx.now, type: 'tieResolution', phaseId: p.phaseId, poolId: p.poolId, method: p.method || 'manual', order, previouslyTied: tieIds });
    return `Égalité départagée (${p.method === 'lot' ? 'tirage au sort' : 'décision de l\'organisateur'}) : ${order.map((id) => pname(s, id)).join(' > ')}.`;
  },

  'tournament.start'(s, p, ctx) {
    assertNotArchived(s);
    assert(['draft', 'ready'].includes(s.status), 'INVALID', 'Le tournoi est déjà lancé.');
    assert(!s.registrationOpen, 'REGISTRATION_OPEN', 'Clore les inscriptions avant le lancement.');
    const { errors } = validateConfig(s.config, activeEntrants(s).length);
    assert(!errors.length, 'INVALID_CONFIG', 'Configuration incohérente.', errors);
    assert(s.phases[0].status === 'active', 'NOT_PREPARED', s.config.phases[0].type === 'pools' ? 'Valider les poules avant le lancement.' : 'Générer le tableau avant le lancement.');
    assert(s.targets.some((t) => t.status === 'available'), 'NO_TARGET', 'Aucune cible disponible.');
    s.status = 'running';
    s.startedAt = ctx.now;
    return 'Tournoi lancé : participants verrouillés.';
  },
  'tournament.pause'(s, p, ctx) {
    assert(s.status === 'running', 'INVALID', 'Le tournoi n\'est pas en cours.');
    s.status = 'paused';
    s.pausedAt = ctx.now;
    if (p.suspendPlaying !== false) {
      for (const m of s.matches) if (m.status === 'playing') { m.status = 'suspended'; m.suspendedByPause = true; }
    }
    return 'Tournoi interrompu.';
  },
  'tournament.resume'(s) {
    assert(s.status === 'paused', 'INVALID', 'Le tournoi n\'est pas interrompu.');
    s.status = 'running';
    for (const m of s.matches) if (m.suspendedByPause) { if (m.status === 'suspended' && m.targetId) m.status = 'playing'; m.suspendedByPause = false; }
    return 'Tournoi repris.';
  },
  'tournament.finish'(s, p, ctx) {
    assert(['running', 'paused'].includes(s.status), 'INVALID', 'Le tournoi n\'est pas en cours.');
    const incomplete = s.phases.some((ph) => ph.status !== 'completed');
    assert(!incomplete || p.force, 'INCOMPLETE', 'Des rencontres restent à jouer : confirmer la clôture anticipée.');
    for (const m of s.matches) if (OCCUPYING_STATUSES.has(m.status) || ['ready', 'waiting', 'postponed'].includes(m.status)) { m.status = 'cancelled'; m.targetId = null; }
    s.status = 'finished';
    s.finishedAt = ctx.now;
    s.incomplete = incomplete;
    s.finalRanking = computeFinalRanking(s);
    return incomplete ? 'Tournoi clôturé de manière anticipée.' : 'Tournoi terminé.';
  },
  'tournament.archive'(s, p, ctx) {
    assert(s.status === 'finished' || p.force, 'INVALID', 'Seul un tournoi terminé peut être archivé.');
    s.statusBeforeArchive = s.status;
    s.status = 'archived';
    s.archivedAt = ctx.now;
    if (!s.finalRanking) s.finalRanking = computeFinalRanking(s);
    return 'Tournoi archivé.';
  },
  'tournament.unarchive'(s) {
    assert(s.status === 'archived', 'INVALID', 'Le tournoi n\'est pas archivé.');
    s.status = s.statusBeforeArchive || 'finished';
    return 'Archive réouverte.';
  },
  'share.regenerate'(s, p) {
    if (p.kind === 'registration') s.share.registrationToken = uid('r').replace('r_', '');
    else s.share.spectatorToken = uid('s').replace('s_', '');
    return 'Lien de partage régénéré (l\'ancien lien ne fonctionne plus).';
  },
  'members.set'(s, p) {
    assert(p.userId, 'INVALID', 'Utilisateur manquant.');
    assert(['admin', 'organizer', 'referee', 'targetManager', 'participant', 'spectator'].includes(p.role), 'INVALID', 'Rôle invalide.');
    if (p.targetIds) for (const t of p.targetIds) getTarget(s, t);
    if (p.participantId) getParticipant(s, p.participantId);
    const existing = s.members.find((m) => m.userId === p.userId);
    const entry = { userId: p.userId, role: p.role, targetIds: p.targetIds || [], participantId: p.participantId || null, label: p.label || existing?.label || '' };
    if (existing) Object.assign(existing, entry);
    else s.members.push(entry);
    return `Rôle attribué : ${p.label || p.userId} → ${p.role}.`;
  },
  'members.remove'(s, p) {
    s.members = s.members.filter((m) => m.userId !== p.userId);
    return 'Membre retiré.';
  },

  // ----- rencontres
  'match.assign'(s, p, ctx) {
    const m = getMatch(s, p.matchId);
    assertMatchPlayable(s, m);
    assert(['ready', 'called', 'suspended', 'postponed'].includes(m.status), 'INVALID', 'Cette rencontre ne peut pas être affectée dans son état actuel.');
    assertTargetFree(s, p.targetId, m.id);
    assertNoParticipantConflict(s, m);
    m.targetId = p.targetId;
    if (m.status !== 'suspended') { m.status = 'called'; m.calledAt = ctx.now; }
    m.manualAssignment = true;
    return `${matchTitle(s, m)} → ${getTarget(s, p.targetId).name}.`;
  },
  'match.unassign'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'called', 'INVALID', 'Seule une rencontre appelée non commencée peut être retirée de sa cible.');
    m.status = 'ready';
    m.targetId = null;
    m.calledAt = null;
    if (p.postponeMinutes) m.notBefore = Date.now() + p.postponeMinutes * 60000;
    return `${matchTitle(s, m)} retirée de sa cible.`;
  },
  'match.pinTarget'(s, p) {
    const m = getMatch(s, p.matchId);
    if (p.targetId) getTarget(s, p.targetId);
    m.pinnedTargetId = p.targetId || null;
    return p.targetId ? `${m.label} réservée à ${getTarget(s, p.targetId).name}.` : `${m.label} : réservation de cible levée.`;
  },
  'match.setPriority'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(Number.isInteger(p.priority), 'INVALID', 'Priorité entière attendue.');
    m.priority = p.priority;
    return `${m.label} : priorité ${p.priority}.`;
  },
  'match.postpone'(s, p, ctx) {
    const m = getMatch(s, p.matchId);
    assert(['ready', 'called', 'waiting'].includes(m.status), 'INVALID', 'Seule une rencontre non commencée peut être reportée.');
    m.statusBeforePostpone = m.status === 'waiting' ? 'waiting' : 'ready';
    m.status = 'postponed';
    m.targetId = null;
    m.calledAt = null;
    m.postponeReason = String(p.reason || '');
    m.notBefore = p.minutes ? ctx.now + p.minutes * 60000 : null;
    return `${matchTitle(s, m)} reportée${p.reason ? ` (${p.reason})` : ''}.`;
  },
  'match.release'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'postponed', 'INVALID', 'Cette rencontre n\'est pas reportée.');
    m.status = m.a && m.b ? 'ready' : 'waiting';
    m.notBefore = null;
    return `${matchTitle(s, m)} remise au calendrier.`;
  },
  'match.start'(s, p, ctx) {
    const m = getMatch(s, p.matchId);
    assertMatchPlayable(s, m);
    assert(s.status === 'running', 'NOT_RUNNING', 'Le tournoi n\'est pas en cours.');
    if (m.status === 'ready' && p.targetId) {
      assertTargetFree(s, p.targetId, m.id);
      m.targetId = p.targetId;
    }
    assert(['called', 'ready'].includes(m.status), 'INVALID', 'Cette rencontre ne peut pas démarrer dans son état actuel.');
    assert(m.targetId, 'NO_TARGET', 'Affecter une cible avant de démarrer la rencontre.');
    assertTargetFree(s, m.targetId, m.id);
    assertNoParticipantConflict(s, m);
    m.status = 'playing';
    m.startedAt = ctx.now;
    return `Début : ${matchTitle(s, m)}.`;
  },
  'match.suspend'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'playing', 'INVALID', 'La rencontre n\'est pas en cours.');
    m.status = 'suspended';
    if (p.releaseTarget) { m.targetId = null; m.resumeFirst = true; }
    m.suspendReason = String(p.reason || '');
    return `Suspension : ${matchTitle(s, m)}.`;
  },
  'match.resume'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'suspended', 'INVALID', 'La rencontre n\'est pas suspendue.');
    assert(s.status === 'running', 'NOT_RUNNING', 'Le tournoi est interrompu.');
    if (!m.targetId) {
      assert(p.targetId, 'NO_TARGET', 'Choisir une cible pour reprendre la rencontre.');
      assertTargetFree(s, p.targetId, m.id);
      m.targetId = p.targetId;
    } else assertTargetFree(s, m.targetId, m.id);
    m.status = 'playing';
    m.resumeFirst = false;
    return `Reprise : ${matchTitle(s, m)}.`;
  },
  'match.submitResult'(s, p, ctx) {
    const m = getMatch(s, p.matchId);
    assertMatchPlayable(s, m);
    assert(m.status !== 'finished', 'ALREADY_FINISHED', 'Le résultat de cette rencontre est déjà validé : utiliser la correction.');
    assert(m.status !== 'cancelled', 'INVALID', 'Rencontre annulée.');
    assert(m.status !== 'awaiting_validation' || ctx.canValidate, 'ALREADY_SUBMITTED', 'Un résultat attend déjà sa validation.');
    if (p.resultVersion !== undefined) assert(p.resultVersion === m.resultVersion, 'STALE', 'Le résultat a été modifié entre-temps : recharger la rencontre.');
    const outcome = p.result?.outcome || 'normal';
    if (outcome === 'normal' || outcome === 'retired') assert(['playing', 'suspended', 'awaiting_validation', 'called'].includes(m.status) || ctx.canValidate, 'NOT_STARTED', 'La rencontre n\'a pas démarré.');
    if (['playing', 'suspended', 'called', 'awaiting_validation'].includes(m.status) === false && outcome !== 'forfeit') assertNoParticipantConflict(s, m);
    const result = checkResult(m, p.result);
    if (ctx.canValidate || !s.config.requireResultValidation) {
      finalizeResult(s, m, result, ctx);
      return `Résultat validé : ${matchTitle(s, m)} (${result.legsA}-${result.legsB}).`;
    }
    m.pendingResult = { ...result, submittedBy: ctx.userId, submittedAt: ctx.now };
    m.status = 'awaiting_validation';
    return `Résultat saisi, en attente de validation : ${matchTitle(s, m)}.`;
  },
  'match.validateResult'(s, p, ctx) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'awaiting_validation' && m.pendingResult, 'INVALID', 'Aucun résultat en attente de validation.');
    if (p.resultVersion !== undefined) assert(p.resultVersion === m.resultVersion, 'STALE', 'Le résultat a été modifié entre-temps.');
    const { submittedBy, submittedAt, ...result } = m.pendingResult;
    const checked = checkResult(m, { outcome: result.outcome, loser: result.loser, legs: result.legs.map((l) => l.detail) });
    finalizeResult(s, m, { ...checked, submittedBy, submittedAt }, ctx);
    return `Résultat validé : ${matchTitle(s, m)} (${checked.legsA}-${checked.legsB}).`;
  },
  'match.rejectResult'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'awaiting_validation', 'INVALID', 'Aucun résultat en attente.');
    m.history.push({ at: Date.now(), reason: `Saisie rejetée${p.reason ? ` : ${p.reason}` : ''}`, pendingResult: m.pendingResult });
    m.pendingResult = null;
    m.status = 'playing';
    m.resultVersion += 1;
    return `Saisie rejetée : ${matchTitle(s, m)}.`;
  },
  'match.correctResult'(s, p, ctx, events) {
    const m = getMatch(s, p.matchId);
    assertNotArchived(s);
    assert(m.status === 'finished' && m.result && m.result.outcome !== 'bye', 'INVALID', 'Seul un résultat validé peut être corrigé.');
    if (p.resultVersion !== undefined) assert(p.resultVersion === m.resultVersion, 'STALE', 'Le résultat a été modifié entre-temps : recharger.');
    const result = checkResult(m, p.result);
    withImpactControl(s, m, () => {
      m.history.push({ at: ctx.now, reason: `Correction${p.reason ? ` : ${p.reason}` : ''}`, result: m.result, by: ctx.userId });
      m.result = { ...result, validatedBy: ctx.userId, validatedAt: ctx.now, corrected: true };
      m.resultVersion += 1;
    }, p.decision, ctx.now, events);
    return `Résultat corrigé : ${matchTitle(s, m)} (${result.legsA}-${result.legsB}).`;
  },
  'match.annulResult'(s, p, ctx, events) {
    const m = getMatch(s, p.matchId);
    assertNotArchived(s);
    assert(['finished', 'awaiting_validation'].includes(m.status) && m.result?.outcome !== 'bye', 'INVALID', 'Aucun résultat à annuler.');
    withImpactControl(s, m, () => {
      resetMatchForReplay(m, `Résultat annulé, rencontre à rejouer${p.reason ? ` : ${p.reason}` : ''}`, ctx.now);
      m.status = m.a && m.b ? 'ready' : 'waiting';
      m.priority = Math.max(m.priority, 1);
      const ph = phaseRuntime(s, m.phaseId);
      if (ph.status === 'completed') { ph.status = 'active'; ph.completedAt = null; }
      if (s.status === 'finished') { s.status = 'running'; s.finalRanking = null; }
    }, p.decision, ctx.now, events);
    return `Résultat annulé, rencontre à rejouer : ${matchTitle(s, m)}.`;
  },
  'match.cancel'(s, p, ctx, events) {
    const m = getMatch(s, p.matchId);
    assert(m.kind === 'pool', 'INVALID', 'Une rencontre à élimination directe ne peut pas être annulée : déclarer un forfait ou la rejouer.');
    assert(!PLAYED.has(m.status) || m.status === 'finished', 'INVALID', 'Arrêter la rencontre avant de l\'annuler.');
    withImpactControl(s, m, () => {
      if (m.result) m.history.push({ at: ctx.now, reason: `Rencontre annulée${p.reason ? ` : ${p.reason}` : ''}`, result: m.result });
      m.result = null;
      m.status = 'cancelled';
      m.targetId = null;
      m.cancelReason = String(p.reason || '');
    }, p.decision, ctx.now, events);
    return `Rencontre annulée (non comptabilisée) : ${matchTitle(s, m)}.`;
  },
  'match.restore'(s, p) {
    const m = getMatch(s, p.matchId);
    assert(m.status === 'cancelled', 'INVALID', 'Cette rencontre n\'est pas annulée.');
    for (const id of [m.a, m.b]) assert(!OUT_STATUSES.has(getParticipant(s, id).status), 'INVALID', `${pname(s, id)} n'est plus en compétition.`);
    const ph = phaseRuntime(s, m.phaseId);
    assert(ph.status === 'active', 'LOCKED', 'La phase est terminée.');
    m.status = 'ready';
    return `Rencontre rétablie : ${matchTitle(s, m)}.`;
  },
  'schedule.dispatch'() {
    return 'Affectation des cibles recalculée.';
  },
};

export const COMMANDS = Object.keys(handlers);

/**
 * Applique une commande. ctx : { now, userId, canValidate }.
 * Retour : { state, summary, events, result }.
 */
export function applyCommand(state, command, ctx = {}) {
  const handler = handlers[command?.type];
  if (!handler) throw new DomainError('UNKNOWN_COMMAND', `Commande inconnue : ${command?.type}`);
  if (state.status === 'archived' && !['tournament.unarchive', 'members.set', 'members.remove', 'share.regenerate', 'participant.anonymize'].includes(command.type))
    throw new DomainError('ARCHIVED', 'Le tournoi est archivé (lecture seule).');
  const s = structuredClone(state);
  const now = ctx.now ?? Date.now();
  const events = [];
  const fullCtx = { ...ctx, now, result: {} };
  const summary = handler(s, command.payload || {}, fullCtx, events);
  settle(s, now, events);
  s.version = (state.version || 0) + 1;
  s.updatedAt = now;
  return { state: s, summary, events, result: fullCtx.result };
}
