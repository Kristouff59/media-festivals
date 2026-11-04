// Comptes utilisateurs : mots de passe dérivés par scrypt (sel aléatoire),
// sessions par jeton aléatoire, limitation des tentatives de connexion.
import crypto from 'node:crypto';
import path from 'node:path';
import { JsonCollection } from './store.js';

const SESSION_TTL = 30 * 24 * 3600 * 1000;

export class Auth {
  constructor(dir) {
    this.users = new JsonCollection(path.join(dir, 'users.json'), { users: [] });
    this.sessions = new JsonCollection(path.join(dir, 'sessions.json'), { sessions: {} });
    this.attempts = new Map();
  }
  hash(password, salt = crypto.randomBytes(16).toString('hex')) {
    const h = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${h}`;
  }
  verify(password, stored) {
    const [salt, h] = stored.split(':');
    const test = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(test, Buffer.from(h, 'hex'));
  }
  publicUser(u) {
    return u ? { id: u.id, email: u.email, name: u.name, globalRole: u.globalRole, createdAt: u.createdAt } : null;
  }
  findByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.users.data.users.find((u) => u.email === e) || null;
  }
  findById(id) {
    return this.users.data.users.find((u) => u.id === id) || null;
  }
  register({ email, password, name }) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'Adresse e-mail invalide.');
    if (String(password || '').length < 8) throw httpError(400, 'Le mot de passe doit comporter au moins 8 caractères.');
    if (this.findByEmail(e)) throw httpError(409, 'Un compte existe déjà avec cette adresse.');
    const user = {
      id: `u_${crypto.randomBytes(8).toString('hex')}`,
      email: e,
      name: String(name || '').trim() || e.split('@')[0],
      passwordHash: this.hash(password),
      // Le premier compte créé administre l'instance.
      globalRole: this.users.data.users.length === 0 ? 'superadmin' : 'user',
      createdAt: Date.now(),
    };
    this.users.data.users.push(user);
    this.users.save();
    return user;
  }
  login({ email, password }, ip = '') {
    const key = `${ip}:${String(email).toLowerCase()}`;
    const a = this.attempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw httpError(429, 'Trop de tentatives : réessayer dans quelques minutes.');
    const u = this.findByEmail(email);
    if (!u || !this.verify(String(password || ''), u.passwordHash)) {
      a.n += 1;
      if (a.n >= 5) { a.until = Date.now() + 5 * 60000; a.n = 0; }
      this.attempts.set(key, a);
      throw httpError(401, 'Identifiants incorrects.');
    }
    this.attempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.data.sessions[token] = { userId: u.id, expires: Date.now() + SESSION_TTL };
    this.prune();
    this.sessions.save();
    return { token, user: u };
  }
  logout(token) {
    delete this.sessions.data.sessions[token];
    this.sessions.save();
  }
  userForToken(token) {
    const s = token && this.sessions.data.sessions[token];
    if (!s || s.expires < Date.now()) return null;
    return this.findById(s.userId);
  }
  prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.sessions.data.sessions)) if (v.expires < now) delete this.sessions.data.sessions[k];
  }
  changePassword(userId, oldPw, newPw) {
    const u = this.findById(userId);
    if (!this.verify(String(oldPw || ''), u.passwordHash)) throw httpError(401, 'Mot de passe actuel incorrect.');
    if (String(newPw || '').length < 8) throw httpError(400, 'Le mot de passe doit comporter au moins 8 caractères.');
    u.passwordHash = this.hash(newPw);
    this.users.save();
  }
  deleteUser(userId) {
    this.users.data.users = this.users.data.users.filter((u) => u.id !== userId);
    for (const [k, v] of Object.entries(this.sessions.data.sessions)) if (v.userId === userId) delete this.sessions.data.sessions[k];
    this.users.save();
    this.sessions.save();
  }
}

export function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  e.details = details;
  return e;
}
