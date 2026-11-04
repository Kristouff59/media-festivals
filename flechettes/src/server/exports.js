// Exports : CSV, JSON, PDF (rapport complet, feuilles de match).
import { toCsv } from '../engine/csv.js';
import { buildDerived } from '../engine/view.js';
import { GAMES } from '../engine/games/index.js';
import { Pdf } from './pdf.js';

const STATUS = {
  waiting: 'En attente des adversaires', ready: 'À jouer', called: 'Appelée', playing: 'En cours', suspended: 'Suspendue',
  awaiting_validation: 'À valider', finished: 'Terminée', cancelled: 'Annulée', postponed: 'Reportée',
};
const OUTCOME = { forfeit: 'Forfait', retired: 'Abandon', disqualified: 'Disqualification', bye: 'Exempt' };

const fmtDate = (t) => (t ? new Date(t).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' }) : '');

export function names(state) {
  return new Map(state.participants.map((p) => [p.id, p.name]));
}

export function legText(m, leg) {
  const d = leg.detail || {};
  if (m.rules.game === '501') return `${d.remainingA ?? '?'}/${d.remainingB ?? '?'} restants${d.endedBy === 'turnLimit' ? ' (limite)' : ''}${leg.decidedBy === 'tiebreak' ? ' + départage' : ''}`;
  return `${d.pointsA ?? '?'}-${d.pointsB ?? '?'} pts${d.endedBy === 'turnLimit' ? ' (limite)' : ''}${leg.decidedBy === 'tiebreak' ? ' + départage' : ''}`;
}

export function scoreText(m) {
  const r = m.result;
  if (!r) return '';
  if (r.outcome === 'bye') return 'Exempt';
  const base = `${r.legsA}-${r.legsB}`;
  return r.outcome !== 'normal' ? `${base} (${OUTCOME[r.outcome]})` : base;
}

function phaseName(state, id) {
  return state.config.phases.find((p) => p.id === id)?.name || id;
}
function targetName(state, id) {
  return state.targets.find((t) => t.id === id)?.name || '';
}

export function participantsCsv(state, { withContact = false } = {}) {
  const size = state.config.mode === 'team' ? state.config.teamSize : 0;
  const head = ['nom', ...Array.from({ length: size }, (_, i) => `joueur${i + 1}`), 'tete_de_serie', 'statut', 'source'];
  if (withContact) head.push('email', 'telephone');
  return toCsv([head, ...state.participants.map((p) => {
    const row = [p.name, ...(size ? p.players.map((x) => x.name) : []), p.seed ?? '', p.status, p.source];
    if (withContact) row.push(p.contact?.email || '', p.contact?.phone || '');
    return row;
  })]);
}

export function scheduleCsv(state, now = Date.now()) {
  const d = buildDerived(state, now);
  const n = names(state);
  const rows = state.matches
    .filter((m) => m.result?.outcome !== 'bye')
    .map((m) => {
      const f = d.forecast[m.id];
      return [m.seq, phaseName(state, m.phaseId), m.label, n.get(m.a) || 'à déterminer', n.get(m.b) || 'à déterminer', STATUS[m.status], targetName(state, m.targetId || f?.targetId), f ? fmtDate(f.estimatedStart) : '', fmtDate(m.startedAt)];
    });
  return toCsv([['ordre', 'phase', 'rencontre', 'camp_a', 'camp_b', 'statut', 'cible', 'debut_estime', 'debut_reel'], ...rows]);
}

export function resultsCsv(state) {
  const n = names(state);
  const rows = state.matches.filter((m) => m.status === 'finished' && m.result?.outcome !== 'bye').map((m) => [
    phaseName(state, m.phaseId), m.label, GAMES[m.rules.game].label, `BO${m.rules.bestOf}`, n.get(m.a), n.get(m.b), m.result.legsA, m.result.legsB,
    m.result.winner ? n.get(m[m.result.winner]) : 'Nul', OUTCOME[m.result.outcome] || 'Normal', m.result.legs.map((l) => legText(m, l)).join(' | '), targetName(state, m.targetId), fmtDate(m.endedAt), m.result.corrected ? 'oui' : '',
  ]);
  return toCsv([['phase', 'rencontre', 'jeu', 'format', 'camp_a', 'camp_b', 'manches_a', 'manches_b', 'vainqueur', 'issue', 'detail_manches', 'cible', 'fin', 'corrige'], ...rows]);
}

export function standingsCsv(state) {
  const d = buildDerived(state);
  const n = names(state);
  const rows = [];
  for (const ph of d.phases) for (const pool of ph.pools || []) for (const r of pool.rows) {
    rows.push([ph.name, pool.name, r.rank ?? '', n.get(r.participantId), r.played ?? '', r.wins ?? '', r.draws ?? '', r.losses ?? '', r.points ?? '', r.legsFor ?? '', r.legsAgainst ?? '', r.legDiff ?? '', r.pointsFor ?? '', r.pointsAgainst ?? '', r.pointDiff ?? '', r.tied ? 'égalité' : '', r.qualification]);
  }
  const fr = d.finalRanking || [];
  if (fr.length) {
    rows.push([]);
    rows.push(['Classement final', d.provisionalRanking ? '(provisoire)' : '']);
    for (const e of fr) rows.push(['', '', e.position ?? '-', e.name, e.tied ? 'ex aequo' : '', e.note]);
  }
  return toCsv([['phase', 'poule', 'rang', 'participant', 'joues', 'victoires', 'nuls', 'defaites', 'points', 'manches_pour', 'manches_contre', 'diff_manches', 'points_pour', 'points_contre', 'diff_points', 'egalite', 'qualification'], ...rows]);
}

export function bracketCsv(state) {
  const n = names(state);
  const rows = state.matches.filter((m) => m.kind === 'knockout').sort((a, b) => a.roundIndex - b.roundIndex || a.slot - b.slot).map((m) => [
    m.roundName, m.label, m.seedA ?? '', n.get(m.a) || (m.byeA ? 'Exempt' : 'à déterminer'), m.seedB ?? '', n.get(m.b) || (m.byeB ? 'Exempt' : 'à déterminer'), `BO${m.rules.bestOf}`, m.rules.turnLimit ?? '', scoreText(m), m.result?.winner ? n.get(m[m.result.winner]) : '', STATUS[m.status],
  ]);
  return toCsv([['tour', 'rencontre', 'tds_a', 'camp_a', 'tds_b', 'camp_b', 'format', 'limite_tours', 'score', 'vainqueur', 'statut'], ...rows]);
}

export function reportPdf(state) {
  const d = buildDerived(state);
  const n = names(state);
  const pdf = new Pdf();
  pdf.text(50, pdf.y, pdf.fit(state.name, pdf.W - 100, 18), { size: 18, bold: true });
  pdf.y -= 24;
  pdf.para(`Statut : ${{ draft: 'en préparation', ready: 'prêt', running: 'en cours', paused: 'interrompu', finished: 'terminé', archived: 'archivé' }[state.status]} — ${state.config.mode === 'team' ? `équipes de ${state.config.teamSize}` : 'individuel'} — édité le ${fmtDate(Date.now())}`);
  for (const p of state.config.phases) pdf.para(`${p.name} : ${GAMES[p.game].label}, Best of ${p.bestOf}${p.turnLimit ? `, ${p.turnLimit} tours max` : ''}${p.type === 'knockout' && Object.keys(p.roundOverrides || {}).length ? ` (${Object.entries(p.roundOverrides).map(([k, o]) => `${k === 'third' ? 'petite finale' : k === 'r2' ? 'finale' : k} : ${o.bestOf ? `BO${o.bestOf}` : ''}${o.turnLimit ? ` ${o.turnLimit} tours` : ''}`).join(', ')})` : ''}`);
  if (d.finalRanking?.length) {
    pdf.heading(d.provisionalRanking ? 'Classement (provisoire)' : 'Classement final');
    pdf.table([{ title: 'Rang', width: 90 }, { title: 'Participant', width: 280 }, { title: 'Remarque', width: 125 }], d.finalRanking.map((e) => [`${e.position ?? '-'}${e.tied ? ' (ex aequo)' : ''}`, e.name, e.note]));
  }
  for (const ph of d.phases) {
    if (ph.pools) {
      pdf.heading(ph.name);
      for (const pool of ph.pools) {
        pdf.para(pool.name, 11);
        pdf.table(
          [{ title: '#', width: 25 }, { title: 'Participant', width: 170 }, { title: 'J', width: 25 }, { title: 'V', width: 25 }, { title: 'N', width: 25 }, { title: 'D', width: 25 }, { title: 'Pts', width: 35 }, { title: 'Manches', width: 55 }, { title: 'Diff. pts', width: 50 }, { title: 'Statut', width: 60 }],
          pool.rows.map((r) => [r.rank ?? '-', `${n.get(r.participantId)}${r.tied ? ' (=)' : ''}`, r.played ?? '', r.wins ?? '', r.draws ?? '', r.losses ?? '', r.points ?? '', `${r.legsFor ?? 0}-${r.legsAgainst ?? 0}`, r.pointDiff ?? '', { qualified: 'Qualifié', eliminated: 'Éliminé', open: 'En jeu', excluded: 'Exclu' }[r.qualification] || '']),
        );
      }
    }
    if (ph.rounds) {
      pdf.heading(ph.name);
      for (const r of ph.rounds) {
        pdf.para(r.name, 11);
        pdf.table([{ title: 'Rencontre', width: 90 }, { title: 'Camp A', width: 150 }, { title: 'Camp B', width: 150 }, { title: 'Score', width: 105 }], r.matchIds.map((id) => {
          const m = state.matches.find((x) => x.id === id);
          return [m.label, n.get(m.a) || (m.byeA ? 'Exempt' : '?'), n.get(m.b) || (m.byeB ? 'Exempt' : '?'), scoreText(m) || STATUS[m.status]];
        }));
      }
      if (ph.thirdPlaceMatchId) {
        const m = state.matches.find((x) => x.id === ph.thirdPlaceMatchId);
        pdf.para(`Petite finale : ${n.get(m.a) || '?'} – ${n.get(m.b) || '?'} ${scoreText(m)}`);
      }
    }
  }
  pdf.heading('Résultats détaillés');
  pdf.table([{ title: 'Rencontre', width: 100 }, { title: 'Camp A', width: 110 }, { title: 'Camp B', width: 110 }, { title: 'Score', width: 55 }, { title: 'Manches', width: 120 }],
    state.matches.filter((m) => m.status === 'finished' && m.result?.outcome !== 'bye').map((m) => [m.label, n.get(m.a), n.get(m.b), scoreText(m), m.result.legs.map((l) => legText(m, l)).join(' | ')]), { size: 8 });
  pdf.heading('Participants');
  pdf.table([{ title: 'Nom', width: 180 }, { title: 'Joueurs', width: 240 }, { title: 'Statut', width: 75 }], state.participants.map((p) => [p.name, p.players.map((x) => x.name).join(', '), { registered: 'inscrit', confirmed: 'présent', absent: 'absent', withdrawn: 'désisté', disqualified: 'disqualifié' }[p.status]]));
  return pdf.toBuffer();
}

/** Feuilles de match imprimables : une par page, avec grille de saisie par manche. */
export function matchSheetsPdf(state, matchIds = null) {
  const n = names(state);
  const list = state.matches.filter((m) => (matchIds ? matchIds.includes(m.id) : !['finished', 'cancelled'].includes(m.status)) && m.result?.outcome !== 'bye');
  const pdf = new Pdf();
  if (!list.length) { pdf.para('Aucune rencontre à imprimer.'); return pdf.toBuffer(); }
  list.forEach((m, i) => {
    if (i) pdf.addPage();
    const g = GAMES[m.rules.game];
    pdf.text(50, pdf.y, `${state.name}`, { size: 11 });
    pdf.y -= 22;
    pdf.text(50, pdf.y, `Feuille de match — ${m.label}`, { size: 18, bold: true });
    pdf.y -= 22;
    pdf.para(`${phaseName(state, m.phaseId)} · ${g.label} · Best of ${m.rules.bestOf} (${Math.floor(m.rules.bestOf / 2) + 1} manche(s) gagnante(s)) · ${m.rules.turnLimit ? `${m.rules.turnLimit} tours maximum par manche` : 'sans limite de tours'}${m.rules.allowDraw ? ' · nul autorisé' : ' · nul interdit'}`);
    pdf.para(`Cible : ${targetName(state, m.targetId) || '________'}    Arbitre : ______________________`);
    pdf.y -= 8;
    const A = n.get(m.a) || 'à déterminer';
    const B = n.get(m.b) || 'à déterminer';
    const pa = state.participants.find((p) => p.id === m.a);
    const pb = state.participants.find((p) => p.id === m.b);
    pdf.text(50, pdf.y, `A : ${A}`, { size: 13, bold: true });
    pdf.text(310, pdf.y, `B : ${B}`, { size: 13, bold: true });
    pdf.y -= 16;
    if (state.config.mode === 'team') {
      pdf.text(50, pdf.y, pdf.fit(pa?.players.map((x) => x.name).join(', ') || '', 250, 9), { size: 9 });
      pdf.text(310, pdf.y, pdf.fit(pb?.players.map((x) => x.name).join(', ') || '', 250, 9), { size: 9 });
      pdf.y -= 18;
    }
    const legs = m.rules.bestOf;
    const label = m.rules.game === '501' ? 'Reste final' : 'Points';
    pdf.table([{ title: 'Manche', width: 60 }, { title: `${label} A`, width: 90 }, { title: `${label} B`, width: 90 }, { title: 'Tours', width: 50 }, { title: 'Fin (finition / fermeture / limite)', width: 120 }, { title: 'Vainqueur', width: 85 }],
      Array.from({ length: legs }, (_, k) => [String(k + 1), '', '', '', '', '']));
    if (m.rules.game !== '501') {
      pdf.para('Marques (/ = 1, X = 2, O = 3) :');
      const nums = ['20', '19', '18', '17', '16', '15', 'Bull'];
      const top = pdf.y;
      nums.forEach((num, k) => {
        const y = top - k * 22;
        pdf.rect(150, y - 6, 80, 18); pdf.text(262, y, num, { size: 11, bold: true }); pdf.rect(330, y - 6, 80, 18);
      });
      pdf.y = top - nums.length * 22 - 10;
      pdf.para(m.rules.game === 'cutthroat' ? 'Cut-Throat : les points sont des pénalités, le score le plus bas gagne.' : 'Cricket : les points marqués comptent pour le tireur, le score le plus haut gagne.');
    } else {
      pdf.para('Double-out obligatoire. À la limite de tours, le reste le plus faible remporte la manche ; égalité → départage.');
    }
    pdf.y -= 20;
    pdf.para('Score final (manches) :  A ______  —  B ______        Signatures :  A __________   B __________   Arbitre __________');
  });
  return pdf.toBuffer();
}

export function fullJson(state) {
  const s = structuredClone(state);
  delete s.recentCommands;
  return { format: 'flechettes-tournoi', exportedAt: new Date().toISOString(), tournament: s };
}
