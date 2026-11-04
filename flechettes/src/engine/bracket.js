// Tableau à élimination directe : taille = puissance de 2 supérieure,
// exemptions attribuées aux meilleures têtes de série, placement standard
// (1 contre le dernier, 1 et 2 dans des moitiés opposées), évitement des
// confrontations entre participants d'une même poule au premier tour.
import { roundKey, roundName, knockoutRules } from './config.js';

export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/**
 * seeded : [{ participantId, poolId?, tier? }] — index 0 = tête de série n°1.
 * Retourne la liste des matchs du tableau (avec liens vers les matchs sources).
 */
export function buildBracket(seeded, phase) {
  const n = seeded.length;
  const size = 2 ** Math.ceil(Math.log2(Math.max(2, n)));
  const order = seedOrder(size);
  let slots = order.map((s) => (s <= n ? { ...seeded[s - 1], seed: s } : null));
  if (phase.avoidSamePool) slots = avoidSamePool(slots);
  const matches = [];
  let roundMatches = size / 2;
  let prev = [];
  let roundIndex = 0;
  while (roundMatches >= 1) {
    const key = roundKey(roundMatches);
    const rules = knockoutRules(phase, key);
    const cur = [];
    for (let i = 0; i < roundMatches; i++) {
      const id = `${phase.id}-${key}-${i + 1}`;
      const m = {
        id,
        phaseId: phase.id,
        kind: 'knockout',
        roundKey: key,
        roundIndex,
        roundName: roundName(roundMatches),
        slot: i,
        label: roundMatches === 1 ? 'Finale' : `${roundName(roundMatches).replace(/s de finale$/, '').replace(/-finales$/, '-finale')} ${i + 1}`,
        rules,
      };
      if (roundIndex === 0) {
        const A = slots[2 * i];
        const B = slots[2 * i + 1];
        m.a = A ? A.participantId : null;
        m.b = B ? B.participantId : null;
        m.seedA = A ? A.seed : null;
        m.seedB = B ? B.seed : null;
        m.byeA = !A;
        m.byeB = !B;
      } else {
        m.a = null;
        m.b = null;
        m.sourceA = { matchId: prev[2 * i].id, take: 'winner' };
        m.sourceB = { matchId: prev[2 * i + 1].id, take: 'winner' };
      }
      cur.push(m);
      matches.push(m);
    }
    if (roundMatches === 2 && phase.thirdPlaceMatch) {
      matches.push({
        id: `${phase.id}-third`,
        phaseId: phase.id,
        kind: 'knockout',
        roundKey: 'third',
        roundIndex: roundIndex + 1,
        roundName: 'Petite finale',
        slot: 0,
        label: 'Petite finale',
        rules: knockoutRules(phase, 'third'),
        a: null,
        b: null,
        sourceA: { matchId: cur[0].id, take: 'loser' },
        sourceB: { matchId: cur[1].id, take: 'loser' },
      });
    }
    prev = cur;
    roundMatches /= 2;
    roundIndex++;
  }
  return { size, matches };
}

/** Échanges entre participants de même rang de poule pour éviter les duels internes au premier tour. */
export function avoidSamePool(slots) {
  const s = slots.slice();
  const pairs = s.length / 2;
  const pool = (x) => (x ? x.poolId ?? null : null);
  const clash = (i) => {
    const A = s[2 * i];
    const B = s[2 * i + 1];
    return A && B && pool(A) !== null && pool(A) === pool(B);
  };
  for (let i = 0; i < pairs; i++) {
    if (!clash(i)) continue;
    let fixed = false;
    // On déplace le moins bien classé des deux (position impaire = adversaire de la tête de série).
    for (const side of [1, 0]) {
      const x = 2 * i + side;
      for (let j = 0; j < pairs && !fixed; j++) {
        if (j === i) continue;
        for (const sideJ of [1, 0]) {
          const y = 2 * j + sideJ;
          if (!s[x] || !s[y] || s[x].tier !== s[y].tier) continue;
          [s[x], s[y]] = [s[y], s[x]];
          if (!clash(i) && !clash(j)) { fixed = true; break; }
          [s[x], s[y]] = [s[y], s[x]];
        }
      }
      if (fixed) break;
    }
  }
  return s;
}
