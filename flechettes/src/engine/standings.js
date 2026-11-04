// Classements de poule : calcul déterministe, critères de départage ordonnés
// et configurables, confrontations directes, égalités persistantes signalées,
// statut mathématique de qualification.
import { hashString } from './rng.js';

function emptyRow(id) {
  return { participantId: id, played: 0, wins: 0, draws: 0, losses: 0, forfeitsLost: 0, points: 0, legsFor: 0, legsAgainst: 0, pointsFor: 0, pointsAgainst: 0 };
}

export function countsInStandings(m) {
  return m.status === 'finished' && m.result && m.result.outcome !== 'bye';
}

function matchPoints(result, side, pts) {
  if (result.winner === null) return pts.draw;
  if (result.winner === side) return pts.win;
  return result.outcome === 'forfeit' || result.outcome === 'disqualified' ? pts.forfeitLoss : pts.loss;
}

export function addMatch(rows, m, pts) {
  const r = m.result;
  for (const side of ['a', 'b']) {
    const row = rows.get(m[side]);
    if (!row) continue;
    const other = side === 'a' ? 'b' : 'a';
    row.played++;
    if (r.winner === null) row.draws++;
    else if (r.winner === side) row.wins++;
    else {
      row.losses++;
      if (r.outcome === 'forfeit' || r.outcome === 'disqualified') row.forfeitsLost++;
    }
    row.points += matchPoints(r, side, pts);
    row.legsFor += side === 'a' ? r.legsA : r.legsB;
    row.legsAgainst += side === 'a' ? r.legsB : r.legsA;
    row.pointsFor += side === 'a' ? r.forA : r.forB;
    row.pointsAgainst += side === 'a' ? r.forB : r.forA;
    void other;
  }
}

export function buildRows(participantIds, matches, pts) {
  const rows = new Map(participantIds.map((id) => [id, emptyRow(id)]));
  for (const m of matches) if (countsInStandings(m)) addMatch(rows, m, pts);
  for (const row of rows.values()) {
    row.legDiff = row.legsFor - row.legsAgainst;
    row.pointDiff = row.pointsFor - row.pointsAgainst;
  }
  return rows;
}

function criterionValue(c, row, group, ctx) {
  switch (c) {
    case 'points': return row.points;
    case 'wins': return row.wins;
    case 'legDiff': return row.legDiff;
    case 'legsWon': return row.legsFor;
    case 'pointDiff': return row.pointDiff;
    case 'pointsFor': return row.pointsFor;
    case 'lot': return hashString(`${ctx.seed}:${ctx.poolId}:${row.participantId}`);
    case 'headToHead': {
      const ids = new Set(group.map((g) => g.participantId));
      const mini = buildRows([...ids], ctx.matches.filter((m) => ids.has(m.a) && ids.has(m.b)), ctx.pts);
      return mini.get(row.participantId).points;
    }
    default: return 0;
  }
}

function partition(rows, criteria, ctx, trace) {
  if (rows.length <= 1 || !criteria.length) return [rows];
  const [c, ...rest] = criteria;
  const vals = new Map(rows.map((r) => [r.participantId, criterionValue(c, r, rows, ctx)]));
  const distinct = [...new Set(vals.values())].sort((x, y) => y - x);
  if (distinct.length > 1 && trace) trace.push({ criterion: c, among: rows.map((r) => r.participantId) });
  const out = [];
  for (const v of distinct) {
    const sub = rows.filter((r) => vals.get(r.participantId) === v);
    out.push(...partition(sub, rest, ctx, trace));
  }
  return out;
}

/**
 * Classement d'une poule.
 * options : { participantIds, matches, phase, seed, poolId, manualOrder, totalMatches }
 * Retour : { rows: [...], unresolvedTies: [[ids]], complete }
 */
export function computeStandings({ participantIds, matches, phase, seed = '', poolId = '', manualOrder = [], excluded = new Set() }) {
  const pts = phase.points;
  const active = participantIds.filter((id) => !excluded.has(id));
  const relevant = matches.filter((m) => m.status !== 'cancelled');
  const rowsMap = buildRows(active, relevant, pts);
  const ctx = { matches: relevant.filter(countsInStandings), pts, seed, poolId };
  const trace = [];
  const groups = partition([...rowsMap.values()], phase.tiebreakers, ctx, trace);
  const ordered = [];
  const unresolvedTies = [];
  for (const g of groups) {
    if (g.length === 1) { ordered.push({ ...g[0], tied: false }); continue; }
    const ids = g.map((r) => r.participantId);
    const manual = ids.every((id) => manualOrder.includes(id));
    if (manual) {
      g.sort((x, y) => manualOrder.indexOf(x.participantId) - manualOrder.indexOf(y.participantId));
      g.forEach((r) => ordered.push({ ...r, tied: false, manual: true }));
    } else {
      // Ordre d'affichage stable (identifiant) ; égalité signalée.
      g.sort((x, y) => (x.participantId < y.participantId ? -1 : 1));
      g.forEach((r) => ordered.push({ ...r, tied: true, tieGroup: ids }));
      unresolvedTies.push(ids);
    }
  }
  let pos = 0;
  ordered.forEach((r, i) => {
    if (!(r.tied && i > 0 && ordered[i - 1].tied && ordered[i - 1].tieGroup === r.tieGroup)) pos = i + 1;
    r.rank = pos;
  });
  // Participants exclus (désistés avec annulation, disqualifiés) placés en fin, non classés.
  for (const id of participantIds) if (excluded.has(id)) ordered.push({ ...emptyRow(id), excluded: true, rank: null, tied: false });
  return { rows: ordered, unresolvedTies, trace };
}

