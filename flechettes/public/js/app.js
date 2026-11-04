// Application principale : routeur, comptes, tableau de bord, statistiques.
import { h, clear, toast, modal, confirmDialog, fmtDate, select } from './ui.js';
import { api } from './api.js';
import { renderTournament, stopTournament } from './tournament.js';
import { PRESETS } from '/engine/config.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
export const session = { user: null };

const STATUS_LABEL = { draft: 'En préparation', ready: 'Prêt à lancer', running: 'En cours', paused: 'Interrompu', finished: 'Terminé', archived: 'Archivé' };
export { STATUS_LABEL };

function renderNav() {
  clear(nav,
    session.user ? [
      h('a', { class: 'btn small ghost', href: '#/' }, 'Tournois'),
      h('a', { class: 'btn small ghost', href: '#/demo' }, 'Démonstration'),
      h('a', { class: 'btn small ghost', href: '#/stats' }, 'Statistiques & palmarès'),
      h('a', { class: 'btn small ghost', href: '#/compte' }, 'Compte'),
    ] : null,
  );
  clear(who, session.user ? [session.user.name, ' ', h('button', { class: 'small ghost', onclick: logout }, 'Déconnexion')] : null);
}

async function logout() {
  await api('POST', '/api/auth/logout', {});
  session.user = null;
  location.hash = '#/login';
}

async function route() {
  stopTournament();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  renderNav();
  const [page, a, b] = parts;
  try {
    if (page === 'p' && a) return renderTournament(app, { token: a, tab: b || 'apercu' });
    if (page === 'inscription' && a) return renderPublicRegistration(a);
    if (!session.user) return renderLogin();
    if (page === 't' && a) return renderTournament(app, { id: a, tab: b || 'apercu', user: session.user });
    if (page === 'demo') return renderDashboard(true);
    if (page === 'stats') return renderStats();
    if (page === 'compte') return renderAccount();
    return renderDashboard(false);
  } catch (e) {
    clear(app, h('div', { class: 'alert error' }, e.message));
  }
}

function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const name = h('input', { type: 'text', autocomplete: 'name' });
  let mode = 'login';
  const nameField = h('label', { class: 'field', style: { display: 'none' } }, 'Nom affiché', name);
  const title = h('h1', {}, 'Connexion');
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Se connecter');
  const toggle = h('button', { type: 'button', class: 'ghost', onclick: () => {
    mode = mode === 'login' ? 'register' : 'login';
    title.textContent = mode === 'login' ? 'Connexion' : 'Créer un compte';
    submit.textContent = mode === 'login' ? 'Se connecter' : 'Créer le compte';
    toggle.textContent = mode === 'login' ? 'Créer un compte' : 'J\'ai déjà un compte';
    nameField.style.display = mode === 'login' ? 'none' : '';
    pw.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  } }, 'Créer un compte');
  const form = h('form', { class: 'panel col', style: { maxWidth: '420px', margin: '30px auto' }, onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', { email: email.value, password: pw.value, name: name.value });
      session.user = r.user;
      location.hash = '#/';
      route();
    } catch (err) { toast(err.message, { error: true }); }
  } }, title, nameField, h('label', { class: 'field' }, 'Adresse e-mail', email), h('label', { class: 'field' }, 'Mot de passe (8 caractères minimum)', pw), h('div', { class: 'row' }, submit, toggle),
  h('p', { class: 'small muted' }, 'Les spectateurs n\'ont pas besoin de compte : ils utilisent le lien ou le QR code de partage du tournoi.'));
  clear(app, form);
}

