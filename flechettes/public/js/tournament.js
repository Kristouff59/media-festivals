// Page d'un tournoi (organisateurs, arbitres, spectateurs).
import { h, clear, toast, modal, confirmDialog, promptDialog, fmtTime, fmtDate, select } from './ui.js';
import { api, command, ApiError } from './api.js';
import { atLeast, requiredRole, ROLE_LABELS, canExecute } from '/engine/permissions.js';
import { GAMES } from '/engine/games/index.js';
import { participantsFromCsv } from '/engine/csv.js';
import { openMatch } from './match.js';
import { renderConfigEditor } from './config-editor.js';
import { qrSvg } from './qr.js';

const STATUS_LABEL = { draft: 'En préparation', ready: 'Prêt à lancer', running: 'En cours', paused: 'Interrompu', finished: 'Terminé', archived: 'Archivé' };
export const MATCH_STATUS = { waiting: 'Adversaires inconnus', ready: 'À jouer', called: 'Appelée', playing: 'En cours', suspended: 'Suspendue', awaiting_validation: 'À valider', finished: 'Terminée', cancelled: 'Annulée', postponed: 'Reportée' };
const MATCH_BADGE = { ready: '', called: 'info', playing: 'accent', suspended: 'warn', awaiting_validation: 'warn', finished: 'ok', cancelled: 'err', postponed: 'warn', waiting: '' };
const P_STATUS = { registered: ['Inscrit', ''], confirmed: ['Présent', 'ok'], absent: ['Absent', 'warn'], withdrawn: ['Désisté', 'err'], disqualified: ['Disqualifié', 'err'] };
const QUALIF = { qualified: ['Qualifié', 'ok'], eliminated: ['Éliminé', 'err'], open: ['En jeu', ''], excluded: ['Exclu', 'err'] };

let T = null;

export function stopTournament() {
  if (T?.es) T.es.close();
  if (T?.poll) clearInterval(T.poll);
  T = null;
  const c = document.getElementById('conn');
  if (c) clear(c);
}

export async function renderTournament(container, { id, token, tab, user }) {
  T = { id, token, tab, user, container, view: null, es: null, version: -1, member: null };
  await load();
  connect();
}

async function load() {
  if (!T) return;
  try {
    const v = T.token ? await api('GET', `/api/public/${T.token}`) : await api('GET', `/api/tournaments/${T.id}`);
    if (!T) return;
    T.view = v;
    T.id = v.tournament.id;
    T.version = v.tournament.version;
    const me = v.tournament.members.find((m) => m.userId === T.user?.id);
    T.member = me || { role: v.role };
    T.member.role = v.role;
    render();
  } catch (e) {
    clear(T.container, h('div', { class: 'alert error' }, e.message));
  }
}

function connect() {
  const url = T.token ? `/api/public/${T.token}/stream` : `/api/tournaments/${T.id}/stream`;
  const conn = document.getElementById('conn');
  const set = (ok, text) => clear(conn, h('span', { class: `conn${ok ? '' : ' off'}`, title: 'Mises à jour en temps réel' }, text));
  const es = new EventSource(url);
  T.es = es;
  let timer = null;
  es.addEventListener('hello', (e) => {
    set(true, '● En direct');
    const v = JSON.parse(e.data).version;
    if (T && v !== T.version) load(); // reconnexion : rattrapage des changements manqués
  });
  es.addEventListener('update', (e) => {
    const d = JSON.parse(e.data);
    if (d.deleted) { toast('Ce tournoi a été supprimé ou réinitialisé.'); location.hash = d.replacedBy ? `#/t/${d.replacedBy}` : '#/'; return; }
    if (d.version === T?.version) return;
    clearTimeout(timer);
    timer = setTimeout(load, 120);
  });
  es.onerror = () => set(false, '○ Reconnexion…');
  // Filet de sécurité si le flux est coupé par un proxy.
  T.poll = setInterval(() => { if (es.readyState !== 1) load(); }, 30000);
}

// ---------------------------------------------------------------- helpers
const S = () => T.view.tournament;
const D = () => T.view.derived;
export const pn = (id) => S().participants.find((p) => p.id === id)?.name || (id ? '?' : 'à déterminer');
const tn = (id) => S().targets.find((t) => t.id === id)?.name || '';
const mById = (id) => S().matches.find((m) => m.id === id);
const can = (type, payload = {}) => !T.token && canExecute(T.member, { type, payload }, S()).ok && S().status !== 'archived';
const canRole = (min) => !T.token && atLeast(T.member.role, min);
export function ctxForMatch() { return { T, run, pn, tn, can, S, D, reload: load }; }

/** Exécute une commande métier avec gestion des décisions, conflits et erreurs. */
export async function run(type, payload = {}, { expectVersion = false, quiet = false } = {}) {
  try {
    const r = await command(T.id, type, payload, expectVersion ? { expectedVersion: T.version } : {});
    if (!quiet) toast(r.summary, { details: r.events?.length ? r.events : null });
    await load();
    return r;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'DECISION_REQUIRED') {
      const labels = { keepNextPhase: 'Conserver la phase suivante telle quelle', regenerateNextPhase: 'Régénérer la phase suivante', resetDependents: 'Réinitialiser les rencontres dépendantes' };
      const choice = await modal('Décision requise', h('div', {}, h('p', {}, e.message), e.details?.playedMatches?.length ? h('div', {}, h('b', {}, 'Rencontres concernées :'), h('ul', {}, e.details.playedMatches.map((x) => h('li', {}, x)))) : null),
        [{ label: 'Annuler la correction', value: null }, ...e.details.options.map((o) => ({ label: labels[o] || o, value: o, class: o.startsWith('keep') ? '' : 'danger' }))]);
      if (choice) return run(type, { ...payload, decision: choice });
      return null;
    }
    if (e.status === 409) { toast(e.message, { error: true }); await load(); return null; }
    toast(e.message, { error: true, details: e.details });
    throw e;
  }
}
async function runSafe(...args) {
  try { return await run(...args); } catch { return null; }
}

// ---------------------------------------------------------------- rendu
const TABS = [
  ['apercu', 'Aperçu'], ['participants', 'Participants'], ['poules', 'Poules'], ['planning', 'Cibles & calendrier'], ['matchs', 'Rencontres'],
  ['classements', 'Classements'], ['tableau', 'Tableau final'], ['final', 'Classement final'], ['partage', 'Partage & exports'],
  ['config', 'Configuration'], ['membres', 'Membres'], ['journal', 'Historique'],
];

function render() {
  const s = S();
  const hasPools = s.config.phases.some((p) => p.type === 'pools');
  const hasKo = s.config.phases.some((p) => p.type === 'knockout');
  const visible = TABS.filter(([k]) => {
    if (k === 'poules' || k === 'classements') return hasPools;
    if (k === 'tableau') return hasKo;
    if (k === 'membres') return canRole('admin');
    if (k === 'journal') return canRole('organizer');
    if (k === 'config') return canRole('referee');
    return true;
  });
  if (!visible.some(([k]) => k === T.tab)) T.tab = 'apercu';
  const base = T.token ? `#/p/${T.token}` : `#/t/${T.id}`;
  const scrollY = window.scrollY;
  clear(T.container,
    h('div', { class: 'row' }, h('h1', {}, s.name), h('span', { class: `badge ${s.status === 'running' ? 'accent' : s.status === 'finished' ? 'ok' : ''}` }, STATUS_LABEL[s.status]),
      s.demo ? h('span', { class: 'badge warn' }, 'DÉMONSTRATION') : null, T.token ? h('span', { class: 'badge info' }, 'Accès spectateur (lecture seule)') : h('span', { class: 'badge' }, ROLE_LABELS[T.member.role])),
    h('nav', { class: 'tabs no-print' }, visible.map(([k, label]) => h('a', { href: `${base}/${k}`, class: k === T.tab ? 'active' : '' }, label))),
    h('div', {}, renderTab()),
  );
  window.scrollTo(0, scrollY);
}

