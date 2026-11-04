// Outil d'administration local (sur la machine qui héberge les données).
//   node src/server/admin-cli.js reset-password <email> <nouveau-mot-de-passe>
//   node src/server/admin-cli.js list-users
//   node src/server/admin-cli.js make-superadmin <email>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const auth = new Auth(dataDir);
const [cmd, email, pw] = process.argv.slice(2);

function need(u) {
  if (!u) { console.error(`Aucun compte pour ${email}`); process.exit(1); }
  return u;
}

switch (cmd) {
  case 'list-users':
    for (const u of auth.users.data.users) console.log(`${u.email}\t${u.name}\t${u.globalRole}`);
    break;
  case 'reset-password': {
    const u = need(auth.findByEmail(email));
    if (String(pw || '').length < 8) { console.error('Mot de passe : 8 caractères minimum.'); process.exit(1); }
    u.passwordHash = auth.hash(pw);
    for (const [k, v] of Object.entries(auth.sessions.data.sessions)) if (v.userId === u.id) delete auth.sessions.data.sessions[k];
    auth.users.save();
    auth.sessions.save();
    console.log(`Mot de passe de ${u.email} réinitialisé (sessions fermées).`);
    break;
  }
  case 'make-superadmin': {
    const u = need(auth.findByEmail(email));
    u.globalRole = 'superadmin';
    auth.users.save();
    console.log(`${u.email} administre désormais l'instance.`);
    break;
  }
  default:
    console.log('Commandes : list-users | reset-password <email> <mdp> | make-superadmin <email>');
    console.log('Arrêter le serveur avant usage (les comptes sont relus au démarrage).');
}
