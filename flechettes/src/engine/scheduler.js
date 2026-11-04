// Planification des rencontres sur les cibles.
//
// Contraintes impératives (jamais violées) :
//  - un participant ne dispute jamais deux rencontres en même temps ;
//  - une cible n'accueille qu'une rencontre à la fois et jamais si elle est indisponible ;
//  - une rencontre n'est appelée que si ses deux participants sont connus.
// Objectifs d'optimisation (ordre lexicographique) :
//  1. priorité manuelle, puis rencontres suspendues à reprendre ;
//  2. respect de l'ordre des phases et des tours du tableau ;
//  3. éviter les matchs consécutifs (repos < repos minimal) ;
//  4. faire progresser les tours de round-robin de façon homogène ;
//  5. faire jouer en priorité ceux qui attendent depuis le plus longtemps ;
//  6. ne jamais laisser une cible libre si une rencontre peut y démarrer
//     (sauf si `allowBackToBack` est désactivé et que seul un match consécutif est possible).

export const BUSY_STATUSES = new Set(['called', 'playing', 'suspended', 'awaiting_validation']);
export const OCCUPYING_STATUSES = new Set(['called', 'playing', 'suspended', 'awaiting_validation']);

export function busyParticipants(matches) {
  const busy = new Map();
  for (const m of matches) {
    if (!BUSY_STATUSES.has(m.status)) continue;
    if (m.a) busy.set(m.a, m.id);
    if (m.b) busy.set(m.b, m.id);
  }
  return busy;
}

export function targetOccupancy(matches) {
  const occ = new Map();
  for (const m of matches) if (m.targetId && OCCUPYING_STATUSES.has(m.status)) occ.set(m.targetId, m.id);
  return occ;
}

export function lastEndTimes(matches) {
  const last = new Map();
  for (const m of matches) {
    if (m.status !== 'finished' || !m.endedAt || m.result?.outcome === 'bye') continue;
    for (const p of [m.a, m.b]) if (p && (!last.has(p) || last.get(p) < m.endedAt)) last.set(p, m.endedAt);
  }
  return last;
}

export function isReady(m, now, unavailable = new Set()) {
  if (m.status !== 'ready') return false;
  if (!m.a || !m.b) return false;
  if (unavailable.has(m.a) || unavailable.has(m.b)) return false;
  if (m.notBefore && m.notBefore > now) return false;
  return true;
}

function candidateKey(m, ctx) {
  const rests = [m.a, m.b].map((p) => (ctx.lastEnd.has(p) ? ctx.now - ctx.lastEnd.get(p) : Infinity));
  const backToBack = rests.filter((r) => r < ctx.minRestMs).length;
  const minRest = Math.min(...rests);
  const maxRest = Math.max(...rests);
  return [
    -(m.priority || 0),
    m.resumeFirst ? 0 : 1,
    ctx.phaseOrder.get(m.phaseId) ?? 0,
    m.kind === 'knockout' ? m.roundIndex : 0,
    backToBack,
    m.kind === 'pool' ? m.round : 0,
    minRest === Infinity ? -1e15 : -minRest,
    maxRest === Infinity ? -1e15 : -maxRest,
    m.seq ?? 0,
  ];
}

function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Choisit les rencontres à appeler sur les cibles libres.
 * state : { matches, targets, phases, config, unavailableParticipants? }
 * Retour : [{ matchId, targetId }] — ne modifie pas l'état.
 */
export function proposeAssignments(state, now) {
  const sched = state.config.scheduling || {};
  const minRestMs = (sched.minRestMinutes ?? 0) * 60000;
  const matches = state.matches;
  const busy = busyParticipants(matches);
  const occ = targetOccupancy(matches);
  const unavailable = state.unavailableParticipants || new Set();
  const ctx = {
    now,
    minRestMs,
    lastEnd: lastEndTimes(matches),
    phaseOrder: new Map(state.config.phases.map((p, i) => [p.id, i])),
  };
  const freeTargets = state.targets.filter((t) => t.status === 'available' && !occ.has(t.id));
  const out = [];
  const taken = new Set();
  const activePhases = new Set(state.phases.filter((p) => p.status === 'active').map((p) => p.id));
  let candidates = matches.filter((m) => activePhases.has(m.phaseId) && (isReady(m, now, unavailable) || (m.status === 'suspended' && !m.targetId)));
  candidates = candidates.map((m) => ({ m, key: candidateKey(m, ctx) })).sort((x, y) => cmpKeys(x.key, y.key));
  for (const t of freeTargets) {
    const pick = candidates.find(({ m, key }) => {
      if (taken.has(m.id)) return false;
      if (m.pinnedTargetId && m.pinnedTargetId !== t.id) return false;
      if (m.status !== 'suspended' && (busy.has(m.a) || busy.has(m.b))) return false;
      if (sched.allowBackToBack === false && key[4] > 0) return false;
      return true;
    });
    if (!pick) continue;
    taken.add(pick.m.id);
    busy.set(pick.m.a, pick.m.id);
    busy.set(pick.m.b, pick.m.id);
    out.push({ matchId: pick.m.id, targetId: t.id });
  }
  return out;
}

