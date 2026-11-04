// Constitution des poules : tirage reproductible, répartition équilibrée
// (tailles différant d'au plus 1), têtes de série en serpentin.
import { createRng, shuffle } from './rng.js';
import { DomainError } from './errors.js';

export function poolName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Poule ${s}`;
}

/**
 * entrants : [{ id, seed? }] dans l'ordre de priorité (pour method 'seeded',
 *   l'ordre de la liste fait foi : premiers = meilleures têtes de série).
 * method : 'random' | 'seeded'
 */
export function drawPools(entrants, poolCount, { method = 'random', seed = 'seed' } = {}) {
  if (poolCount < 1) throw new DomainError('INVALID_POOLS', 'Nombre de poules invalide.');
  if (entrants.length < poolCount * 2) throw new DomainError('INVALID_POOLS', `Il faut au moins ${poolCount * 2} participants pour ${poolCount} poule(s).`);
  const rng = createRng(`pools:${seed}`);
  let ordered;
  if (method === 'seeded') {
    // Les participants ayant une tête de série sont classés selon celle-ci ;
    // les autres sont tirés au sort à la suite.
    const seeded = entrants.filter((e) => Number.isInteger(e.seed)).sort((a, b) => a.seed - b.seed);
    const rest = shuffle(entrants.filter((e) => !Number.isInteger(e.seed)), rng);
    ordered = seeded.concat(rest);
  } else {
    ordered = shuffle(entrants, rng);
  }
  const pools = Array.from({ length: poolCount }, (_, i) => ({ id: `pool${i + 1}`, name: poolName(i), participantIds: [] }));
  ordered.forEach((e, i) => {
    const line = Math.floor(i / poolCount);
    const pos = i % poolCount;
    const idx = line % 2 === 0 ? pos : poolCount - 1 - pos; // serpentin
    pools[idx].participantIds.push(e.id);
  });
  return pools;
}
