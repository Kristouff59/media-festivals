// Fenêtre d'une rencontre : informations, actions selon le statut et le rôle,
// saisie des résultats (contrôlée en direct par le MÊME moteur que le serveur),
// compteur de score fléchette par fléchette.
import { h, clear, modal, toast, confirmDialog, promptDialog, fmtTime, fmtDate, select } from './ui.js';
import { evaluateResult, legsToWin } from '/engine/match.js';
import { GAMES } from '/engine/games/index.js';
import * as X01 from '/engine/games/x01.js';
import * as CRICKET from '/engine/games/cricket.js';
import * as CUTTHROAT from '/engine/games/cutthroat.js';
import { NUMBERS } from '/engine/games/cricketBoard.js';
import { MATCH_STATUS } from './tournament.js';

const ENGINES = { '501': X01, cricket: CRICKET, cutthroat: CUTTHROAT };
const OUTCOME = { normal: 'Normal', forfeit: 'Forfait', retired: 'Abandon', disqualified: 'Disqualification', bye: 'Exemption' };

export async function openMatch(ctx, matchId) {
  const { S, pn, tn, can, run, T } = ctx;
  const m = S().matches.find((x) => x.id === matchId);
  if (!m) return;
  const body = h('div', { class: 'col' });
  const dlgPromise = modal(`${m.label} — ${pn(m.a)} contre ${pn(m.b)}`, body, [], { wide: true });
  const dialog = body.closest('dialog');
  const close = () => dialog?.closeWith?.(null);
  const act = async (type, payload) => {
    try { await run(type, payload); close(); } catch { /* erreur affichée */ }
  };
  const phase = S().config.phases.find((p) => p.id === m.phaseId);
  const players = (id) => S().participants.find((p) => p.id === id)?.players.map((x) => x.name).join(', ');
  const team = S().config.mode === 'team';
  const freeTargets = ctx.D().targets.filter((t) => t.state === 'free');
  const r = m.rules;
  const add = (...items) => items.flat().forEach((x) => { if (x) body.append(x); });

  add(
    h('div', { class: 'row' }, h('span', { class: 'badge' }, MATCH_STATUS[m.status]), h('span', {}, phase?.name), m.roundName ? h('span', { class: 'muted' }, m.roundName) : null,
      h('span', { class: 'badge info' }, GAMES[r.game].label), h('span', { class: 'badge' }, `Best of ${r.bestOf} (${legsToWin(r.bestOf)} manche(s) gagnante(s))`),
      h('span', { class: 'badge' }, r.turnLimit ? `${r.turnLimit} tours max / manche` : 'sans limite de tours'), h('span', { class: 'badge' }, r.allowDraw ? 'nul autorisé' : 'nul interdit'),
      m.targetId ? h('span', { class: 'badge accent' }, tn(m.targetId)) : null),
    h('div', { class: 'grid' },
      h('div', { class: 'panel' }, h('div', { class: 'small muted' }, 'Camp A'), h('h3', {}, pn(m.a)), team && m.a ? h('div', { class: 'small' }, players(m.a)) : null),
      h('div', { class: 'panel' }, h('div', { class: 'small muted' }, 'Camp B'), h('h3', {}, pn(m.b)), team && m.b ? h('div', { class: 'small' }, players(m.b)) : null)),
    h('div', { class: 'small muted' }, [m.calledAt && `Appelée à ${fmtTime(m.calledAt)}`, m.startedAt && `début ${fmtTime(m.startedAt)}`, m.endedAt && `fin ${fmtTime(m.endedAt)}`].filter(Boolean).join(' · ')),
  );
  if (m.result) add(resultBlock(m, m.result, 'Résultat validé', pn));
  if (m.pendingResult) add(resultBlock(m, m.pendingResult, 'Résultat saisi — en attente de validation', pn));

  const actions = h('div', { class: 'row' });
  const btn = (label, fn, cls = '') => actions.append(h('button', { class: cls, onclick: fn }, label));
  const st = m.status;
  if (['ready', 'called', 'postponed'].includes(st) && m.a && m.b && can('match.assign') && freeTargets.length) {
    const sel = select([['', 'Affecter / changer de cible…'], ...freeTargets.map((t) => [t.id, t.name])], '');
    sel.onchange = () => sel.value && act('match.assign', { matchId: m.id, targetId: sel.value });
    actions.append(sel);
  }
  if (st === 'called' && can('match.start', { matchId: m.id })) btn('Démarrer la rencontre', () => act('match.start', { matchId: m.id }), 'primary');
  if (st === 'called' && can('match.unassign')) btn('Libérer la cible (retard)', async () => { const min = await promptDialog('Retard', 'Ne pas rappeler avant (minutes, 0 = immédiatement) :', '5', { type: 'number' }); if (min !== null) act('match.unassign', { matchId: m.id, postponeMinutes: Number(min) || 0 }); });
  if (st === 'playing' && can('match.suspend', { matchId: m.id })) {
    btn('Suspendre', async () => { const reason = await promptDialog('Suspendre', 'Motif :', ''); if (reason !== null) act('match.suspend', { matchId: m.id, reason }); });
    btn('Suspendre et libérer la cible', () => act('match.suspend', { matchId: m.id, releaseTarget: true }));
  }
  if (st === 'suspended' && can('match.resume', { matchId: m.id })) {
    if (m.targetId) btn('Reprendre', () => act('match.resume', { matchId: m.id }), 'primary');
    else if (freeTargets.length) {
      const sel = select([['', 'Reprendre sur la cible…'], ...freeTargets.map((t) => [t.id, t.name])], '');
      sel.onchange = () => sel.value && act('match.resume', { matchId: m.id, targetId: sel.value });
      actions.append(sel);
    } else actions.append(h('span', { class: 'small muted' }, 'Aucune cible libre pour reprendre.'));
  }
  if (st === 'awaiting_validation' && can('match.validateResult')) {
    btn('Valider le résultat', () => act('match.validateResult', { matchId: m.id, resultVersion: m.resultVersion }), 'ok');
    btn('Rejeter la saisie', async () => { const reason = await promptDialog('Rejeter', 'Motif :', ''); if (reason !== null) act('match.rejectResult', { matchId: m.id, reason }); }, 'danger');
  }
  if (st === 'finished' && m.result?.outcome !== 'bye') {
    if (can('match.correctResult')) btn('Corriger le résultat', () => { clear(formBox, resultForm(ctx, m, 'match.correctResult', close)); });
    if (can('match.annulResult')) btn('Annuler le résultat (à rejouer)', async () => { const reason = await promptDialog('Rencontre à rejouer', 'Motif :', ''); if (reason !== null) act('match.annulResult', { matchId: m.id, reason }); }, 'danger');
  }
  if (m.kind === 'pool' && !['cancelled', 'playing', 'suspended', 'awaiting_validation'].includes(st) && can('match.cancel')) btn('Annuler la rencontre (non comptée)', async () => { const reason = await promptDialog('Annuler la rencontre', 'La rencontre ne comptera pas au classement. Motif :', ''); if (reason !== null) act('match.cancel', { matchId: m.id, reason }); }, 'danger');
  if (st === 'cancelled' && can('match.restore')) btn('Rétablir la rencontre', () => act('match.restore', { matchId: m.id }));
  if (m.a && m.b && ['ready', 'called', 'playing', 'suspended'].includes(st) && can('match.submitResult', { matchId: m.id })) {
    btn('Saisir le résultat', () => { clear(formBox, resultForm(ctx, m, 'match.submitResult', close)); }, 'primary');
  }
  if (!T.token) actions.append(h('a', { class: 'btn small', href: `/api/tournaments/${T.id}/export/feuilles.pdf?matches=${encodeURIComponent(m.id)}`, target: '_blank' }, 'Feuille de match (PDF)'));
  add(actions);
  const formBox = h('div');
  add(formBox);
  if (['playing', 'called'].includes(st) && can('match.submitResult', { matchId: m.id })) clear(formBox, resultForm(ctx, m, 'match.submitResult', close));
  if (m.history?.length) add(h('details', {}, h('summary', { class: 'small' }, `Historique de la rencontre (${m.history.length})`), h('ul', { class: 'small' }, m.history.map((x) => h('li', {}, `${fmtDate(x.at)} — ${x.reason}${x.result ? ` (ancien : ${x.result.legsA}-${x.result.legsB})` : ''}`)))));
  return dlgPromise;
}