function renderTab() {
  try {
    switch (T.tab) {
      case 'participants': return tabParticipants();
      case 'poules': return tabPools();
      case 'planning': return tabPlanning();
      case 'matchs': return tabMatches();
      case 'classements': return tabStandings();
      case 'tableau': return tabBracket();
      case 'final': return tabFinal();
      case 'partage': return tabShare();
      case 'config': return renderConfigEditor({ T, run, S, D, editable: can('config.update') });
      case 'membres': return tabMembers();
      case 'journal': return tabJournal();
      default: return tabOverview();
    }
  } catch (e) {
    console.error(e);
    return h('div', { class: 'alert error' }, `Erreur d'affichage : ${e.message}`);
  }
}

// ---------------------------------------------------------------- aperçu
function tabOverview() {
  const s = S();
  const d = D();
  const ph0 = s.phases[0];
  const cfg0 = s.config.phases[0];
  const confirmed = s.participants.filter((p) => p.status === 'confirmed').length;
  const steps = [
    ['Inscriptions', !s.registrationOpen],
    [cfg0.type === 'pools' ? 'Tirage des poules' : 'Tirage du tableau', ph0.status !== 'pending'],
    [cfg0.type === 'pools' ? 'Validation des poules' : 'Tableau généré', ph0.status === 'active' || ph0.status === 'completed'],
    ['Lancement', ['running', 'paused', 'finished', 'archived'].includes(s.status)],
    ...s.config.phases.map((p, i) => [p.name, s.phases[i].status === 'completed']),
    ['Archivage', s.status === 'archived'],
  ];
  const curIdx = steps.findIndex(([, done]) => !done);
  const actions = [];
  const add = (type, label, payload = {}, opts = {}) => { if (can(type, payload)) actions.push(h('button', { class: opts.class || '', onclick: async () => { if (opts.confirm && !(await confirmDialog(label, opts.confirm, { danger: opts.danger }))) return; runSafe(type, payload, opts); } }, label)); };
  if (s.registrationOpen) add('registration.close', 'Clore les inscriptions', {}, { class: 'primary' });
  else if (['draft', 'ready'].includes(s.status) && ph0.status !== 'active') add('registration.open', 'Rouvrir les inscriptions');
  if (!s.registrationOpen && ph0.status === 'pending') {
    if (cfg0.type === 'pools') add('pools.draw', 'Tirer au sort les poules', {}, { class: 'primary' });
    else add('phase.generateKnockout', 'Tirer au sort le tableau', {}, { class: 'primary' });
  }
  if (ph0.status === 'draft') { actions.push(h('a', { class: 'btn', href: `#/t/${T.id}/poules` }, 'Ajuster les poules')); add('pools.validate', 'Valider les poules et générer les rencontres', {}, { class: 'primary' }); }
  if (['draft', 'ready'].includes(s.status) && ph0.status === 'active') add('tournament.start', 'Lancer le tournoi', {}, { class: 'primary', confirm: 'Les participants seront verrouillés et les rencontres appelées sur les cibles.' });
  if (s.status === 'running') add('tournament.pause', 'Interrompre le tournoi', { suspendPlaying: true }, { confirm: 'Les rencontres en cours seront suspendues ; aucune nouvelle rencontre ne sera appelée.' });
  if (s.status === 'paused') add('tournament.resume', 'Reprendre le tournoi', {}, { class: 'primary' });
  if (['running', 'paused'].includes(s.status)) add('tournament.finish', 'Clôturer le tournoi', { force: s.phases.some((p) => p.status !== 'completed') }, { danger: true, confirm: s.phases.some((p) => p.status !== 'completed') ? 'Des rencontres restent à jouer : elles seront annulées et le classement établi en l\'état. Confirmer la clôture anticipée ?' : 'Clôturer le tournoi ?' });
  if (s.status === 'finished') add('tournament.archive', 'Archiver le tournoi', {}, { class: 'primary' });
  if (s.status === 'archived' && canRole('admin')) actions.push(h('button', { onclick: () => runSafe('tournament.unarchive') }, 'Réouvrir l\'archive'));
  if (canRole('referee') && s.status === 'running') add('schedule.dispatch', 'Recalculer l\'affectation des cibles');

  const winner = d.finalRanking?.find((e) => e.position === 1);
  const live = s.matches.filter((m) => ['playing', 'called', 'suspended', 'awaiting_validation'].includes(m.status));
  return h('div', {},
    s.status === 'finished' || s.status === 'archived' ? h('div', { class: 'panel' }, h('div', { class: 'big-winner' }, winner ? `🏆 Vainqueur : ${winner.name}` : 'Tournoi terminé'), s.incomplete ? h('p', { class: 'muted' }, 'Clôture anticipée.') : null) : null,
    h('section', { class: 'panel' },
      h('div', { class: 'steps' }, steps.map(([l, done], i) => h('span', { class: done ? 'done' : i === curIdx ? 'cur' : '' }, l))),
      h('div', { class: 'row' }, actions.length ? actions : h('span', { class: 'muted small' }, T.token ? '' : 'Aucune action disponible pour votre rôle à cette étape.')),
      d.configCheck.errors.length && ['draft', 'ready'].includes(s.status) ? h('div', { class: 'alert error' }, 'Configuration à corriger avant le lancement :', h('ul', {}, d.configCheck.errors.map((e) => h('li', {}, e)))) : null,
      d.configCheck.warnings.length && ['draft', 'ready'].includes(s.status) ? h('div', { class: 'alert warning' }, h('ul', {}, d.configCheck.warnings.map((e) => h('li', {}, e)))) : null,
      d.alerts.map((a) => h('div', { class: `alert ${a.level}` }, a.text, a.matchId ? h('button', { class: 'small', style: { marginLeft: '8px' }, onclick: () => openMatch(ctxForMatch(), a.matchId) }, 'Ouvrir') : null, a.type === 'tie' && can('phase.resolveTie') ? h('a', { class: 'btn small', style: { marginLeft: '8px' }, href: `#/t/${T.id}/classements` }, 'Départager') : null)),
    ),
    s.demo && can('participant.add') || (s.demo && canRole('organizer')) ? demoPanel() : null,
    h('div', { class: 'grid' },
      h('div', { class: 'panel kpi' }, h('b', {}, s.participants.length), `inscrits · ${confirmed} présents`),
      h('div', { class: 'panel kpi' }, h('b', {}, s.matches.filter((m) => m.status === 'finished' && m.result?.outcome !== 'bye').length), `rencontres terminées sur ${s.matches.filter((m) => m.result?.outcome !== 'bye' && m.status !== 'cancelled').length}`),
      h('div', { class: 'panel kpi' }, h('b', {}, live.length), 'rencontres en cours / appelées'),
      h('div', { class: 'panel kpi' }, h('b', {}, `${d.targets.filter((t) => t.state === 'free').length}/${s.targets.length}`), 'cibles libres'),
    ),
    live.length ? h('section', { class: 'panel' }, h('h2', {}, 'En ce moment'), live.map(matchLine)) : null,
    d.upcoming.length ? h('section', { class: 'panel' }, h('h2', {}, 'Prochaines rencontres'), d.upcoming.slice(0, 8).map((id) => matchLine(mById(id)))) : null,
  );
}

