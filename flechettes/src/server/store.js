// Persistance sur fichiers JSON : écriture atomique (fichier temporaire + fsync
// + renommage), copie de sécurité de la version précédente, journal append-only
// de toutes les commandes. Les tournois de démonstration sont stockés dans un
// espace séparé (données fictives isolées des données réelles).
import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev`);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  for (const f of [file, `${file}.prev`]) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      // fichier corrompu (coupure pendant l'écriture) : on tente la copie de sécurité
    }
  }
  return fallback;
}

class Mutex {
  constructor() { this.chain = Promise.resolve(); }
  run(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
}

export class TournamentStore {
  constructor(dir) {
    this.dir = dir;
    this.tdir = path.join(dir, 'tournaments');
    this.ldir = path.join(dir, 'logs');
    fs.mkdirSync(this.tdir, { recursive: true });
    fs.mkdirSync(this.ldir, { recursive: true });
    this.cache = new Map();
    this.locks = new Map();
    for (const f of fs.readdirSync(this.tdir)) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(path.join(this.tdir, f));
      if (t?.id) this.cache.set(t.id, t);
    }
  }
  file(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Identifiant invalide');
    return path.join(this.tdir, `${id}.json`);
  }
  list() { return [...this.cache.values()]; }
  get(id) { return this.cache.get(id) || null; }
  lock(id) {
    if (!this.locks.has(id)) this.locks.set(id, new Mutex());
    return this.locks.get(id);
  }
  save(state) {
    writeJsonAtomic(this.file(state.id), state);
    this.cache.set(state.id, state);
  }
  delete(id) {
    for (const f of [this.file(id), `${this.file(id)}.prev`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    const log = path.join(this.ldir, `${id}.jsonl`);
    if (fs.existsSync(log)) fs.renameSync(log, `${log}.deleted-${Date.now()}`);
    this.cache.delete(id);
  }
  appendLog(id, entry) {
    fs.appendFileSync(path.join(this.ldir, `${id}.jsonl`), `${JSON.stringify(entry)}\n`);
  }
  readLog(id, limit = 500) {
    const f = path.join(this.ldir, `${id}.jsonl`);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}

export class JsonCollection {
  constructor(file, fallback) {
    this.file = file;
    this.data = readJson(file, fallback);
  }
  save() { writeJsonAtomic(this.file, this.data); }
}