async function renderDashboard(demo) {
  const list = await api('GET', `/api/tournaments${demo ? '?demo=1' : ''}`);
  const rows = list.map((t) => h('tr', {},
    h('td', {}, h('a', { href: `#/t/${t.id}` }, t.name)),
    h('td', {}, h('span', { class: `badge ${t.status === 'running' ? 'accent' : t.status === 'finished' ? 'ok' : ''}` }, STATUS_LABEL[t.status])),
    h('td', { class: 'num' }, t.participants),
    h('td', {}, t.mode === 'team' ? 'Équipes' : 'Individuel'),
    h('td', {}, t.winner ? `🏆 ${t.winner}` : ''),
    h('td', { class: 'small muted' }, fmtDate(t.updatedAt)),
    h('td', {}, h('button', { class: 'small', onclick: () => duplicate(t) }, 'Dupliquer')),
  ));
  const active = rows.filter((_, i) => list[i].status !== 'archived');
  const archived = rows.filter((_, i) => list[i].status === 'archived');
  const table = (r) => (r.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Nom', 'Statut', 'Inscrits', 'Format', 'Vainqueur', 'Mis à jour', ''].map((x) => h('th', {}, x)))), h('tbody', {}, r))) : h('p', { class: 'empty' }, 'Aucun tournoi.'));
  clear(app,
    demo ? h('div', { class: 'alert' }, 'Mode démonstration : les tournois créés ici utilisent des participants fictifs et les mêmes règles métier que les vrais tournois. Ils sont stockés à part et exclus des statistiques et du palmarès.') : null,
    demo ? demoCreator() : creator(list),
    h('section', { class: 'panel' }, h('h2', {}, demo ? 'Tournois de démonstration' : 'Mes tournois'), table(active)),
    archived.length ? h('section', { class: 'panel' }, h('h2', {}, 'Archives'), table(archived)) : null,
  );
}

async function duplicate(t) {
  const withP = h('input', { type: 'checkbox' });
  const name = h('input', { value: `${t.name} (copie)`, style: { width: '100%' } });
  const ok = await modal('Dupliquer le tournoi', h('div', { class: 'col' }, h('label', { class: 'field' }, 'Nom', name), h('label', { class: 'check' }, withP, 'Reprendre les participants (présence à reconfirmer)'), h('p', { class: 'small muted' }, 'La configuration (phases, jeux, règles, cibles) est reprise à l\'identique. Les résultats ne sont pas copiés.')), [{ label: 'Annuler', value: false }, { label: 'Dupliquer', class: 'primary', value: true }]);
  if (!ok) return;
  try {
    const r = await api('POST', `/api/tournaments/${t.id}/duplicate`, { name: name.value, withParticipants: withP.checked });
    location.hash = `#/t/${r.id}`;
  } catch (e) { toast(e.message, { error: true, details: e.details }); }
}

function creator(list) {
  const name = h('input', { placeholder: 'Nom du tournoi', required: true, style: { minWidth: '260px' } });
  const preset = select([...Object.entries(PRESETS).map(([k, v]) => [`preset:${k}`, v.label]), ...list.map((t) => [`from:${t.id}`, `Réutiliser la configuration de « ${t.name} »`])], 'preset:reference');
  const targets = h('input', { type: 'number', min: 1, value: 4, class: 'num' });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  return h('section', { class: 'panel' },
    h('h2', {}, 'Nouveau tournoi'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const [kind, key] = preset.value.split(':');
      try {
        const r = await api('POST', '/api/tournaments', { name: name.value, targets: Number(targets.value), ...(kind === 'preset' ? { preset: key } : { fromTournamentId: key }) });
        location.hash = `#/t/${r.id}/config`;
      } catch (err) { toast(err.message, { error: true, details: err.details }); }
    } }, name, h('label', { class: 'field' }, 'Format de départ', preset), h('label', { class: 'field' }, 'Cibles', targets), h('button', { class: 'primary', type: 'submit' }, 'Créer')),
    h('p', { class: 'small muted' }, 'Tous les paramètres restent modifiables ensuite dans l\'onglet Configuration.'),
    h('details', {}, h('summary', {}, 'Restaurer un tournoi depuis un export JSON (changement d\'appareil, sauvegarde)'),
      h('div', { class: 'row' }, file, h('button', { onclick: async () => {
        const f = file.files[0];
        if (!f) return toast('Choisir un fichier.', { error: true });
        try {
          const data = JSON.parse(await f.text());
          const r = await api('POST', '/api/tournaments/import', { data });
          location.hash = `#/t/${r.id}`;
        } catch (err) { toast(err.message || 'Fichier invalide', { error: true, details: err.details }); }
      } }, 'Importer'))),
  );
}