function demoPanel() {
  const sim = (scope) => async () => {
    try {
      const r = await api('POST', `/api/tournaments/${T.id}/demo/simulate`, { scope });
      toast(`${r.played} rencontre(s) simulée(s).`);
      load();
    } catch (e) { toast(e.message, { error: true, details: e.details }); }
  };
  return h('section', { class: 'panel' }, h('h2', {}, 'Simulation (démonstration)'),
    h('p', { class: 'small muted' }, 'Les rencontres sont jouées fléchette par fléchette par un bot via les vrais moteurs de jeu ; les résultats passent par la même validation et les mêmes commandes qu\'un tournoi réel (tirages, validations, départages par tirage au sort si nécessaire).'),
    h('div', { class: 'row' },
      h('button', { onclick: sim('next') }, 'Simuler une rencontre'),
      h('button', { onclick: sim('ready') }, 'Simuler les rencontres appelées'),
      h('button', { onclick: sim('phase') }, 'Simuler jusqu\'à la fin de la phase'),
      h('button', { class: 'primary', onclick: sim('all') }, 'Simuler tout le tournoi'),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDialog('Réinitialiser la démonstration', 'Le tournoi fictif sera recréé à zéro avec de nouveaux participants fictifs.', { danger: true }))) return;
        const r = await api('POST', `/api/tournaments/${T.id}/demo/reset`, {});
        location.hash = `#/t/${r.id}`;
      } }, 'Réinitialiser')));
}

export function matchLine(m) {
  if (!m) return null;
  const est = D().forecast[m.id];
  return h('div', { class: 'match-line' },
    h('span', { class: `badge ${MATCH_BADGE[m.status] || ''}` }, MATCH_STATUS[m.status]),
    h('span', { class: 'small muted' }, m.label),
    h('span', { class: 'vs' }, `${pn(m.a)} – ${pn(m.b)}`),
    m.result ? h('b', {}, m.result.outcome === 'bye' ? 'exempt' : `${m.result.legsA}-${m.result.legsB}${m.result.outcome !== 'normal' ? ` (${{ forfeit: 'forfait', retired: 'abandon', disqualified: 'disq.' }[m.result.outcome]})` : ''}`) : null,
    m.targetId ? h('span', { class: 'badge info' }, tn(m.targetId)) : est && !['finished', 'cancelled'].includes(m.status) ? h('span', { class: 'small muted' }, `≈ ${fmtTime(est.estimatedStart)} · ${tn(est.targetId)}`) : null,
    h('span', { class: 'small muted' }, `${GAMES[m.rules.game].label} · BO${m.rules.bestOf}${m.rules.turnLimit ? ` · ${m.rules.turnLimit} t.` : ''}`),
    h('button', { class: 'small right', onclick: () => openMatch(ctxForMatch(), m.id) }, T.token ? 'Détails' : 'Ouvrir'),
  );
}

// ---------------------------------------------------------------- participants
function tabParticipants() {
  const s = S();
  const team = s.config.mode === 'team';
  const editable = can('participant.update');
  const rows = s.participants.map((p, i) => h('tr', {},
    h('td', { class: 'num small muted' }, i + 1),
    h('td', {}, h('b', {}, p.name), p.seed ? h('span', { class: 'seed' }, ` TdS ${p.seed}`) : null, p.source === 'public' ? h('span', { class: 'badge info', style: { marginLeft: '6px' } }, 'en ligne') : null),
    team ? h('td', {}, p.players.map((pl) => pl.name).join(', ')) : null,
    h('td', {}, h('span', { class: `badge ${P_STATUS[p.status][1]}` }, P_STATUS[p.status][0])),
    editable && p.contact ? h('td', { class: 'small muted' }, [p.contact.email, p.contact.phone].filter(Boolean).join(' · ')) : null,
    h('td', {}, h('div', { class: 'row' }, participantActions(p))),
  ));
  return h('div', {},
    can('participant.add') ? addParticipantPanel() : null,
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h2', {}, `Participants (${s.participants.length}${s.config.maxParticipants ? ` / ${s.config.maxParticipants}` : ''})`),
        h('span', { class: 'badge' }, s.registrationOpen ? 'Inscriptions ouvertes' : 'Inscriptions closes'),
        can('participant.setPresence', { id: '__all' }) && s.participants.some((p) => p.status === 'registered') ? h('button', { class: 'small right', onclick: async () => {
          for (const p of S().participants.filter((x) => x.status === 'registered')) await runSafe('participant.setPresence', { id: p.id, presence: 'confirmed' }, { quiet: true });
          toast('Présences confirmées.');
        } }, 'Tout confirmer présent') : null),
      s.participants.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, team ? 'Équipe' : 'Joueur'), team ? h('th', {}, 'Joueurs') : null, h('th', {}, 'Statut'), editable ? h('th', {}, 'Contact') : null, h('th', {}, ''))), h('tbody', {}, rows))) : h('p', { class: 'empty' }, 'Aucun inscrit.')),
  );
}

function participantActions(p) {
  const out = [];
  const inMatches = S().matches.some((m) => m.a === p.id || m.b === p.id);
  const out_ = ['withdrawn', 'disqualified'].includes(p.status);
  if (!out_ && can('participant.setPresence', { id: p.id, presence: 'confirmed' })) {
    if (p.status !== 'confirmed') out.push(h('button', { class: 'small ok', onclick: () => runSafe('participant.setPresence', { id: p.id, presence: 'confirmed' }, { quiet: true }) }, 'Présent'));
    if (p.status !== 'absent' && !inMatches) out.push(h('button', { class: 'small', onclick: () => runSafe('participant.setPresence', { id: p.id, presence: 'absent' }, { quiet: true }) }, 'Absent'));
  }
  if (can('participant.update')) out.push(h('button', { class: 'small', onclick: () => editParticipant(p) }, 'Modifier'));
  if (can('participant.replacePlayer') && S().config.allowReplacement && !out_) out.push(h('button', { class: 'small', onclick: () => replacePlayer(p) }, 'Remplacer'));
  if (!out_ && can('participant.withdraw') && (inMatches || ['running', 'paused'].includes(S().status))) {
    out.push(h('button', { class: 'small danger', onclick: () => withdraw(p, 'participant.withdraw') }, 'Désistement / forfait'));
    out.push(h('button', { class: 'small danger', onclick: () => withdraw(p, 'participant.disqualify') }, 'Disqualifier'));
  }
  if (!inMatches && can('participant.remove')) out.push(h('button', { class: 'small danger', onclick: async () => { if (await confirmDialog('Supprimer l\'inscription', `Supprimer ${p.name} ?`, { danger: true })) runSafe('participant.remove', { id: p.id }); } }, 'Supprimer'));
  if (can('participant.anonymize') && !p.anonymized) out.push(h('button', { class: 'small ghost', title: 'Droit à l\'effacement', onclick: async () => { if (await confirmDialog('Anonymiser', `Remplacer définitivement les noms et coordonnées de ${p.name} par des valeurs anonymes (résultats conservés) ?`, { danger: true })) runSafe('participant.anonymize', { id: p.id }); } }, 'Anonymiser'));
  return out;
}

