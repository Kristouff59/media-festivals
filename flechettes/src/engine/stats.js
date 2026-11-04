// Statistiques et palmarès calculés UNIQUEMENT à partir des données
// réellement enregistrées (rencontres validées, classements finals).
// Les tournois de démonstration sont exclus par l'appelant.
import { normalizeName } from './errors.js';
import { GAMES } from './games/index.js';

function blank(name, kind) {
  return { name, kind, tournaments: 0, matches: 0, wins: 0, losses: 0, draws: 0, forfeitsWon: 0, forfeitsLost: 0, legsWon: 0, legsLost: 0, titles: 0, podiums: 0, byGame: {}, results: [] };
}

function bump(rec, game, field, n = 1) {
  rec[field] += n;
  rec.byGame[game] = rec.byGame[game] || { matches: 0, wins: 0, losses: 0, draws: 0 };
  if (field in rec.byGame[game]) rec.byGame[game][field] += n;
}

export function computeStats(tournaments) {
  const entities = new Map(); // participants (équipes ou joueurs individuels)
  const players = new Map(); // joueurs, y compris membres d'équipes
  const get = (map, name, kind) => {
    const k = `${kind}:${normalizeName(name)}`;
    if (!map.has(k)) map.set(k, blank(name, kind));
    return map.get(k);
  };
  let matchCount = 0;
  const palmares = [];
  for (const t of tournaments) {
    const kind = t.config.mode === 'team' ? 'team' : 'player';
    const byId = new Map(t.participants.map((p) => [p.id, p]));
    const recs = new Map();
    const precs = new Map();
    for (const p of t.participants) {
      if (!t.matches.some((m) => m.a === p.id || m.b === p.id)) continue;
      const r = get(entities, p.name, kind);
      r.tournaments++;
      recs.set(p.id, r);
      const pl = kind === 'team' ? p.players.map((x) => get(players, x.name, 'player')) : [r];
      if (kind === 'team') pl.forEach((x) => x.tournaments++);
      precs.set(p.id, pl);
    }
    for (const m of t.matches) {
      if (m.status !== 'finished' || !m.result || m.result.outcome === 'bye' || !m.a || !m.b) continue;
      matchCount++;
      const game = m.rules.game;
      for (const side of ['a', 'b']) {
        const targets = [recs.get(m[side]), ...(kind === 'team' ? precs.get(m[side]) || [] : [])].filter(Boolean);
        for (const rec of targets) {
          bump(rec, game, 'matches');
          if (m.result.winner === null) bump(rec, game, 'draws');
          else if (m.result.winner === side) {
            bump(rec, game, 'wins');
            if (['forfeit', 'disqualified'].includes(m.result.outcome)) rec.forfeitsWon++;
          } else {
            bump(rec, game, 'losses');
            if (['forfeit', 'disqualified'].includes(m.result.outcome)) rec.forfeitsLost++;
          }
          rec.legsWon += side === 'a' ? m.result.legsA : m.result.legsB;
          rec.legsLost += side === 'a' ? m.result.legsB : m.result.legsA;
        }
      }
    }
    if (t.finalRanking) {
      for (const e of t.finalRanking) {
        const p = byId.get(e.participantId);
        if (!p) continue;
        const all = [recs.get(p.id), ...(kind === 'team' ? precs.get(p.id) || [] : [])].filter(Boolean);
        for (const rec of all) {
          rec.results.push({ tournamentId: t.id, tournament: t.name, date: t.finishedAt || t.updatedAt, position: e.position, tied: e.tied, as: rec.kind === kind ? null : p.name });
          if (e.position === 1) rec.titles++;
          if (e.position && e.position <= 3) rec.podiums++;
        }
      }
      const podium = (pos) => t.finalRanking.filter((e) => e.position === pos).map((e) => e.name);
      palmares.push({
        tournamentId: t.id,
        name: t.name,
        date: t.finishedAt || t.updatedAt,
        mode: t.config.mode,
        games: [...new Set(t.config.phases.map((p) => GAMES[p.game]?.label || p.game))],
        participants: t.participants.filter((p) => t.matches.some((m) => m.a === p.id || m.b === p.id)).length,
        winner: podium(1),
        second: podium(2),
        third: podium(3),
        incomplete: !!t.incomplete,
      });
    }
  }
  const finish = (r) => ({ ...r, winRate: r.matches ? Math.round((r.wins / r.matches) * 1000) / 10 : null });
  return {
    totals: { tournaments: tournaments.length, finished: palmares.length, matches: matchCount, participations: [...entities.values()].reduce((s, r) => s + r.tournaments, 0) },
    entities: [...entities.values()].map(finish).sort((a, b) => b.titles - a.titles || b.wins - a.wins || a.name.localeCompare(b.name)),
    players: [...players.values()].map(finish).sort((a, b) => b.titles - a.titles || b.wins - a.wins || a.name.localeCompare(b.name)),
    palmares: palmares.sort((a, b) => (b.date || 0) - (a.date || 0)),
  };
}
