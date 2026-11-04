// Classement final du tournoi, selon le règlement configuré.
//  - Phase finale : 1 vainqueur, 2 finaliste, 3/4 petite finale (sinon 3e ex
//    aequo), puis perdants de chaque tour (ex aequo ou départagés par leur
//    tête de série selon `placement`).
//  - Poules (dernière phase) : rang de poule, puis comparaison inter-poules.
//  - Non-qualifiés des phases précédentes : classés à la suite, par rang de
//    poule puis comparaison inter-poules.
import { crossPoolCompare, computeStandings } from './standings.js';

function poolTable(state, phaseCfg, ph) {
  const out = [];
  ph.pools.forEach((pool, poolIndex) => {
    const matches = state.matches.filter((m) => m.phaseId === phaseCfg.id && m.poolId === pool.id);
    const excluded = new Set(pool.participantIds.filter((id) => state.participants.find((p) => p.id === id)?.excludedFrom?.includes(phaseCfg.id)));
    const st = computeStandings({ participantIds: pool.participantIds, matches, phase: phaseCfg, seed: state.seed, poolId: `${phaseCfg.id}:${pool.id}`, manualOrder: pool.manualOrder || [], excluded });
    st.rows.forEach((r) => out.push({ ...r, poolIndex, poolId: pool.id }));
  });
  return out;
}

function orderPoolRows(rows) {
  const ranked = rows.filter((r) => !r.excluded);
  ranked.sort((x, y) => x.rank - y.rank || crossPoolCompare(x, y));
  return ranked.concat(rows.filter((r) => r.excluded));
}

function assignPositions(list, start) {
  // list : [{ participantId, key }] ; même clé = ex aequo
  const out = [];
  let pos = start;
  list.forEach((e, i) => {
    if (i > 0 && e.key !== list[i - 1].key) pos = start + i;
    out.push({ participantId: e.participantId, position: e.key === null ? null : pos, tied: false, note: e.note || '' });
  });
  out.forEach((e) => { e.tied = out.filter((x) => x.position === e.position && e.position !== null).length > 1; });
  return out;
}

export function computeFinalRanking(state) {
  const phases = state.config.phases;
  const result = [];
  const placed = new Set();
  const noteFor = (id) => {
    const p = state.participants.find((x) => x.id === id);
    if (p?.status === 'withdrawn') return 'Désisté';
    if (p?.status === 'disqualified') return 'Disqualifié';
    return '';
  };
  let next = 1;
  for (let i = phases.length - 1; i >= 0; i--) {
    const cfg = phases[i];
    const ph = state.phases[i];
    if (!ph || ph.status === 'pending') continue;
    let block = [];
    if (cfg.type === 'knockout') {
      const ko = state.matches.filter((m) => m.phaseId === cfg.id);
      const main = ko.filter((m) => m.roundKey !== 'third');
      const R = Math.max(...main.map((m) => m.roundIndex)) + 1;
      const size = 2 ** R;
      const seedIdx = (id) => ph.entrants.indexOf(id);
      const final = main.find((m) => m.roundIndex === R - 1);
      const third = ko.find((m) => m.roundKey === 'third');
      const entries = [];
      const done = (m) => m && m.status === 'finished' && m.result && m.result.winner;
      if (done(final)) {
        entries.push({ participantId: final[final.result.winner], position: 1 });
        entries.push({ participantId: final[final.result.loser], position: 2 });
      }
      if (R >= 2) {
        if (third && done(third) && third.result.outcome !== 'bye') {
          entries.push({ participantId: third[third.result.winner], position: 3 });
          entries.push({ participantId: third[third.result.loser], position: 4 });
        } else if (third && done(third)) {
          entries.push({ participantId: third[third.result.winner], position: 3 });
        } else if (!third) {
          for (const m of main.filter((x) => x.roundIndex === R - 2 && done(x) && x.result.outcome !== 'bye')) entries.push({ participantId: m[m.result.loser], position: 3 });
        }
      }
      for (let r = R - 3; r >= 0; r--) {
        const start = size / 2 ** (r + 1) + 1;
        const losers = main.filter((x) => x.roundIndex === r && done(x) && x.result.outcome !== 'bye').map((m) => m[m.result.loser]).filter(Boolean);
        losers.sort((a, b) => seedIdx(a) - seedIdx(b));
        losers.forEach((id, k) => entries.push({ participantId: id, position: cfg.placement === 'bySeed' ? start + k : start }));
      }
      // Clôture anticipée : participants encore en lice, ex aequo au meilleur rang non attribué.
      const inEntries = new Set(entries.map((e) => e.participantId));
      const alive = ph.entrants.filter((id) => !inEntries.has(id));
      if (alive.length) {
        const free = [1, 2, 3].find((p) => !entries.some((e) => e.position === p)) || 1;
        alive.forEach((id) => entries.push({ participantId: id, position: free, note: 'Tournoi clôturé avant la fin' }));
      }
      entries.sort((a, b) => a.position - b.position);
      block = entries.map((e) => ({ ...e, position: e.position + next - 1 }));
      const counts = {};
      block.forEach((e) => { counts[e.position] = (counts[e.position] || 0) + 1; });
      block.forEach((e) => { e.tied = counts[e.position] > 1; e.note = e.note || noteFor(e.participantId); });
    } else {
      const rows = orderPoolRows(poolTable(state, cfg, ph)).filter((r) => !placed.has(r.participantId));
      const list = rows.map((r) => ({
        participantId: r.participantId,
        key: r.excluded ? null : r.tied ? `t${r.rank}:${r.poolId}` : `${r.participantId}`,
        note: r.excluded ? 'Résultats annulés' : '',
      }));
      // Même rang de poule et statistiques identiques entre poules : ex aequo.
      for (let k = 1; k < rows.length; k++) {
        if (!rows[k].excluded && !rows[k - 1].excluded && rows[k].rank === rows[k - 1].rank && rows[k].poolId !== rows[k - 1].poolId && crossPoolCompare({ ...rows[k], poolIndex: 0 }, { ...rows[k - 1], poolIndex: 0 }) === 0) list[k].key = list[k - 1].key;
      }
      block = assignPositions(list, next).map((e) => ({ ...e, note: e.note || noteFor(e.participantId) }));
    }
    const fresh = block.filter((e) => !placed.has(e.participantId));
    fresh.forEach((e) => placed.add(e.participantId));
    result.push(...fresh);
    next = placed.size + 1;
  }
  // Participants n'ayant disputé aucune phase (absents) : non classés.
  return result.map((e) => ({ ...e, name: state.participants.find((p) => p.id === e.participantId)?.name || '?' }));
}