function addParticipantPanel() {
  const s = S();
  const team = s.config.mode === 'team';
  const name = h('input', { placeholder: team ? 'Nom de l\'équipe' : 'Nom du joueur', required: true });
  const players = team ? Array.from({ length: s.config.teamSize }, (_, i) => h('input', { placeholder: `Joueur ${i + 1}`, required: true })) : [];
  const seed = h('input', { type: 'number', min: 1, class: 'num', placeholder: 'TdS' });
  const email = h('input', { type: 'email', placeholder: 'e-mail (facultatif)' });
  const present = h('input', { type: 'checkbox', checked: true });
  const csv = h('textarea', { placeholder: team ? `nom;joueur1;joueur2\nLes Triples;Alice Martin;Bob Durand` : 'nom\nAlice Martin' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', onchange: async () => { csv.value = await file.files[0].text(); } });
  return h('section', { class: 'panel' }, h('h2', {}, 'Inscrire'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const payload = { name: name.value, players: players.map((p) => p.value), seed: seed.value ? Number(seed.value) : null, contact: { email: email.value }, status: present.checked ? 'confirmed' : 'registered' };
      try {
        await run('participant.add', payload, { quiet: true });
        toast(`${payload.name} inscrit(e).`);
        e.target.reset(); present.checked = true; name.focus();
      } catch (err) {
        if (err.code === 'DUPLICATE' && (await confirmDialog('Doublon possible', h('div', {}, h('ul', {}, [].concat(err.details).map((d) => h('li', {}, d))), h('p', {}, 'Inscrire quand même ?')), { ok: 'Inscrire quand même' }))) {
          await runSafe('participant.add', { ...payload, allowDuplicate: true });
          e.target.reset();
        }
      }
    } }, name, players, seed, email, h('label', { class: 'check small' }, present, 'présence confirmée'), h('button', { class: 'primary', type: 'submit' }, 'Inscrire')),
    h('details', {}, h('summary', {}, 'Importer une liste (CSV)'),
      h('p', { class: 'small muted' }, `Colonnes reconnues : nom${team ? `, joueur1 … joueur${s.config.teamSize} (ou « joueurs » séparés par /)` : ''}, tete_de_serie, email, telephone. Séparateur « ; » ou « , ». Les doublons sont rejetés et signalés.`),
      file, csv, h('button', { onclick: async () => {
        const rows = participantsFromCsv(csv.value, { mode: s.config.mode, teamSize: s.config.teamSize });
        if (!rows.length) return toast('Aucune ligne lisible.', { error: true });
        try {
          const r = await run('participant.import', { rows }, { quiet: true });
          toast(r.summary, { details: r.result.rejected?.map((x) => `Ligne ${x.line} (${x.name}) : ${x.reason}`), error: r.result.rejected?.length > 0 });
          if (!r.result.rejected?.length) csv.value = '';
        } catch { /* message affiché */ }
      } }, 'Importer')));
}

async function editParticipant(p) {
  const s = S();
  const team = s.config.mode === 'team';
  const name = h('input', { value: p.name });
  const locked = ['running', 'paused', 'finished'].includes(s.status);
  const players = team ? p.players.map((pl) => h('input', { value: pl.name, disabled: locked })) : [];
  const seed = h('input', { type: 'number', min: 1, value: p.seed ?? '', class: 'num' });
  const email = h('input', { type: 'email', value: p.contact?.email || '' });
  const phone = h('input', { type: 'tel', value: p.contact?.phone || '' });
  const ok = await modal(`Modifier ${p.name}`, h('div', { class: 'col' }, h('label', { class: 'field' }, 'Nom', name), team ? h('div', { class: 'col' }, players.map((x, i) => h('label', { class: 'field' }, `Joueur ${i + 1}`, x)), locked ? h('span', { class: 'small muted' }, 'Tournoi lancé : utiliser « Remplacer » pour changer un joueur.') : null) : null,
    h('label', { class: 'field' }, 'Tête de série', seed), h('label', { class: 'field' }, 'E-mail', email), h('label', { class: 'field' }, 'Téléphone', phone),
    p.history?.length ? h('div', { class: 'small muted' }, 'Historique : ', p.history.map((x) => `${fmtDate(x.at)} ${x.from} → ${x.to}`).join(' ; ')) : null),
  [{ label: 'Annuler', value: false }, { label: 'Enregistrer', class: 'primary', value: true }]);
  if (!ok) return;
  const payload = { id: p.id, name: name.value, contact: { email: email.value, phone: phone.value } };
  if (team && !locked) payload.players = players.map((x) => x.value);
  if (String(p.seed ?? '') !== seed.value) payload.seed = seed.value ? Number(seed.value) : null;
  runSafe('participant.update', payload);
}

async function replacePlayer(p) {
  const pl = select(p.players.map((x) => [x.id, x.name]), p.players[0].id);
  const name = h('input', {});
  const reason = h('input', { placeholder: 'motif (blessure, absence…)' });
  const ok = await modal(`Remplacement — ${p.name}`, h('div', { class: 'col' }, h('label', { class: 'field' }, 'Joueur remplacé', pl), h('label', { class: 'field' }, 'Remplaçant', name), h('label', { class: 'field' }, 'Motif', reason), h('p', { class: 'small muted' }, 'Les résultats déjà acquis restent attribués à l\'équipe ; le remplacement est historisé.')), [{ label: 'Annuler', value: false }, { label: 'Remplacer', class: 'primary', value: true }]);
  if (ok) runSafe('participant.replacePlayer', { id: p.id, playerId: pl.value, name: name.value, reason: reason.value });
}

async function withdraw(p, type) {
  const s = S();
  const def = type === 'participant.withdraw' ? s.config.withdrawalPolicy : s.config.disqualificationPolicy;
  const policy = select([['forfeitRemaining', 'Poules : conserver les résultats acquis, rencontres restantes perdues par forfait'], ['annulAll', 'Poules : annuler toutes ses rencontres (non comptabilisées)']], def);
  const reason = h('input', { placeholder: 'motif' });
  const ok = await modal(type === 'participant.withdraw' ? `Désistement / forfait général — ${p.name}` : `Disqualification — ${p.name}`, h('div', { class: 'col' }, h('label', { class: 'field' }, 'Traitement des rencontres de poule', policy), h('label', { class: 'field' }, 'Motif', reason),
    h('p', { class: 'small muted' }, 'Une rencontre en cours est perdue (abandon si des manches ont été jouées). En élimination directe, l\'adversaire est qualifié par forfait. Un participant désisté ne peut pas être qualifié : le suivant au classement prend sa place.')),
  [{ label: 'Annuler', value: false }, { label: 'Confirmer', class: 'danger', value: true }]);
  if (ok) runSafe(type, { id: p.id, policy: policy.value, reason: reason.value });
}