export function estimatedDurationMs(m, config) {
  const r = m.rules;
  const per = (config.scheduling?.estimatedLegMinutes || {})[r.game] ?? 10;
  const need = Math.floor(r.bestOf / 2) + 1;
  const expectedLegs = need + (r.bestOf - need) / 2;
  return Math.round(expectedLegs * per * 60000);
}

/**
 * Prévision du calendrier : simule la suite du tournoi avec les durées
 * estimées et le même algorithme de choix que l'affectation réelle.
 * Retour : [{ matchId, targetId, estimatedStart, estimatedEnd }].
 */
export function forecast(state, now, { horizon = 500 } = {}) {
  const config = state.config;
  const sim = state.matches.map((m) => ({ ...m }));
  const byId = new Map(sim.map((m) => [m.id, m]));
  const plan = [];
  // Matchs en cours : fin estimée.
  const ends = [];
  for (const m of sim) {
    if (!OCCUPYING_STATUSES.has(m.status) || !m.targetId) continue;
    const start = m.startedAt || m.calledAt || now;
    const end = Math.max(now + 60000, start + estimatedDurationMs(m, config));
    ends.push({ at: end, id: m.id });
    plan.push({ matchId: m.id, targetId: m.targetId, estimatedStart: start, estimatedEnd: end, inProgress: true });
  }
  // Les matchs de tableau dont les participants sont inconnus deviennent
  // « prêts » dans la simulation dès que leurs sources sont terminées,
  // avec des participants fictifs issus des sources.
  const pending = sim.filter((m) => m.status === 'waiting');
  const phasesActive = new Set(state.phases.filter((p) => p.status === 'active' || p.status === 'pending' || p.status === 'draft').map((p) => p.id));
  let t = now;
  const simState = {
    config,
    targets: state.targets,
    phases: state.phases.map((p) => ({ ...p, status: phasesActive.has(p.id) ? 'active' : p.status })),
    matches: sim,
    unavailableParticipants: state.unavailableParticipants,
  };
  // Une phase ultérieure n'est simulée qu'une fois la précédente terminée.
  const phaseIds = config.phases.map((p) => p.id);
  const phaseDone = (pid) => sim.every((m) => m.phaseId !== pid || ['finished', 'cancelled'].includes(m.status));
  for (let iter = 0; iter < horizon; iter++) {
    for (const m of pending) {
      if (m.status !== 'waiting') continue;
      const sa = m.sourceA && byId.get(m.sourceA.matchId);
      const sb = m.sourceB && byId.get(m.sourceB.matchId);
      if ((sa && sa.status !== 'finished') || (sb && sb.status !== 'finished')) continue;
      if (!m.a) m.a = `?${m.sourceA.take}:${m.sourceA.matchId}`;
      if (!m.b) m.b = `?${m.sourceB.take}:${m.sourceB.matchId}`;
      m.status = 'ready';
    }
    simState.phases.forEach((p) => {
      const idx = phaseIds.indexOf(p.id);
      p.status = idx === 0 || phaseDone(phaseIds[idx - 1]) ? (phasesActive.has(p.id) || p.status === 'active' ? 'active' : p.status) : 'blocked';
    });
    const props = proposeAssignments(simState, t);
    for (const { matchId, targetId } of props) {
      const m = byId.get(matchId);
      m.status = 'playing';
      m.targetId = targetId;
      m.startedAt = t;
      const end = t + estimatedDurationMs(m, config);
      ends.push({ at: end, id: m.id });
      plan.push({ matchId, targetId, estimatedStart: t, estimatedEnd: end });
    }
    if (!ends.length) break;
    ends.sort((x, y) => x.at - y.at);
    const next = ends.shift();
    t = Math.max(t, next.at);
    const m = byId.get(next.id);
    m.status = 'finished';
    m.endedAt = t;
    m.result = m.result || { outcome: 'normal' };
    // Propagation fictive des participants (identité des sources) pour le repos.
    for (const d of pending) {
      if (d.sourceA?.matchId === m.id) d.a = `?${d.sourceA.take}:${m.id}`;
      if (d.sourceB?.matchId === m.id) d.b = `?${d.sourceB.take}:${m.id}`;
    }
  }
  return plan;
}