function resultBlock(m, res, title, pn) {
  return h('div', { class: 'panel' }, h('h3', {}, title),
    h('div', { class: 'row' }, h('b', { style: { fontSize: '1.3rem' } }, `${res.legsA} - ${res.legsB}`), h('span', {}, res.winner ? `Vainqueur : ${pn(m[res.winner])}` : 'Match nul'), res.outcome !== 'normal' ? h('span', { class: 'badge warn' }, OUTCOME[res.outcome]) : null, res.corrected ? h('span', { class: 'badge' }, 'corrigé') : null),
    res.legs?.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Manche', 'Fin', m.rules.game === '501' ? 'Restes A / B' : 'Points A / B', 'Tours', 'Vainqueur'].map((x) => h('th', {}, x)))),
      h('tbody', {}, res.legs.map((l, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, { checkout: 'Finition', closed: 'Fermeture', turnLimit: 'Limite de tours', tiebreak: 'Départage' }[l.decidedBy]),
        h('td', {}, m.rules.game === '501' ? `${l.detail.remainingA} / ${l.detail.remainingB}` : `${l.detail.pointsA} / ${l.detail.pointsB}${l.detail.closedA ? ' (A fermé)' : ''}${l.detail.closedB ? ' (B fermé)' : ''}`),
        h('td', {}, l.detail.turns ?? ''), h('td', {}, l.winner ? pn(m[l.winner]) : 'nul'))))) : null);
}