// ---------------------------------------------------------------- poules
function tabPools() {
  const s = S();
  const d = D();
  const out = [];
  s.config.phases.forEach((cfg, i) => {
    if (cfg.type !== 'pools') return;
    const ph = s.phases[i];
    const dp = d.phases[i];
    const head = h('div', { class: 'row' }, h('h2', {}, cfg.name), h('span', { class: 'badge' }, { pending: 'À constituer', draft: 'Tirage provisoire', active: 'En cours', completed: 'Terminée' }[ph.status]),
      ph.drawSeed ? h('span', { class: 'small muted' }, `graine du tirage : ${ph.drawSeed}`) : null);
    const actions = h('div', { class: 'row' });
    if (i === 0 && ['pending', 'draft'].includes(ph.status) && can('pools.draw')) {
      const method = select([['random', 'Tirage intégral'], ['seeded', 'Têtes de série réparties (serpentin)']], cfg.drawMethod);
      actions.append(method, h('button', { class: ph.status === 'pending' ? 'primary' : '', onclick: () => runSafe('pools.draw', { phaseId: cfg.id, method: method.value }) }, ph.status === 'pending' ? 'Tirer au sort' : 'Refaire le tirage'));
    }
    if (ph.status === 'draft' && can('pools.validate')) actions.append(h('button', { class: 'primary', onclick: () => runSafe('pools.validate', { phaseId: cfg.id }) }, 'Valider les poules et générer les rencontres'));
    if (ph.status === 'active' && can('pools.reset') && !s.matches.some((m) => m.phaseId === cfg.id && ['playing', 'finished', 'suspended', 'awaiting_validation', 'called'].includes(m.status)))
      actions.append(h('button', { onclick: () => runSafe('pools.reset', { phaseId: cfg.id }) }, 'Annuler la validation'));
    if (ph.status === 'pending' && i > 0) actions.append(h('span', { class: 'muted small' }, 'Constituées automatiquement à partir des qualifiés de la phase précédente.'));
    const pools = (dp.pools || []).map((pool) => h('div', { class: 'panel' },
      h('h3', {}, `${pool.name} — ${pool.participantIds.length} participant(s) · ${pool.participantIds.length * (pool.participantIds.length - 1) / 2} rencontres`),
      h('ul', {}, pool.participantIds.map((id) => h('li', {}, h('span', {}, pn(id)), ph.status === 'draft' && can('pools.move') ? h('span', {}, ' ', select([['', 'Déplacer vers…'], ...dp.pools.filter((x) => x.id !== pool.id).map((x) => [x.id, x.name])], '', { class: 'small', onchange: (e) => e.target.value && runSafe('pools.move', { phaseId: cfg.id, participantId: id, toPoolId: e.target.value }, { quiet: true }) }),
        ' ', select([['', 'Échanger avec…'], ...dp.pools.filter((x) => x.id !== pool.id).flatMap((x) => x.participantIds.map((o) => [o, `${pn(o)} (${x.name})`]))], '', { class: 'small', onchange: (e) => e.target.value && runSafe('pools.swap', { phaseId: cfg.id, a: id, b: e.target.value }, { quiet: true }) })) : null))),
      ph.status !== 'draft' && pool.matchCount ? h('div', { class: 'small muted' }, `${pool.finishedCount}/${pool.matchCount} rencontres terminées`) : null));
    out.push(h('section', { class: 'panel' }, head, actions, dp.pools?.length ? h('div', { class: 'grid' }, pools) : h('p', { class: 'empty' }, s.registrationOpen ? 'Clore les inscriptions pour effectuer le tirage.' : 'Tirage non effectué.'),
      ph.status === 'draft' ? h('p', { class: 'small muted' }, 'Le tirage est provisoire : vous pouvez déplacer ou échanger des participants, puis valider. Les rencontres (round-robin) sont générées à la validation.') : null));
  });
  return h('div', {}, out);
}

// ---------------------------------------------------------------- cibles & calendrier
function tabPlanning() {
  const s = S();
  const d = D();
  const cards = d.targets.map((t) => {
    const cur = t.currentMatchId ? mById(t.currentMatchId) : null;
    return h('div', { class: `target ${t.state}` },
      h('h3', {}, t.name, h('span', { class: `badge ${t.state === 'free' ? 'ok' : t.state === 'occupied' ? 'accent' : ''}` }, { free: 'Libre', occupied: 'Occupée', unavailable: 'Indisponible' }[t.state])),
      t.note ? h('div', { class: 'small muted' }, t.note) : null,
      cur ? h('div', {}, h('div', { class: 'vs' }, `${pn(cur.a)} – ${pn(cur.b)}`), h('div', { class: 'small muted' }, `${cur.label} · ${MATCH_STATUS[cur.status]}${cur.startedAt ? ` depuis ${fmtTime(cur.startedAt)}` : cur.calledAt ? ` à ${fmtTime(cur.calledAt)}` : ''}`),
        h('div', { class: 'row' }, h('button', { class: 'small primary', onclick: () => openMatch(ctxForMatch(), cur.id) }, cur.status === 'called' ? 'Démarrer / saisir' : cur.status === 'awaiting_validation' ? 'Valider' : 'Saisir le résultat'))) : null,
      t.queue.length ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Ensuite : '), t.queue.map((id) => { const m = mById(id); return `${m.label} (≈${fmtTime(d.forecast[id]?.estimatedStart)})`; }).join(' · ')) : null,
      !T.token ? h('div', { class: 'row no-print' },
        can('target.setStatus') ? h('button', { class: 'small', onclick: async () => {
          if (t.status === 'available') {
            const note = await promptDialog(`Rendre ${t.name} indisponible`, 'Motif (panne, réservation…) — la rencontre en cours sera suspendue et réaffectée en priorité :', '');
            if (note !== null) runSafe('target.setStatus', { id: t.id, status: 'unavailable', note });
          } else runSafe('target.setStatus', { id: t.id, status: 'available' });
        } }, t.status === 'available' ? 'Indisponible' : 'Remettre en service') : null,
        can('target.rename') ? h('button', { class: 'small ghost', onclick: async () => { const n = await promptDialog('Renommer la cible', 'Nom', t.name); if (n) runSafe('target.rename', { id: t.id, name: n }); } }, 'Renommer') : null,
        can('target.remove') && t.state !== 'occupied' ? h('button', { class: 'small ghost danger', onclick: async () => { if (await confirmDialog('Retirer la cible', `Retirer ${t.name} ?`, { danger: true })) runSafe('target.remove', { id: t.id }); } }, 'Retirer') : null) : null);
  });
  const upcoming = d.upcoming.map((id) => mById(id)).filter(Boolean);
  const waiting = s.matches.filter((m) => ['ready', 'postponed', 'waiting'].includes(m.status) && !d.upcoming.includes(m.id));
  return h('div', {},
    h('section', { class: 'panel' }, h('div', { class: 'row' }, h('h2', {}, 'Cibles'),
      can('target.add') ? h('button', { class: 'small right', onclick: async () => { const n = await promptDialog('Ajouter une cible', 'Nom', `Cible ${s.targets.length + 1}`); if (n) runSafe('target.add', { name: n }); } }, '+ Ajouter une cible') : null),
      h('p', { class: 'small muted' }, s.config.scheduling.autoAssign ? 'Affectation automatique : dès qu\'une cible se libère, la rencontre la plus adaptée y est appelée (aucun participant ne joue deux rencontres à la fois ; repos et équilibre des tours privilégiés).' : 'Affectation manuelle (désactivée dans la configuration).'),
      h('div', { class: 'grid' }, cards)),
    h('section', { class: 'panel' }, h('h2', {}, 'Calendrier prévisionnel'),
      h('p', { class: 'small muted' }, 'Prévision recalculée après chaque événement, à partir des durées estimées par manche (configuration). Les heures sont indicatives.'),
      upcoming.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Début estimé', 'Cible', 'Rencontre', 'Adversaires', 'Statut', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, upcoming.map((m) => {
          const f = d.forecast[m.id];
          return h('tr', {}, h('td', {}, fmtTime(f?.estimatedStart)), h('td', {}, tn(f?.targetId)), h('td', { class: 'small' }, m.label), h('td', {}, `${pn(m.a)} – ${pn(m.b)}`), h('td', {}, h('span', { class: `badge ${MATCH_BADGE[m.status]}` }, MATCH_STATUS[m.status])), h('td', {}, scheduleActions(m)));
        })))) : h('p', { class: 'empty' }, 'Aucune rencontre à planifier.'),
      waiting.length ? h('div', {}, h('h3', {}, 'Hors prévision'), waiting.map((m) => h('div', { class: 'match-line' }, h('span', { class: `badge ${MATCH_BADGE[m.status]}` }, MATCH_STATUS[m.status]), h('span', {}, `${m.label} : ${pn(m.a)} – ${pn(m.b)}`), m.postponeReason ? h('span', { class: 'small muted' }, m.postponeReason) : null, h('span', { class: 'right' }, scheduleActions(m))))) : null),
  );
}