function demoCreator() {
  const preset = select(Object.entries(PRESETS).map(([k, v]) => [k, v.label]), 'reference');
  const count = h('input', { type: 'number', min: 2, max: 128, value: 8, class: 'num' });
  const targets = h('input', { type: 'number', min: 1, value: 4, class: 'num' });
  const game = select([['', 'Jeu du préréglage'], ['cricket', 'Cricket'], ['cutthroat', 'Cut-Throat'], ['501', '501']], '');
  return h('section', { class: 'panel' }, h('h2', {}, 'Créer un tournoi fictif'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Format', preset), h('label', { class: 'field' }, 'Participants', count), h('label', { class: 'field' }, 'Cibles', targets), h('label', { class: 'field' }, 'Jeu', game),
      h('button', { class: 'primary', onclick: async () => {
        try {
          const r = await api('POST', '/api/demo', { preset: preset.value, count: Number(count.value), targets: Number(targets.value), game: game.value || undefined });
          location.hash = `#/t/${r.id}`;
        } catch (e) { toast(e.message, { error: true, details: e.details }); }
      } }, 'Générer')),
    h('p', { class: 'small muted' }, 'Essayer par exemple 7 ou 11 participants pour tester les nombres impairs, les poules inégales et les exemptions.'));
}

async function renderStats() {
  const s = await api('GET', '/api/stats');
  const tbl = (rows, kind) => h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [kind, 'Tournois', 'Matchs', 'V', 'N', 'D', '% vict.', 'Manches', 'Titres', 'Podiums', 'Par jeu', 'Classements'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', { class: 'num' }, r.tournaments), h('td', { class: 'num' }, r.matches), h('td', { class: 'num' }, r.wins), h('td', { class: 'num' }, r.draws), h('td', { class: 'num' }, r.losses), h('td', { class: 'num' }, r.winRate === null ? '—' : `${r.winRate} %`), h('td', { class: 'num' }, `${r.legsWon}-${r.legsLost}`), h('td', { class: 'num' }, r.titles), h('td', { class: 'num' }, r.podiums),
      h('td', { class: 'small' }, Object.entries(r.byGame).map(([g, v]) => `${g} : ${v.wins}V/${v.losses}D${v.draws ? `/${v.draws}N` : ''}`).join(' · ')),
      h('td', { class: 'small' }, r.results.map((x) => `${x.position ?? '-'}${x.tied ? '=' : ''} (${x.tournament}${x.as ? `, avec ${x.as}` : ''})`).join(' · ')))))));
  clear(app,
    h('section', { class: 'panel' }, h('h1', {}, 'Statistiques'), h('div', { class: 'row', style: { gap: '30px' } },
      h('div', { class: 'kpi' }, h('b', {}, s.totals.tournaments), 'tournois organisés'),
      h('div', { class: 'kpi' }, h('b', {}, s.totals.finished), 'tournois terminés'),
      h('div', { class: 'kpi' }, h('b', {}, s.totals.matches), 'matchs disputés (terminés)'),
      h('div', { class: 'kpi' }, h('b', {}, s.totals.participations), 'participations')),
    h('p', { class: 'small muted' }, 'Calculées uniquement sur les tournois réels terminés ou archivés, à partir des rencontres validées. Les forfaits sont comptés comme victoires/défaites ; les exemptions ne sont pas comptées.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Palmarès'), s.palmares.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Tournoi', 'Jeu(x)', 'Participants', '1er', '2e', '3e'].map((x) => h('th', {}, x)))),
      h('tbody', {}, s.palmares.map((p) => h('tr', {}, h('td', {}, fmtDate(p.date)), h('td', {}, h('a', { href: `#/t/${p.tournamentId}` }, p.name), p.incomplete ? ' (clôture anticipée)' : ''), h('td', {}, p.games.join(', ')), h('td', { class: 'num' }, p.participants), h('td', {}, p.winner.join(' / ')), h('td', {}, p.second.join(' / ')), h('td', {}, p.third.join(' / '))))))) : h('p', { class: 'empty' }, 'Aucun tournoi terminé.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Équipes / participants'), s.entities.length ? tbl(s.entities, 'Nom') : h('p', { class: 'empty' }, 'Aucune donnée.')),
    s.players.length ? h('section', { class: 'panel' }, h('h2', {}, 'Joueurs (membres d\'équipes)'), tbl(s.players, 'Joueur')) : null,
  );
}