/** Formulaire de saisie (ou de correction) d'un résultat. */
function resultForm(ctx, m, type, close) {
  const { pn, run } = ctx;
  const r = m.rules;
  const is501 = r.game === '501';
  const legs = [];
  const source = type === 'match.correctResult' ? m.result : m.pendingResult;
  const outcome = select(Object.entries(OUTCOME).filter(([k]) => k !== 'bye').map(([k, v]) => [k, v]), source?.outcome || 'normal');
  const loser = select([['a', `${pn(m.a)} (A)`], ['b', `${pn(m.b)} (B)`]], source?.loser || 'a');
  const legsBox = h('div');
  const feedback = h('div');
  const reason = h('input', { placeholder: 'motif de la correction' });
  const sideSel = (v) => select([['', '—'], ['a', pn(m.a)], ['b', pn(m.b)]], v || '');
  const addLeg = (init = {}) => {
    const d = init;
    const f = {};
    if (is501) {
      f.endedBy = select([['checkout', 'Finition (double)'], ...(r.turnLimit ? [['turnLimit', `Limite de ${r.turnLimit} tours`]] : [])], d.endedBy || 'checkout');
      f.remainingA = h('input', { type: 'number', min: 0, max: r.gameOptions?.startScore || 501, class: 'num', value: d.remainingA ?? '' });
      f.remainingB = h('input', { type: 'number', min: 0, max: r.gameOptions?.startScore || 501, class: 'num', value: d.remainingB ?? '' });
    } else {
      f.endedBy = select([['closed', 'Fermeture (victoire)'], ...(r.turnLimit ? [['turnLimit', `Limite de ${r.turnLimit} tours`]] : [])], d.endedBy || 'closed');
      f.winner = sideSel(d.winner);
      f.pointsA = h('input', { type: 'number', min: 0, class: 'num', value: d.pointsA ?? 0 });
      f.pointsB = h('input', { type: 'number', min: 0, class: 'num', value: d.pointsB ?? 0 });
      f.closedA = h('input', { type: 'checkbox', checked: !!d.closedA });
      f.closedB = h('input', { type: 'checkbox', checked: !!d.closedB });
    }
    f.turns = h('input', { type: 'number', min: 1, class: 'num', value: d.turns ?? '' });
    f.tiebreakWinner = sideSel(d.tiebreakWinner);
    const el = h('div', { class: 'leg' });
    const leg = { f, el };
    const refresh = () => {
      clear(el, h('div', { class: 'row' }, h('b', {}, `Manche ${legs.indexOf(leg) + 1}`),
        h('label', { class: 'field' }, 'Fin', f.endedBy),
        is501 ? [h('label', { class: 'field' }, `Reste ${pn(m.a)}`, f.remainingA), h('label', { class: 'field' }, `Reste ${pn(m.b)}`, f.remainingB)]
          : [f.endedBy.value === 'closed' ? h('label', { class: 'field' }, 'Vainqueur', f.winner) : null,
            h('label', { class: 'field' }, `Points ${pn(m.a)}`, f.pointsA), h('label', { class: 'check small' }, f.closedA, 'A a tout fermé'),
            h('label', { class: 'field' }, `Points ${pn(m.b)}`, f.pointsB), h('label', { class: 'check small' }, f.closedB, 'B a tout fermé')],
        h('label', { class: 'field' }, 'Tours (facult.)', f.turns),
        f.endedBy.value === 'turnLimit' ? h('label', { class: 'field' }, 'Vainqueur du départage (si égalité)', f.tiebreakWinner) : null,
        h('button', { class: 'small ghost', title: 'Compteur fléchette par fléchette', onclick: () => liveScorer(m, ctx, (summary) => { fill(leg, summary); refresh(); update(); }) }, 'Compteur'),
        h('button', { class: 'small ghost danger', onclick: () => { legs.splice(legs.indexOf(leg), 1); el.remove(); legs.forEach((l) => l.refresh()); update(); } }, '✕')));
    };
    leg.refresh = refresh;
    Object.values(f).forEach((input) => input.addEventListener('input', () => { if (input === f.endedBy) refresh(); update(); }));
    Object.values(f).forEach((input) => input.addEventListener('change', () => { if (input === f.endedBy) refresh(); update(); }));
    legs.push(leg);
    refresh();
    legsBox.append(el);
    return leg;
  };
  const fill = (leg, s) => {
    for (const [k, v] of Object.entries(s)) {
      const input = leg.f[k];
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!v; else input.value = v ?? '';
    }
  };
  const readLeg = ({ f }) => {
    const num = (i) => (i.value === '' ? undefined : Number(i.value));
    const o = { endedBy: f.endedBy.value, turns: num(f.turns) ?? null, tiebreakWinner: f.tiebreakWinner.value || undefined };
    if (is501) Object.assign(o, { remainingA: num(f.remainingA), remainingB: num(f.remainingB) });
    else Object.assign(o, { winner: f.winner.value || undefined, pointsA: num(f.pointsA), pointsB: num(f.pointsB), closedA: f.closedA.checked, closedB: f.closedB.checked });
    return o;
  };
  const input = () => ({ outcome: outcome.value, loser: outcome.value === 'normal' ? undefined : loser.value, legs: legs.map(readLeg) });
  const update = () => {
    loser.parentElement.style.display = outcome.value === 'normal' ? 'none' : '';
    const ev = evaluateResult(r, input());
    clear(feedback, ev.ok
      ? h('div', { class: 'alert' }, `Résultat cohérent : ${ev.result.legsA}-${ev.result.legsB} — ${ev.result.winner ? `vainqueur ${pn(m[ev.result.winner])}` : 'match nul'}${ev.result.outcome !== 'normal' ? ` (${OUTCOME[ev.result.outcome]})` : ''}.`)
      : h('div', { class: 'alert warning' }, h('ul', {}, ev.errors.map((e) => h('li', {}, e)))));
    submit.disabled = !ev.ok;
  };
  const submit = h('button', { class: 'primary', onclick: async () => {
    const payload = { matchId: m.id, result: input(), resultVersion: m.resultVersion };
    if (type === 'match.correctResult') payload.reason = reason.value;
    try { await run(type, payload); close(); } catch { /* affiché */ }
  } }, type === 'match.correctResult' ? 'Enregistrer la correction' : 'Enregistrer le résultat');
  outcome.addEventListener('change', update);
  loser.addEventListener('change', update);
  if (source?.legs?.length) source.legs.forEach((l) => addLeg(l.detail));
  else addLeg();
  const box = h('div', { class: 'panel' }, h('h3', {}, type === 'match.correctResult' ? 'Correction du résultat' : 'Saisie du résultat'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Issue', outcome), h('label', { class: 'field' }, 'Camp perdant (forfait / abandon / disqualification)', loser)),
    h('p', { class: 'small muted' }, is501 ? 'Saisir le reste de chaque camp en fin de manche (0 pour le camp qui a fini sur un double).' : r.game === 'cutthroat' ? 'Cut-Throat : saisir les points de chaque camp (points reçus) ; le score le plus bas est le meilleur.' : 'Cricket : saisir les points de chaque camp ; le vainqueur par fermeture doit avoir tout fermé avec au moins autant de points.'),
    legsBox,
    h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => { addLeg(); update(); } }, '+ Manche')),
    type === 'match.correctResult' ? h('label', { class: 'field' }, 'Motif', reason) : null,
    feedback, h('div', { class: 'row' }, submit));
  setTimeout(update);
  return box;
}