function scheduleActions(m) {
  const out = [];
  const free = D().targets.filter((t) => t.state === 'free');
  if (['ready', 'postponed'].includes(m.status) && m.a && m.b && can('match.assign') && free.length && ['running', 'paused', 'ready', 'draft'].includes(S().status))
    out.push(select([['', 'Affecter à…'], ...free.map((t) => [t.id, t.name])], '', { class: 'small', onchange: (e) => e.target.value && runSafe('match.assign', { matchId: m.id, targetId: e.target.value }) }));
  if (['ready', 'called', 'waiting'].includes(m.status) && can('match.postpone')) out.push(h('button', { class: 'small', onclick: async () => { const r = await promptDialog('Reporter la rencontre', 'Motif (la rencontre ne sera plus appelée jusqu\'à sa remise au calendrier) :', ''); if (r !== null) runSafe('match.postpone', { matchId: m.id, reason: r }); } }, 'Reporter'));
  if (m.status === 'postponed' && can('match.release')) out.push(h('button', { class: 'small', onclick: () => runSafe('match.release', { matchId: m.id }) }, 'Remettre au calendrier'));
  if (['ready', 'waiting'].includes(m.status) && can('match.setPriority')) out.push(h('button', { class: 'small ghost', title: 'Appeler en priorité', onclick: () => runSafe('match.setPriority', { matchId: m.id, priority: (m.priority || 0) + 1 }) }, `▲ priorité${m.priority ? ` (${m.priority})` : ''}`));
  out.push(h('button', { class: 'small ghost', onclick: () => openMatch(ctxForMatch(), m.id) }, 'Ouvrir'));
  return h('span', { class: 'row' }, out);
}

// ---------------------------------------------------------------- rencontres
function tabMatches() {
  const s = S();
  const filter = T.matchFilter || 'all';
  const phase = T.matchPhase || '';
  const list = s.matches.filter((m) => m.result?.outcome !== 'bye' && (!phase || m.phaseId === phase) && (filter === 'all' || (filter === 'live' ? ['called', 'playing', 'suspended', 'awaiting_validation'].includes(m.status) : filter === 'todo' ? ['ready', 'waiting', 'postponed'].includes(m.status) : m.status === filter)))
    .sort((a, b) => (s.config.phases.findIndex((p) => p.id === a.phaseId) - s.config.phases.findIndex((p) => p.id === b.phaseId)) || a.seq - b.seq);
  return h('section', { class: 'panel' },
    h('div', { class: 'row' }, h('h2', {}, `Rencontres (${list.length})`),
      select([['all', 'Toutes'], ['live', 'En cours / appelées'], ['todo', 'À jouer'], ['awaiting_validation', 'À valider'], ['finished', 'Terminées'], ['cancelled', 'Annulées']], filter, { onchange: (e) => { T.matchFilter = e.target.value; render(); } }),
      select([['', 'Toutes les phases'], ...s.config.phases.map((p) => [p.id, p.name])], phase, { onchange: (e) => { T.matchPhase = e.target.value; render(); } }),
      !T.token ? h('a', { class: 'btn small right', href: `/api/tournaments/${T.id}/export/feuilles.pdf`, target: '_blank' }, 'Imprimer les feuilles de match') : null),
    list.length ? list.map(matchLine) : h('p', { class: 'empty' }, 'Aucune rencontre.'));
}

// ---------------------------------------------------------------- classements
function standingsTable(cfg, pool, phaseStatus) {
  const pts = cfg.points;
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'Participant', 'J', 'V', ...(cfg.allowDraw ? ['N'] : []), 'D', 'Pts', 'Manches', 'Diff. m.', cfg.game === 'cutthroat' ? 'Pts infligés/reçus' : cfg.game === '501' ? 'Pts marqués/adv.' : 'Pts marqués/encaissés', 'Diff. pts', 'Statut'].map((x, i) => h('th', { class: i >= 2 && i < 11 ? 'num' : '' }, x)))),
    h('tbody', {}, pool.rows.map((r) => h('tr', {},
      h('td', { class: 'num' }, r.rank ?? '–', r.tied && pool.complete ? h('span', { class: 'badge warn', title: 'Égalité persistante après tous les critères' }, '=') : null),
      h('td', {}, pn(r.participantId), r.manual ? h('span', { class: 'small muted', title: 'Départagé par décision ou tirage au sort' }, ' *') : null),
      h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.wins), cfg.allowDraw ? h('td', { class: 'num' }, r.draws) : null, h('td', { class: 'num' }, r.losses),
      h('td', { class: 'num' }, h('b', {}, r.points)), h('td', { class: 'num' }, `${r.legsFor}-${r.legsAgainst}`), h('td', { class: 'num' }, r.legDiff > 0 ? `+${r.legDiff}` : r.legDiff),
      h('td', { class: 'num' }, `${r.pointsFor}/${r.pointsAgainst}`), h('td', { class: 'num' }, r.pointDiff > 0 ? `+${r.pointDiff}` : r.pointDiff),
      h('td', {}, phaseStatus !== 'draft' ? h('span', { class: `badge ${QUALIF[r.qualification]?.[1] || ''}` }, QUALIF[r.qualification]?.[0] || '') : null))))),
  h('p', { class: 'small muted' }, `Barème : victoire ${pts.win}, nul ${pts.draw}, défaite ${pts.loss}, forfait ${pts.forfeitLoss}. Départage : ${cfg.tiebreakers.map((t) => ({ points: 'points', wins: 'victoires', headToHead: 'confrontation directe', legDiff: 'diff. de manches', legsWon: 'manches gagnées', pointDiff: 'diff. de points', pointsFor: 'points marqués', lot: 'tirage au sort' }[t])).join(' > ')}. « Qualifié / Éliminé » avant la fin de la poule = mathématiquement acquis.`));
}

function tabStandings() {
  const s = S();
  const d = D();
  return h('div', {}, s.config.phases.map((cfg, i) => {
    if (cfg.type !== 'pools') return null;
    const dp = d.phases[i];
    if (!dp.pools?.length || dp.status === 'draft') return h('section', { class: 'panel' }, h('h2', {}, cfg.name), h('p', { class: 'empty' }, 'Classements disponibles après validation des poules.'));
    return h('section', { class: 'panel' }, h('h2', {}, `${cfg.name} — ${cfg.qualifiersPerPool} qualifié(s) par poule`),
      dp.pools.map((pool) => h('div', {}, h('h3', {}, pool.name, pool.complete ? h('span', { class: 'badge ok', style: { marginLeft: '6px' } }, 'terminée') : h('span', { class: 'small muted' }, ` ${pool.finishedCount}/${pool.matchCount}`)),
        standingsTable(cfg, pool, dp.status),
        pool.unresolvedTies.length && pool.complete ? tieResolver(cfg, pool) : null,
        h('details', {}, h('summary', { class: 'small' }, 'Rencontres de la poule'), s.matches.filter((m) => m.phaseId === cfg.id && m.poolId === pool.id).map(matchLine)))));
  }));
}

