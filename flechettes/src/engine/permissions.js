// Niveaux d'autorisation et droits requis par commande. Appliqué côté serveur
// sur CHAQUE opération (et réutilisé par l'interface uniquement pour l'affichage).
export const ROLES = ['spectator', 'participant', 'targetManager', 'referee', 'organizer', 'admin', 'owner'];
export const ROLE_LABELS = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  organizer: 'Organisateur',
  referee: 'Arbitre',
  targetManager: 'Responsable de cible',
  participant: 'Participant',
  spectator: 'Spectateur',
};

export function roleLevel(role) {
  return ROLES.indexOf(role);
}

export function atLeast(role, min) {
  return roleLevel(role) >= roleLevel(min);
}

const REQUIRED = {
  'tournament.update': 'admin',
  'config.update': 'admin',
  'share.regenerate': 'admin',
  'members.set': 'admin',
  'members.remove': 'admin',
  'tournament.archive': 'admin',
  'tournament.unarchive': 'admin',
  'registration.open': 'organizer',
  'registration.close': 'organizer',
  'tournament.start': 'organizer',
  'tournament.pause': 'organizer',
  'tournament.resume': 'organizer',
  'tournament.finish': 'organizer',
  'participant.add': 'organizer',
  'participant.update': 'organizer',
  'participant.remove': 'organizer',
  'participant.import': 'organizer',
  'participant.setPresence': 'participant', // un participant ne peut agir que sur sa propre inscription (vérifié ci-dessous)
  'participant.withdraw': 'organizer',
  'participant.disqualify': 'organizer',
  'participant.replacePlayer': 'organizer',
  'participant.replace': 'organizer',
  'participant.anonymize': 'admin',
  'target.add': 'organizer',
  'target.rename': 'organizer',
  'target.setStatus': 'referee',
  'target.remove': 'organizer',
  'pools.draw': 'organizer',
  'pools.move': 'organizer',
  'pools.swap': 'organizer',
  'pools.validate': 'organizer',
  'pools.reset': 'organizer',
  'phase.generateKnockout': 'organizer',
  'phase.resolveTie': 'organizer',
  'phase.regenerateNext': 'organizer',
  'match.assign': 'referee',
  'match.unassign': 'referee',
  'match.pinTarget': 'referee',
  'match.setPriority': 'referee',
  'match.postpone': 'referee',
  'match.release': 'referee',
  'match.start': 'targetManager',
  'match.suspend': 'targetManager',
  'match.resume': 'targetManager',
  'match.submitResult': 'targetManager',
  'match.validateResult': 'referee',
  'match.rejectResult': 'referee',
  'match.correctResult': 'organizer',
  'match.annulResult': 'organizer',
  'match.cancel': 'organizer',
  'match.restore': 'organizer',
  'schedule.dispatch': 'referee',
  'demo.simulate': 'organizer',
};

export function requiredRole(type) {
  return REQUIRED[type] || 'owner';
}

export const COMMAND_TYPES = Object.keys(REQUIRED);

/**
 * Vérifie qu'un membre peut exécuter une commande.
 * member : { role, targetIds?, participantId? } ; state : tournoi (pour les restrictions fines).
 */
export function canExecute(member, command, state) {
  const role = member?.role || 'spectator';
  const min = requiredRole(command.type);
  if (!atLeast(role, min)) return { ok: false, reason: `Action réservée au rôle « ${ROLE_LABELS[min]} » ou supérieur.` };
  const p = command.payload || {};
  if (command.type === 'participant.setPresence' && role === 'participant') {
    if (!member.participantId || member.participantId !== p.id) return { ok: false, reason: 'Un participant ne peut confirmer que sa propre présence.' };
    if (p.presence !== 'confirmed' && p.presence !== 'absent') return { ok: false, reason: 'Présence invalide.' };
  }
  if (role === 'targetManager' && command.type.startsWith('match.')) {
    const m = state.matches.find((x) => x.id === p.matchId);
    const allowed = member.targetIds || [];
    if (allowed.length && (!m || !m.targetId || !allowed.includes(m.targetId)))
      return { ok: false, reason: 'Ce responsable de cible n\'est pas habilité sur la cible de cette rencontre.' };
  }
  if (command.type === 'members.set' && (p.role === 'owner' || p.role === 'admin') && role !== 'owner')
    return { ok: false, reason: 'Seul le propriétaire peut nommer un administrateur.' };
  if ((command.type === 'members.set' || command.type === 'members.remove') && state.members?.find((x) => x.userId === p.userId)?.role === 'owner')
    return { ok: false, reason: 'Le rôle du propriétaire ne peut pas être modifié.' };
  return { ok: true };
}
