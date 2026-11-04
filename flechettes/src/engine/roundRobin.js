// Round-robin par la méthode du cercle : chaque participant rencontre une seule
// fois chacun des autres, n(n-1)/2 rencontres réparties en tours où personne
// ne joue deux fois (n-1 tours si n pair, n tours avec un exempt si n impair).
export function roundRobin(ids) {
  const list = ids.slice();
  if (list.length < 2) return [];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  const arr = list.slice();
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const x = arr[i];
      const y = arr[n - 1 - i];
      if (x !== null && y !== null) pairs.push(r % 2 === 0 ? [x, y] : [y, x]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()); // rotation, le premier reste fixe
  }
  return rounds;
}

export function expectedMatchCount(n) {
  return (n * (n - 1)) / 2;
}