function tieResolver(cfg, pool) {
  const blocking = D().phases.find((p) => p.id === cfg.id)?.blockingTies?.some((t) => t.poolId === pool.id);
  const box = h('div', { class: `alert ${blocking ? 'action' : 'warning'}` },
    `Égalité persistante après application de tous les critères configurés${blocking ? ' — décision nécessaire pour la qualification ou le placement' : ''}.`);
  if (!can('phase.resolveTie') || !pool.complete) {
    box.append(h('div', { class: 'small' }, pool.complete ? 'En attente de la décision de l\'organisateur.' : 'Le départage sera possible à la fin de la poule.'));
    return box;
  }
  for (const group of pool.unresolvedTies) {
    const order = group.slice();
    const list = h('ol', {});
    const draw = () => clear(list, order.map((id, k) => h('li', {}, pn(id), ' ', k > 0 ? h('button', { class: 'small', onclick: () => { [order[k - 1], order[k]] = [order[k], order[k - 1]]; draw(); } }, '▲') : null)));
    draw();
    box.append(h('div', { class: 'panel', style: { margin: '6px 0', color: 'var(--text)' } }, list, h('div', { class: 'row' },
      h('button', { class: 'primary small', onclick: () => runSafe('phase.resolveTie', { phaseId: cfg.id, poolId: pool.id, order }) }, 'Valider cet ordre (décision)'),
      h('button', { class: 'small', onclick: () => runSafe('phase.resolveTie', { phaseId: cfg.id, poolId: pool.id, method: 'lot' }) }, 'Tirage au sort'))));
  }
  return box;
}

// ---------------------------------------------------------------- tableau
function tabBracket() {
  const s = S();
  const d = D();
  return h('div', {}, s.config.phases.map((cfg, i) => {
    if (cfg.type !== 'knockout') return null;
    const dp = d.phases[i];
    if (!dp.rounds?.length) return h('section', { class: 'panel' }, h('h2', {}, cfg.name), h('p', { class: 'empty' }, i === 0 ? 'Le tableau sera tiré au sort après la clôture des inscriptions.' : 'Le tableau sera généré automatiquement à la fin de la phase précédente.'), i === 0 && !s.registrationOpen && can('phase.generateKnockout') && s.phases[0].status === 'pending' ? h('button', { class: 'primary', onclick: () => runSafe('phase.generateKnockout', { phaseId: cfg.id }) }, 'Tirer au sort le tableau') : null);
    const box = (id) => {
      const m = mById(id);
      const side = (k) => {
        const pid = m[k];
        const win = m.result?.winner === k;
        const seed = k === 'a' ? m.seedA : m.seedB;
        const bye = k === 'a' ? m.byeA : m.byeB;
        const src = k === 'a' ? m.sourceA : m.sourceB;
        const label = pid ? pn(pid) : bye ? 'Exempt' : src ? `${src.take === 'winner' ? 'Vainqueur' : 'Perdant'} ${mById(src.matchId)?.label || ''}` : '?';
        return h('div', { class: `side${win ? ' win' : ''}` }, h('span', {}, seed ? h('span', { class: 'seed' }, seed) : null, label), h('b', {}, m.result && m.result.outcome !== 'bye' ? (k === 'a' ? m.result.legsA : m.result.legsB) : ''));
      };
      return h('div', { class: 'bm', onclick: () => openMatch(ctxForMatch(), id) }, side('a'), side('b'), h('div', { class: 'meta' }, h('span', {}, m.label), h('span', {}, m.result?.outcome === 'bye' ? 'exempt' : m.result?.outcome && m.result.outcome !== 'normal' ? { forfeit: 'forfait', retired: 'abandon', disqualified: 'disq.' }[m.result.outcome] : `${MATCH_STATUS[m.status]}${m.targetId && m.status !== 'finished' ? ` · ${tn(m.targetId)}` : ''}`), h('span', {}, `BO${m.rules.bestOf}`)));
    };
    return h('section', { class: 'panel' }, h('h2', {}, cfg.name),
      h('div', { class: 'bracket' }, dp.rounds.map((r) => h('div', { class: 'round' }, h('h3', {}, r.name), r.matchIds.map(box)))),
      dp.thirdPlaceMatchId ? h('div', { style: { maxWidth: '260px', marginTop: '14px' } }, h('h3', {}, 'Petite finale'), box(dp.thirdPlaceMatchId)) : null,
      h('p', { class: 'small muted' }, `Placement : ${cfg.seeding === 'ranking' ? 'selon le classement des poules (1er contre dernier qualifié, 1 et 2 dans des moitiés opposées)' : 'tirage au sort'}${cfg.avoidSamePool ? ', participants d\'une même poule séparés au premier tour lorsque c\'est possible' : ''}. Les numéros indiquent les têtes de série.`));
  }));
}

// ---------------------------------------------------------------- classement final
function tabFinal() {
  const d = D();
  const fr = d.finalRanking || [];
  return h('section', { class: 'panel' }, h('h2', {}, d.provisionalRanking ? 'Classement (provisoire — tournoi en cours)' : 'Classement final'),
    fr.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Rang'), h('th', {}, 'Participant'), h('th', {}, ''))),
      h('tbody', {}, fr.map((e) => h('tr', {}, h('td', { class: 'num' }, e.position === 1 ? '🥇 1' : e.position === 2 ? '🥈 2' : e.position === 3 ? '🥉 3' : e.position ?? '–', e.tied ? ' (ex aequo)' : ''), h('td', {}, h('b', {}, e.name)), h('td', { class: 'small muted' }, e.note))))) : h('p', { class: 'empty' }, 'Le classement sera établi au fil des résultats.'),
    h('p', { class: 'small muted' }, `Règle : ${S().config.phases.some((p) => p.type === 'knockout') ? `1 vainqueur de la finale, 2 finaliste, ${S().config.phases.find((p) => p.type === 'knockout').thirdPlaceMatch ? '3 et 4 selon la petite finale' : '3e ex aequo pour les demi-finalistes'}, puis perdants de chaque tour ${S().config.phases.find((p) => p.type === 'knockout').placement === 'bySeed' ? 'départagés par leur tête de série' : 'ex aequo'} ; non-qualifiés ensuite, par rang de poule puis moyenne de points par match.` : 'rang de poule, puis comparaison inter-poules (moyennes par match).'}`));
}

