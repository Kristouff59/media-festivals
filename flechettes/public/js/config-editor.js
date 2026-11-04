// Éditeur de configuration : tous les formats et limites sont paramétrables ;
// la cohérence est vérifiée en direct par le même code que le serveur.
import { h, clear, select } from './ui.js';
import { validateConfig, TIEBREAKERS, defaultPoolsPhase, defaultKnockoutPhase, roundName } from '/engine/config.js';
import { GAME_LIST } from '/engine/games/index.js';

export function renderConfigEditor({ T, run, S, D, editable }) {
  const cfg = structuredClone(S().config);
  const root = h('div');
  const status = h('div');
  const started = ['running', 'paused', 'finished', 'archived'].includes(S().status);
  const phaseLocked = (id) => S().phases.find((p) => p.id === id)?.status !== 'pending';

  const num = (obj, key, { min = 0, allowNull = false, disabled = false } = {}) => {
    const i = h('input', { type: 'number', min, class: 'num', value: obj[key] ?? '', disabled: !editable || disabled, placeholder: allowNull ? 'aucune' : '' });
    i.addEventListener('input', () => { obj[key] = i.value === '' ? (allowNull ? null : 0) : Number(i.value); check(); });
    return i;
  };
  const chk = (obj, key, { disabled = false } = {}) => {
    const i = h('input', { type: 'checkbox', checked: !!obj[key], disabled: !editable || disabled });
    i.addEventListener('change', () => { obj[key] = i.checked; check(); });
    return i;
  };
  const sel = (obj, key, options, { disabled = false, onChange } = {}) => {
    const s = select(options, obj[key], { disabled: !editable || disabled });
    s.addEventListener('change', () => { obj[key] = s.value; check(); if (onChange) onChange(); });
    return s;
  };
  const txt = (obj, key, { disabled = false } = {}) => {
    const i = h('input', { value: obj[key] ?? '', disabled: !editable || disabled });
    i.addEventListener('input', () => { obj[key] = i.value; check(); });
    return i;
  };
  const F = (label, input, hint) => h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'small muted' }, hint) : null);

  function check() {
    const r = validateConfig(cfg, D().entrants || null);
    clear(status,
      r.errors.length ? h('div', { class: 'alert error' }, 'Incohérences :', h('ul', {}, r.errors.map((e) => h('li', {}, e)))) : h('div', { class: 'alert' }, `Configuration cohérente${D().entrants ? ` pour ${D().entrants} participant(s) présent(s)` : ''}.`),
      r.warnings.length ? h('div', { class: 'alert warning' }, h('ul', {}, r.warnings.map((e) => h('li', {}, e)))) : null);
    if (saveBtn) saveBtn.disabled = !editable || r.errors.length > 0;
  }

  function tiebreakEditor(ph, locked) {
    const box = h('div', { class: 'col' });
    const draw = () => {
      clear(box, h('ol', {}, ph.tiebreakers.map((t, i) => h('li', {}, TIEBREAKERS[t],
        editable && !locked && i > 1 ? h('button', { class: 'small ghost', onclick: () => { [ph.tiebreakers[i - 1], ph.tiebreakers[i]] = [ph.tiebreakers[i], ph.tiebreakers[i - 1]]; draw(); check(); } }, '▲') : null,
        editable && !locked && i > 0 ? h('button', { class: 'small ghost danger', onclick: () => { ph.tiebreakers.splice(i, 1); draw(); check(); } }, '✕') : null))),
      editable && !locked ? select([['', 'Ajouter un critère…'], ...Object.entries(TIEBREAKERS).filter(([k]) => !ph.tiebreakers.includes(k)).map(([k, v]) => [k, v])], '', { onchange: (e) => { if (e.target.value) { ph.tiebreakers.push(e.target.value); draw(); check(); } } }) : null,
      h('span', { class: 'small muted' }, 'Si l\'égalité persiste après le dernier critère, l\'organisateur départage (ordre décidé ou tirage au sort enregistré), sauf si « Tirage au sort reproductible » figure dans la liste.'));
    };
    draw();
    return box;
  }

  function overridesEditor(ph, locked) {
    const keys = ['r2', 'r4', 'r8', 'r16', 'r32', 'third'];
    ph.roundOverrides = ph.roundOverrides || {};
    return h('table', {}, h('thead', {}, h('tr', {}, ['Tour', 'Best of', 'Limite de tours', 'Jeu'].map((x) => h('th', {}, x)))),
      h('tbody', {}, keys.map((k) => {
        const o = ph.roundOverrides[k] || {};
        const set = (field, v) => {
          const cur = { ...(ph.roundOverrides[k] || {}) };
          if (v === '' || v === undefined) delete cur[field]; else cur[field] = v;
          if (Object.keys(cur).length) ph.roundOverrides[k] = cur; else delete ph.roundOverrides[k];
          check();
        };
        const bo = h('input', { type: 'number', min: 1, class: 'num', value: o.bestOf ?? '', placeholder: String(ph.bestOf), disabled: !editable || locked });
        bo.addEventListener('input', () => set('bestOf', bo.value === '' ? '' : Number(bo.value)));
        const tl = h('input', { type: 'number', min: 1, class: 'num', value: o.turnLimit ?? '', placeholder: ph.turnLimit ? String(ph.turnLimit) : 'aucune', disabled: !editable || locked });
        tl.addEventListener('input', () => set('turnLimit', tl.value === '' ? '' : Number(tl.value)));
        const gm = select([['', 'idem phase'], ...GAME_LIST.map((g) => [g.id, g.label])], o.game || '', { disabled: !editable || locked });
        gm.addEventListener('change', () => set('game', gm.value));
        return h('tr', {}, h('td', {}, k === 'third' ? 'Petite finale' : roundName(Number(k.slice(1)) / 2)), h('td', {}, bo), h('td', {}, tl), h('td', {}, gm));
      })));
  }

  function phaseCard(ph, i) {
    const locked = phaseLocked(ph.id);
    const completed = S().phases.find((p) => p.id === ph.id)?.status === 'completed';
    const games = GAME_LIST.map((g) => [g.id, g.label]);
    const common = h('div', { class: 'row' },
      F('Nom', txt(ph, 'name')),
      F('Jeu', sel(ph, 'game', games, { disabled: locked })),
      F('Best of (manches)', num(ph, 'bestOf', { min: 1, disabled: completed })),
      F('Limite de tours par manche', num(ph, 'turnLimit', { min: 1, allowNull: true, disabled: completed }), 'vide = aucune'));
    let specific;
    if (ph.type === 'pools') {
      specific = h('div', { class: 'col' },
        h('div', { class: 'row' },
          F('Nombre de poules', num(ph, 'poolCount', { min: 1, disabled: locked })),
          F('Qualifiés par poule', num(ph, 'qualifiersPerPool', { min: 1, disabled: locked })),
          F('Tirage', sel(ph, 'drawMethod', [['random', 'Intégral'], ['seeded', 'Têtes de série (serpentin)']], { disabled: locked })),
          h('label', { class: 'check' }, chk(ph, 'allowDraw', { disabled: completed }), 'Matchs nuls autorisés')),
        h('div', { class: 'row' }, h('b', { class: 'small' }, 'Barème :'),
          F('Victoire', num(ph.points, 'win', { min: -10, disabled: completed })), F('Nul', num(ph.points, 'draw', { min: -10, disabled: completed })),
          F('Défaite', num(ph.points, 'loss', { min: -10, disabled: completed })), F('Défaite par forfait', num(ph.points, 'forfeitLoss', { min: -10, disabled: completed }))),
        h('div', {}, h('b', { class: 'small' }, 'Ordre des critères de classement'), tiebreakEditor(ph, completed)));
    } else {
      specific = h('div', { class: 'col' },
        h('div', { class: 'row' },
          h('label', { class: 'check' }, chk(ph, 'thirdPlaceMatch', { disabled: locked }), 'Petite finale'),
          h('label', { class: 'check' }, chk(ph, 'avoidSamePool', { disabled: locked }), 'Séparer les participants d\'une même poule au 1er tour'),
          F('Placement dans le tableau', sel(ph, 'seeding', [['ranking', 'Selon le classement (têtes de série)'], ['random', 'Tirage au sort']], { disabled: locked })),
          F('Classement des éliminés d\'un même tour', sel(ph, 'placement', [['tied', 'Ex aequo'], ['bySeed', 'Départagés par tête de série']]))),
        h('div', {}, h('b', { class: 'small' }, 'Règles particulières par tour (vide = règles de la phase). Aucun nul n\'est possible en élimination directe.'), overridesEditor(ph, completed)));
    }
    return h('div', { class: 'phase-card' },
      h('div', { class: 'row' }, h('h3', {}, `Phase ${i + 1} — ${ph.type === 'pools' ? 'Poules (round-robin)' : 'Élimination directe'}`), locked ? h('span', { class: 'badge' }, completed ? 'terminée' : 'générée : structure verrouillée') : null,
        editable && !locked && cfg.phases.length > 1 ? h('button', { class: 'small danger right', onclick: () => { cfg.phases.splice(i, 1); draw(); } }, 'Supprimer la phase') : null),
      common, specific);
  }

  let saveBtn;
  function draw() {
    const gen = h('div', { class: 'panel' }, h('h2', {}, 'Général'),
      h('div', { class: 'row' },
        F('Format', sel(cfg, 'mode', [['team', 'Équipes'], ['individual', 'Individuel']], { disabled: started, onChange: draw })),
        cfg.mode === 'team' ? F('Joueurs par équipe', num(cfg, 'teamSize', { min: 1, disabled: started })) : null,
        F('Participants maximum', num(cfg, 'maxParticipants', { min: 2, allowNull: true }), 'vide = illimité')),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, chk(cfg, 'requirePresenceConfirmation'), 'Seuls les présents confirmés sont tirés au sort'),
        h('label', { class: 'check' }, chk(cfg, 'publicRegistration'), 'Inscriptions publiques en ligne'),
        h('label', { class: 'check' }, chk(cfg, 'allowReplacement'), 'Remplacements de joueurs autorisés'),
        h('label', { class: 'check' }, chk(cfg, 'requireResultValidation'), 'Résultats des responsables de cible soumis à validation')),
      h('div', { class: 'row' },
        F('Désistement en poule', sel(cfg, 'withdrawalPolicy', [['forfeitRemaining', 'Résultats conservés, reste perdu par forfait'], ['annulAll', 'Toutes ses rencontres annulées']])),
        F('Disqualification en poule', sel(cfg, 'disqualificationPolicy', [['forfeitRemaining', 'Résultats conservés, reste perdu par forfait'], ['annulAll', 'Toutes ses rencontres annulées']]))));
    const sch = cfg.scheduling;
    const plan = h('div', { class: 'panel' }, h('h2', {}, 'Planification'),
      h('div', { class: 'row' },
        h('label', { class: 'check' }, chk(sch, 'autoAssign'), 'Affectation automatique des cibles'),
        h('label', { class: 'check' }, chk(sch, 'allowBackToBack'), 'Autoriser deux matchs consécutifs si c\'est le seul moyen d\'occuper une cible'),
        F('Repos minimal souhaité (min)', num(sch, 'minRestMinutes')),
        F('Alerte de retard après (min)', num(sch, 'lateAfterMinutes'))),
      h('div', { class: 'row' }, h('b', { class: 'small' }, 'Durée estimée d\'une manche (min) :'), GAME_LIST.map((g) => F(g.label, num(sch.estimatedLegMinutes, g.id, { min: 1 })))));
    const phases = h('div', { class: 'panel' }, h('h2', {}, 'Phases de compétition'), cfg.phases.map(phaseCard),
      editable ? h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => {
          const id = `p${Date.now().toString(36)}`;
          const idx = cfg.phases[cfg.phases.length - 1]?.type === 'knockout' ? cfg.phases.length - 1 : cfg.phases.length;
          cfg.phases.splice(idx, 0, defaultPoolsPhase({ id, name: `Phase de poules ${idx + 1}`, game: cfg.phases[0]?.game || 'cricket' }));
          draw();
        } }, '+ Phase de poules'),
        cfg.phases[cfg.phases.length - 1]?.type !== 'knockout' ? h('button', { class: 'small', onclick: () => { cfg.phases.push(defaultKnockoutPhase({ id: `p${Date.now().toString(36)}`, game: cfg.phases[0]?.game || 'cricket' })); draw(); } }, '+ Phase finale (élimination directe)') : null) : null);
    saveBtn = h('button', { class: 'primary', onclick: async () => { try { await run('config.update', { config: cfg }, { expectVersion: true }); } catch { /* affiché */ } } }, 'Enregistrer la configuration');
    clear(root, gen, plan, phases, h('div', { class: 'panel' }, status, editable ? h('div', { class: 'row' }, saveBtn, h('span', { class: 'small muted' }, started ? 'Tournoi lancé : seuls les paramètres sans conséquence incontrôlée restent modifiables (les phases générées sont verrouillées ; les nouvelles règles de match s\'appliquent aux rencontres non commencées).' : '')) : h('p', { class: 'small muted' }, 'Lecture seule.')));
    check();
  }
  draw();
  void T;
  return root;
}
