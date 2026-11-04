// Accès à l'API : idempotence (identifiant de commande réutilisé lors des
// nouvelles tentatives après une coupure réseau), gestion des conflits.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Erreur ${status}`);
    this.status = status;
    this.code = body?.code;
    this.details = body?.details;
  }
}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'Connexion au serveur impossible.' });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Envoie une commande métier ; réessaie automatiquement en cas de coupure (même commandId). */
export async function command(tournamentId, type, payload = {}, { expectedVersion } = {}) {
  const commandId = uuid();
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await api('POST', `/api/tournaments/${tournamentId}/commands`, { type, payload, expectedVersion, commandId });
    } catch (e) {
      last = e;
      if (e.status !== 0) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw last;
}