/**
 * Statut mathématique (qualifié / éliminé / en jeu) fondé sur les points
 * uniquement — donc valable quels que soient les départages.
 */
export function mathematicalStatus({ participantIds, matches, phase, qualifiers }) {
  const pts = phase.points;
  const done = matches.filter((m) => m.status !== 'cancelled' && countsInStandings(m));
  const remaining = matches.filter((m) => m.status !== 'cancelled' && !countsInStandings(m) && participantIds.includes(m.a) && participantIds.includes(m.b));
  const base = buildRows(participantIds, done, pts);
  const status = {};
  const lossMin = Math.min(pts.loss, pts.forfeitLoss);
  const lossMax = Math.max(pts.loss, pts.forfeitLoss);
  const outcomes = phase.allowDraw ? ['a', 'b', 'd'] : ['a', 'b'];
  const k = remaining.length;
  const enumerate = outcomes.length ** k <= 60000;
  for (const p of participantIds) {
    if (qualifiers >= participantIds.length) { status[p] = 'qualified'; continue; }
    let alwaysIn = true;
    let alwaysOut = true;
    if (enumerate) {
      const total = outcomes.length ** k;
      for (let s = 0; s < total && (alwaysIn || alwaysOut); s++) {
        // Scénario pessimiste et optimiste pour p évalués simultanément.
        const pess = new Map([...base].map(([id, r]) => [id, r.points]));
        const opt = new Map(pess);
        let code = s;
        for (const m of remaining) {
          const o = outcomes[code % outcomes.length];
          code = Math.floor(code / outcomes.length);
          if (o === 'd') {
            for (const id of [m.a, m.b]) { pess.set(id, pess.get(id) + pts.draw); opt.set(id, opt.get(id) + pts.draw); }
          } else {
            const w = o === 'a' ? m.a : m.b;
            const l = o === 'a' ? m.b : m.a;
            pess.set(w, pess.get(w) + pts.win); opt.set(w, opt.get(w) + pts.win);
            pess.set(l, pess.get(l) + (l === p ? lossMin : lossMax));
            opt.set(l, opt.get(l) + (l === p ? lossMax : lossMin));
          }
        }
        const ahead = participantIds.filter((o) => o !== p && pess.get(o) >= pess.get(p)).length;
        if (ahead > qualifiers - 1) alwaysIn = false;
        const strictlyAhead = participantIds.filter((o) => o !== p && opt.get(o) > opt.get(p)).length;
        if (strictlyAhead < qualifiers) alwaysOut = false;
      }
    } else {
      const left = (id) => remaining.filter((m) => m.a === id || m.b === id).length;
      const pMin = base.get(p).points + left(p) * lossMin;
      const pMax = base.get(p).points + left(p) * pts.win;
      const maxOf = (id) => base.get(id).points + left(id) * pts.win;
      const minOf = (id) => base.get(id).points + left(id) * lossMin;
      alwaysIn = participantIds.filter((o) => o !== p && maxOf(o) >= pMin).length <= qualifiers - 1;
      alwaysOut = participantIds.filter((o) => o !== p && minOf(o) > pMax).length >= qualifiers;
    }
    status[p] = alwaysIn ? 'qualified' : alwaysOut ? 'eliminated' : 'open';
  }
  return { status, remaining: k, exact: enumerate };
}

/**
 * Classement inter-poules des participants de même rang (placement dans le
 * tableau final, classement final des éliminés) : moyennes par match pour
 * neutraliser les poules de tailles inégales.
 */
export function crossPoolCompare(x, y) {
  const per = (r, k) => (r.played ? r[k] / r.played : 0);
  const keys = ['points', 'legDiff', 'pointDiff', 'legsFor'];
  for (const k of keys) {
    const d = per(y, k) - per(x, k);
    if (Math.abs(d) > 1e-9) return d;
  }
  return (x.poolIndex ?? 0) - (y.poolIndex ?? 0);
}