// ---------------------------------------------------------------- partage & exports
function tabShare() {
  const s = S();
  const origin = T.lan || location.origin;
  const spectator = s.share?.spectatorToken ? `${origin}/#/p/${s.share.spectatorToken}` : T.token ? `${location.origin}/#/p/${T.token}` : null;
  const registration = s.share?.registrationToken && s.config.publicRegistration ? `${origin}/#/inscription/${s.share.registrationToken}` : null;
  const base = T.token ? `/api/public/${T.token}/export` : `/api/tournaments/${T.id}/export`;
  const link = (file, label) => h('a', { class: 'btn small', href: `${base}/${file}`, target: '_blank', rel: 'noopener' }, label);
  if (!T.token && !T.lanLoaded) {
    T.lanLoaded = true;
    if (['localhost', '127.0.0.1'].includes(location.hostname)) api('GET', '/api/server-info').then((r) => { if (r.lan[0]) { T.lan = r.lan[0]; render(); } }).catch(() => {});
  }
  const shareBlock = (title, url, extra) => h('div', { class: 'panel' }, h('h3', {}, title),
    h('div', { class: 'row' }, h('div', { class: 'qr' }, qrSvg(url, 5)), h('div', { class: 'col', style: { flex: 1, minWidth: '220px' } },
      h('input', { value: url, readonly: true, onclick: (e) => e.target.select() }),
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Lien copié.')) }, 'Copier'), navigator.share ? h('button', { class: 'small', onclick: () => navigator.share({ title: s.name, url }) }, 'Partager') : null, h('button', { class: 'small', onclick: () => window.print() }, 'Imprimer')),
      extra)));
  return h('div', {},
    spectator ? shareBlock('Accès spectateur (lecture seule, temps réel)', spectator, h('p', { class: 'small muted' }, 'Toute personne disposant de ce lien voit les participants, poules, calendrier, résultats, classements et tableau — sans pouvoir rien modifier ni voir les coordonnées.', location.hostname === 'localhost' && !T.lan ? ' Attention : « localhost » n\'est accessible que depuis cet appareil ; ouvrez l\'application via l\'adresse réseau de l\'ordinateur.' : ''),
      can('share.regenerate') ? h('button', { class: 'small danger', onclick: async () => { if (await confirmDialog('Régénérer le lien', 'L\'ancien lien et l\'ancien QR code cesseront de fonctionner.', { danger: true })) runSafe('share.regenerate', { kind: 'spectator' }); } }, 'Régénérer le lien') : null) : null,
    registration ? shareBlock('Inscriptions en ligne', registration, h('p', { class: 'small muted' }, s.registrationOpen ? 'Les inscriptions en ligne sont ouvertes.' : 'Les inscriptions sont closes : le formulaire est fermé.')) : !T.token ? h('div', { class: 'panel small muted' }, 'Inscriptions publiques désactivées (activables dans la configuration).') : null,
    h('section', { class: 'panel' }, h('h2', {}, 'Exports'),
      h('div', { class: 'row' }, link('rapport.pdf', 'Rapport complet (PDF)'), link('feuilles.pdf', 'Feuilles de match à jouer (PDF)'), link('classements.csv', 'Classements (CSV)'), link('resultats.csv', 'Résultats (CSV)'), link('calendrier.csv', 'Calendrier (CSV)'), link('tableau.csv', 'Tableau final (CSV)'), link('participants.csv', 'Participants (CSV)'), link('participants.json', 'Participants (JSON)'),
        canRole('organizer') ? link('participants.csv?contact=1', 'Participants avec coordonnées (CSV)') : null,
        canRole('organizer') ? link('tournoi.json', 'Sauvegarde complète (JSON)') : null),
      h('p', { class: 'small muted' }, 'La sauvegarde JSON permet de restaurer le tournoi sur une autre installation (tableau de bord → Restaurer). Les CSV utilisent le séparateur « ; ».')));
}

// ---------------------------------------------------------------- membres
function tabMembers() {
  const s = S();
  const email = h('input', { type: 'email', placeholder: 'e-mail du compte' });
  const role = select(['admin', 'organizer', 'referee', 'targetManager', 'participant', 'spectator'].map((r) => [r, ROLE_LABELS[r]]), 'referee');
  const targets = h('select', { multiple: true, size: Math.min(6, s.targets.length) }, s.targets.map((t) => h('option', { value: t.id }, t.name)));
  const participant = select([['', '—'], ...s.participants.map((p) => [p.id, p.name])], '');
  return h('div', {},
    h('section', { class: 'panel' }, h('h2', {}, 'Ajouter un membre'),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Compte', email), h('label', { class: 'field' }, 'Rôle', role), h('label', { class: 'field' }, 'Cibles (resp. de cible ; aucune = toutes)', targets), h('label', { class: 'field' }, 'Participant lié (rôle participant)', participant),
        h('button', { class: 'primary', onclick: async () => {
          try {
            const r = await api('POST', `/api/tournaments/${T.id}/members`, { email: email.value, role: role.value, targetIds: [...targets.selectedOptions].map((o) => o.value), participantId: participant.value || null });
            toast(r.summary); load();
          } catch (e) { toast(e.message, { error: true }); }
        } }, 'Ajouter')),
      h('details', {}, h('summary', { class: 'small' }, 'Droits par rôle'), h('ul', { class: 'small' },
        h('li', {}, 'Propriétaire : tout, y compris la suppression du tournoi et la nomination des administrateurs.'),
        h('li', {}, 'Administrateur : configuration, membres, archivage, anonymisation.'),
        h('li', {}, 'Organisateur : inscriptions, poules, phases, cibles, corrections et annulations de résultats, imprévus.'),
        h('li', {}, 'Arbitre : affectation des cibles, validation et rejet des résultats, saisie directe validée.'),
        h('li', {}, 'Responsable de cible : démarrer / suspendre les rencontres de ses cibles et saisir les résultats (soumis à validation si configuré).'),
        h('li', {}, 'Participant : consultation et confirmation de sa propre présence.'),
        h('li', {}, 'Spectateur : consultation des informations publiques.')))),
    h('section', { class: 'panel' }, h('h2', {}, 'Membres'), h('table', {}, h('tbody', {}, s.members.map((m) => h('tr', {}, h('td', {}, m.label || m.userId), h('td', {}, ROLE_LABELS[m.role]), h('td', { class: 'small muted' }, m.targetIds?.length ? m.targetIds.map(tn).join(', ') : ''), h('td', {}, m.role !== 'owner' && can('members.remove', { userId: m.userId }) ? h('button', { class: 'small danger', onclick: () => runSafe('members.remove', { userId: m.userId }) }, 'Retirer') : null)))))));
}

// ---------------------------------------------------------------- journal
function tabJournal() {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Chargement…'));
  api('GET', `/api/tournaments/${T.id}/audit`).then((entries) => {
    clear(box, h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Version', 'Auteur', 'Action', 'Conséquences'].map((x) => h('th', {}, x)))),
      h('tbody', {}, entries.map((e) => h('tr', {}, h('td', { class: 'small' }, fmtDate(e.at)), h('td', { class: 'num small' }, e.version), h('td', { class: 'small' }, e.user || '—', e.role ? h('span', { class: 'muted' }, ` (${ROLE_LABELS[e.role] || e.role})`) : null), h('td', {}, e.summary), h('td', { class: 'small muted' }, (e.events || []).join(' '))))))));
  }).catch((e) => clear(box, h('div', { class: 'alert error' }, e.message)));
  const dec = S().decisions || [];
  return h('div', {}, h('section', { class: 'panel' }, h('h2', {}, 'Historique des actions'), h('p', { class: 'small muted' }, 'Journal non modifiable de toutes les opérations enregistrées (auteur, rôle, version).'), box),
    dec.length ? h('section', { class: 'panel' }, h('h2', {}, 'Décisions de l\'organisateur et résultats archivés'), h('ul', {}, dec.map((x) => h('li', { class: 'small' }, `${fmtDate(x.at)} — ${x.type}${x.matchId ? ` (${mById(x.matchId)?.label || x.matchId})` : ''}${x.order ? ` : ${x.order.map(pn).join(' > ')}` : ''}${x.note ? ` — ${x.note}` : ''}`)))) : null);
}

void requiredRole;
