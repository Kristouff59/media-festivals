// Vue calculée d'un tournoi : rien n'est stocké en double, tout est recalculé
// à partir de l'état (classements, statut de qualification, cibles, prévisions).
import { poolStandings, phaseConfig, activeEntrants, blockingTies, qualifiersOf } from './tournament.js';
import { mathematicalStatus } from './standings.js';
import { forecast, targetOccupancy } from './scheduler.js';
import { validateConfig } from './config.js';
import { atLeast } from './permissions.js';
import { computeFinalRanking } from './ranking.js';

export function buildDerived(state, now = Date.now()) {
  const phases = state.config.phases.map((cfg, i) => {
    const ph = state.phases[i];
    const out = { id: cfg.id, name: cfg.name, type: cfg.type, status: ph.status, awaitingDecision: ph.awaitingDecision || null, drawSeed: ph.drawSeed || null };
    if (cfg.type === 'pools' && ph.pools.length) {
      out.pools = ph.pools.map((pool) => {
        const matches = state.matches.filter((m) => m.phaseId === cfg.id && m.poolId === pool.id);
        const st = ph.status === 'draft' ? { rows: pool.participantIds.map((id) => ({ participantId: id })), unresolvedTies: [] } : poolStandings(state, cfg.id, pool.id);
        const active = pool.participantIds.filter((id) => !state.participants.find((p) => p.id === id)?.excludedFrom?.includes(cfg.id));
        const math = matches.length ? mathematicalStatus({ participantIds: active, matches, phase: cfg, qualifiers: cfg.qualifiersPerPool }) : null;
        const complete = matches.length > 0 && matches.every((m) => ['finished', 'cancelled'].includes(m.status));
        const qualified = complete && i < state.config.phases.length - 1 ? new Set(qualifiersOfSafe(state, cfg.id).filter((q) => q.poolId === pool.id).map((q) => q.participantId)) : null;
        const rows = st.rows.map((r) => ({
          ...r,
          qualification: r.excluded ? 'excluded' : qualified ? (qualified.has(r.participantId) ? 'qualified' : 'eliminated') : math?.status[r.participantId] || 'open',
        }));
        return {
          id: pool.id,
          name: pool.name,
          participantIds: pool.participantIds,
          rows,
          unresolvedTies: st.unresolvedTies,
          matchCount: matches.length,
          finishedCount: matches.filter((m) => m.status === 'finished').length,
          complete,
          mathExact: math?.exact ?? true,
        };
      });
      out.blockingTies = ph.status === 'active' ? blockingTies(state, cfg.id) : [];
    }
    if (cfg.type === 'knockout') {
      const ms = state.matches.filter((m) => m.phaseId === cfg.id);
      const rounds = [...new Set(ms.filter((m) => m.roundKey !== 'third').map((m) => m.roundIndex))].sort((a, b) => a - b);
      out.rounds = rounds.map((r) => {
        const list = ms.filter((m) => m.roundIndex === r && m.roundKey !== 'third').sort((a, b) => a.slot - b.slot);
        return { index: r, name: list[0]?.roundName, key: list[0]?.roundKey, matchIds: list.map((m) => m.id) };
      });
      const third = ms.find((m) => m.roundKey === 'third');
      out.thirdPlaceMatchId = third?.id || null;
      out.entrants = ph.entrants;
    }
    return out;
  });

  const occ = targetOccupancy(state.matches);
  let plan = [];
  try {
    plan = forecast(state, now);
  } catch {
    plan = [];
  }
  const planById = new Map(plan.map((p) => [p.matchId, p]));
  const targets = state.targets.map((t) => {
    const cur = occ.get(t.id);
    const queue = plan.filter((p) => p.targetId === t.id && !p.inProgress).slice(0, 3).map((p) => p.matchId);
    return { ...t, state: t.status === 'unavailable' ? 'unavailable' : cur ? 'occupied' : 'free', currentMatchId: cur || null, queue };
  });
  const upcoming = plan.filter((p) => !p.inProgress).sort((a, b) => a.estimatedStart - b.estimatedStart).map((p) => p.matchId);

  const alerts = [];
  const late = (state.config.scheduling?.lateAfterMinutes ?? 10) * 60000;
  for (const m of state.matches) {
    if (m.status === 'awaiting_validation') alerts.push({ level: 'action', type: 'validation', matchId: m.id, text: `Résultat à valider : ${m.label}` });
    if (m.status === 'suspended' && !m.targetId) alerts.push({ level: 'warning', type: 'needsTarget', matchId: m.id, text: `${m.label} suspendue sans cible : la reprendre sur une cible libre.` });
    if (m.status === 'called' && m.calledAt && now - m.calledAt > late) alerts.push({ level: 'warning', type: 'late', matchId: m.id, text: `${m.label} appelée depuis ${Math.round((now - m.calledAt) / 60000)} min sans avoir démarré.` });
    if (m.conflict) alerts.push({ level: 'error', type: 'conflict', matchId: m.id, text: `${m.label} : participants incohérents avec le tableau (correction à arbitrer).` });
  }
  for (const ph of phases) {
    if (ph.awaitingDecision?.type === 'ties') for (const t of ph.awaitingDecision.ties) alerts.push({ level: 'action', type: 'tie', phaseId: ph.id, poolId: t.poolId, text: `${t.poolName} : égalité persistante à départager (${t.participantIds.length} participants à partir du rang ${t.fromRank}).` });
  }
  for (const t of state.targets) if (t.status === 'unavailable') alerts.push({ level: 'info', type: 'target', text: `${t.name} indisponible${t.note ? ` : ${t.note}` : ''}.` });

  const entrants = activeEntrants(state).length;
  const configCheck = validateConfig(state.config, state.phases[0].status === 'pending' || state.phases[0].status === 'draft' ? entrants : state.phases[0].entrants.length || entrants);
  let finalRanking = state.finalRanking;
  if (!finalRanking && state.phases.some((p) => p.status !== 'pending')) {
    try { finalRanking = computeFinalRanking(state); } catch { finalRanking = null; }
  }
  return { phases, targets, forecast: Object.fromEntries(planById), upcoming, alerts, configCheck, entrants, finalRanking, provisionalRanking: !state.finalRanking };
}

function qualifiersOfSafe(state, phaseId) {
  try {
    return qualifiersOf(state, phaseId);
  } catch {
    return [];
  }
}

/** Filtre les données selon le rôle (données personnelles, jetons, membres). */
export function redactFor(state, role) {
  const s = structuredClone(state);
  delete s.recentCommands;
  if (!atLeast(role, 'organizer')) {
    s.participants.forEach((p) => { delete p.contact; delete p.history; });
  }
  if (!atLeast(role, 'organizer')) {
    s.share = {};
    s.members = [];
    s.decisions = [];
  }
  return s;
}

export function buildView(state, role, now = Date.now()) {
  void phaseConfig;
  return { tournament: redactFor(state, role), derived: buildDerived(state, now), role };
}
