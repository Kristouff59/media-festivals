import { createTournament, applyCommand } from '../src/engine/tournament.js';
import { createRng } from '../src/engine/rng.js';
import { simulateResult } from '../src/engine/simulate.js';
import { busyParticipants, targetOccupancy, isReady } from '../src/engine/scheduler.js';

/** Petit harnais : tournoi + horloge simulée + exécution de commandes. */
export function harness({ config, name = 'Test', targets = 4, seed = 'seed' } = {}) {
  const h = {
    now: 1_700_000_000_000,
    state: createTournament({ name, config, seed, now: 1_700_000_000_000, targets, id: 't_test' }),
    log: [],
    run(type, payload = {}, ctx = {}) {
      const r = applyCommand(h.state, { type, payload }, { now: h.now, userId: 'u1', canValidate: true, ...ctx });
      h.state = r.state;
      h.log.push({ type, summary: r.summary, events: r.events });
      return r;
    },
    tick(min = 1) { h.now += min * 60000; },
    match(id) { return h.state.matches.find((m) => m.id === id); },
    pid(name) { return h.state.participants.find((p) => p.name === name).id; },
    addTeams(n, size = 2, { confirm = true } = {}) {
      for (let i = 1; i <= n; i++) {
        h.run('participant.add', { name: `Équipe ${i}`, players: Array.from({ length: size }, (_, k) => `Joueur ${i}.${k + 1}`), status: confirm ? 'confirmed' : 'registered' });
      }
    },
    addPlayers(n, { confirm = true } = {}) {
      for (let i = 1; i <= n; i++) h.run('participant.add', { name: `Joueur ${i}`, status: confirm ? 'confirmed' : 'registered' });
    },
  };
  return h;
}

/** Invariants de planification vérifiés après chaque étape. */
export function checkScheduleInvariants(state) {
  const live = state.matches.filter((m) => ['called', 'playing', 'suspended', 'awaiting_validation'].includes(m.status));
  const seen = new Map();
  for (const m of live) {
    for (const p of [m.a, m.b]) {
      if (seen.has(p)) throw new Error(`Participant ${p} dans deux rencontres simultanées : ${seen.get(p)} et ${m.id}`);
      seen.set(p, m.id);
    }
  }
  const targets = new Map();
  for (const m of live) {
    if (!m.targetId) continue;
    if (targets.has(m.targetId)) throw new Error(`Cible ${m.targetId} affectée à deux rencontres`);
    targets.set(m.targetId, m.id);
    const t = state.targets.find((x) => x.id === m.targetId);
    if (t.status !== 'available' && m.status === 'called') throw new Error(`Rencontre appelée sur une cible indisponible`);
  }
  // Aucune cible libre alors qu'une rencontre pouvait démarrer (affectation automatique).
  if (state.status === 'running' && state.config.scheduling.autoAssign) {
    const occ = targetOccupancy(state.matches);
    const free = state.targets.filter((t) => t.status === 'available' && !occ.has(t.id));
    const busy = busyParticipants(state.matches);
    const out = new Set(state.participants.filter((p) => ['withdrawn', 'disqualified'].includes(p.status)).map((p) => p.id));
    const active = new Set(state.phases.filter((p) => p.status === 'active').map((p) => p.id));
    const startable = state.matches.filter((m) => active.has(m.phaseId) && isReady(m, Infinity, out) && !busy.has(m.a) && !busy.has(m.b) && !m.pinnedTargetId);
    if (free.length && startable.length && state.config.scheduling.allowBackToBack !== false) throw new Error(`Cible libre alors que ${startable[0].id} pouvait démarrer`);
  }
}

/** Joue le tournoi jusqu'au bout avec des résultats simulés valides (vrais moteurs). */
export function playOut(h, { rngSeed = 'play', maxSteps = 2000, onStep, legMinutes = 10, resolveTies = true } = {}) {
  const rng = createRng(rngSeed);
  let steps = 0;
  while (h.state.status === 'running' && steps++ < maxSteps) {
    checkScheduleInvariants(h.state);
    const ph = h.state.phases.find((p) => p.awaitingDecision?.type === 'ties');
    if (ph) {
      if (!resolveTies) return;
      for (const t of ph.awaitingDecision.ties) h.run('phase.resolveTie', { phaseId: ph.id, poolId: t.poolId, method: 'lot' });
      continue;
    }
    const live = h.state.matches.filter((m) => ['called', 'playing'].includes(m.status)).sort((a, b) => (a.calledAt || 0) - (b.calledAt || 0));
    if (!live.length) throw new Error(`Blocage : aucune rencontre en cours (${h.state.matches.map((m) => `${m.id}:${m.status}`).join(' ')})`);
    const m = live[0];
    if (m.status === 'called') h.run('match.start', { matchId: m.id });
    h.tick(legMinutes);
    h.run('match.submitResult', { matchId: m.id, result: simulateResult(m.rules, rng) });
    if (onStep) onStep(h, m);
  }
  checkScheduleInvariants(h.state);
}