/** Compteur en direct : applique les règles du jeu fléchette par fléchette. */
function liveScorer(m, ctx, onDone) {
  const { pn } = ctx;
  const r = m.rules;
  const eng = ENGINES[r.game];
  const darts = [];
  let mult = 1;
  let visitInput = h('input', { type: 'number', min: 0, max: 180, class: 'num' });
  const doubleChk = h('input', { type: 'checkbox' });
  const view = h('div', { class: 'scorer' });
  const rebuild = () => {
    const leg = eng.createLeg(r.gameOptions || {});
    for (const d of darts) {
      if (d.visit !== undefined) eng.applyVisit(leg, d.visit, { checkoutOnDouble: d.dbl });
      else if (d.endVisit) eng.endVisitEarly(leg);
      else eng.throwDart(leg, d);
    }
    return leg;
  };
  const doneBtn = h('button', { class: 'primary' }, 'Reporter dans la saisie');
  let leg = rebuild();
  const draw = () => {
    leg = rebuild();
    const limit = eng.isTurnLimitReached(leg, r.turnLimit);
    const ended = leg.finished || limit;
    doneBtn.disabled = !ended;
    const side = leg.current;
    const head = h('div', { class: 'row' }, h('b', {}, `Tour ${Math.min(leg.turn, r.turnLimit || Infinity)}${r.turnLimit ? ` / ${r.turnLimit}` : ''}`),
      ended ? h('span', { class: 'badge ok' }, leg.finished ? `Manche gagnée par ${pn(m[leg.winner === 0 ? 'a' : 'b'])}` : 'Limite de tours atteinte') : h('span', { class: 'badge accent' }, `Au tour de ${pn(m[side === 0 ? 'a' : 'b'])}`));
    let board;
    if (r.game === '501') {
      board = h('div', { class: 'grid' }, [0, 1].map((s) => h('div', { class: 'panel' }, h('div', { class: 'small muted' }, pn(m[s === 0 ? 'a' : 'b'])), h('div', { style: { fontSize: '2rem', fontWeight: 700 } }, leg.remaining[s]),
        h('div', { class: 'small muted' }, leg.visits[s].slice(-6).map((v) => (v.bust ? 'bust' : v.scored)).join(' · ')))));
    } else {
      const mk = (n) => (n >= 3 ? 'Ⓧ' : n === 2 ? 'X' : n === 1 ? '/' : '·');
      board = h('table', { class: 'marks' }, h('thead', {}, h('tr', {}, h('th', {}, pn(m.a)), h('th', {}, ''), h('th', {}, pn(m.b)))),
        h('tbody', {}, NUMBERS.map((n) => h('tr', {}, h('td', {}, mk(leg.marks[0][n])), h('td', {}, n === 25 ? 'Bull' : n), h('td', {}, mk(leg.marks[1][n])))),
          h('tr', {}, h('td', {}, h('b', {}, leg.points[0])), h('td', {}, r.game === 'cutthroat' ? 'Points (bas = mieux)' : 'Points'), h('td', {}, h('b', {}, leg.points[1])))));
    }
    let pad;
    if (r.game === '501') {
      visitInput = h('input', { type: 'number', min: 0, max: 180, class: 'num', disabled: ended });
      pad = h('div', { class: 'row' }, h('label', { class: 'field' }, 'Total de la volée', visitInput), h('label', { class: 'check' }, doubleChk, 'dernière fléchette sur un double (finition)'),
        h('button', { class: 'primary', disabled: ended, onclick: () => {
          const v = Number(visitInput.value);
          try { const t = eng.createLeg(r.gameOptions || {}); void t; darts.push({ visit: v, dbl: doubleChk.checked }); rebuild(); } catch (e) { darts.pop(); toast(e.message, { error: true }); }
          doubleChk.checked = false; draw();
        } }, 'Valider la volée'));
    } else {
      const multBtns = [1, 2, 3].map((k) => h('button', { class: mult === k ? 'primary' : '', onclick: () => { mult = k; draw(); } }, ['Simple', 'Double', 'Triple'][k - 1]));
      pad = h('div', { class: 'col' }, h('div', { class: 'row' }, multBtns, h('span', { class: 'small muted' }, `Fléchette ${leg.dartsInVisit + 1}/3`)),
        h('div', { class: 'pad' }, [...NUMBERS, 0].map((n) => h('button', { disabled: ended || (n === 25 && mult === 3), onclick: () => { darts.push({ segment: n, multiplier: n === 0 ? 1 : mult }); mult = 1; draw(); } }, n === 25 ? 'Bull' : n === 0 ? 'Hors cible' : n)),
          h('button', { disabled: ended, onclick: () => { darts.push({ endVisit: true }); draw(); } }, 'Fin de volée')));
    }
    clear(view, head, board, pad, h('div', { class: 'row' }, h('button', { class: 'small', disabled: !darts.length, onclick: () => { darts.pop(); draw(); } }, 'Annuler la dernière saisie')));
  };
  doneBtn.onclick = () => {
    const s = eng.legToSummary(leg, r.turnLimit);
    if (r.game === '501' && leg.finished) s.endedBy = 'checkout';
    onDone(s);
    view.closest('dialog')?.closeWith?.(null);
  };
  draw();
  modal(`Compteur — ${GAMES[r.game].label}${r.turnLimit ? ` (${r.turnLimit} tours max)` : ''}`, h('div', { class: 'col' }, view, h('div', { class: 'row' }, doneBtn)), []);
}

void confirmDialog;