async function renderAccount() {
  const oldPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  clear(app, h('section', { class: 'panel' }, h('h1', {}, 'Mon compte'),
    h('p', {}, `${session.user.name} — ${session.user.email}${session.user.globalRole === 'superadmin' ? ' — administrateur de l\'instance' : ''}`),
    h('h2', {}, 'Changer de mot de passe'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Actuel', oldPw), h('label', { class: 'field' }, 'Nouveau', newPw), h('button', { onclick: async () => {
      try { await api('POST', '/api/auth/password', { oldPassword: oldPw.value, newPassword: newPw.value }); toast('Mot de passe modifié.'); } catch (e) { toast(e.message, { error: true }); }
    } }, 'Modifier')),
    h('h2', {}, 'Données personnelles'),
    h('p', { class: 'small muted' }, 'Export de toutes les données liées à votre compte (rôles, inscriptions portant votre adresse e-mail), et suppression du compte.'),
    h('div', { class: 'row' },
      h('button', { onclick: async () => {
        const data = await api('GET', '/api/me/export');
        const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'mes-donnees.json' });
        document.body.append(a); a.click(); a.remove();
      } }, 'Exporter mes données'),
      h('button', { class: 'danger', onclick: async () => {
        if (!(await confirmDialog('Supprimer mon compte', 'Cette action est définitive. Vos rôles dans les tournois seront retirés.', { danger: true, ok: 'Supprimer' }))) return;
        try { await api('DELETE', '/api/me'); session.user = null; location.hash = '#/login'; } catch (e) { toast(e.message, { error: true, details: e.details }); }
      } }, 'Supprimer mon compte'))));
}

async function renderPublicRegistration(token) {
  const info = await api('GET', `/api/register/${token}`);
  const name = h('input', { required: true });
  const players = info.mode === 'team' ? Array.from({ length: info.teamSize }, () => h('input', { required: true })) : [];
  const email = h('input', { type: 'email' });
  const phone = h('input', { type: 'tel' });
  const done = h('div');
  clear(app, h('section', { class: 'panel', style: { maxWidth: '520px', margin: '20px auto' } },
    h('h1', {}, `Inscription — ${info.name}`),
    !info.open ? h('div', { class: 'alert warning' }, 'Les inscriptions en ligne sont fermées.') : h('form', { class: 'col', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', `/api/register/${token}`, { name: name.value, players: players.map((p) => p.value), email: email.value, phone: phone.value, commandId: crypto.randomUUID?.() });
        clear(done, h('div', { class: 'alert' }, `${r.summary} Votre présence devra être confirmée le jour du tournoi.`));
        e.target.reset();
      } catch (err) { toast(err.message, { error: true, details: err.details }); }
    } },
    h('label', { class: 'field' }, info.mode === 'team' ? 'Nom de l\'équipe' : 'Nom et prénom', name),
    players.map((p, i) => h('label', { class: 'field' }, `Joueur ${i + 1}`, p)),
    h('label', { class: 'field' }, 'E-mail (facultatif, visible des seuls organisateurs)', email),
    h('label', { class: 'field' }, 'Téléphone (facultatif)', phone),
    h('button', { class: 'primary', type: 'submit' }, 'S\'inscrire')),
    done,
    h('p', { class: 'small muted' }, `${info.count} inscrit(s)${info.max ? ` sur ${info.max} places` : ''}.`)));
}

async function boot() {
  try {
    const r = await api('GET', '/api/auth/me');
    session.user = r.user;
  } catch { session.user = null; }
  window.addEventListener('hashchange', route);
  route();
}
boot();
