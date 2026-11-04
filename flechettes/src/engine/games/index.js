import * as x01 from './x01.js';
import * as cricket from './cricket.js';
import * as cutthroat from './cutthroat.js';

export const GAMES = { [x01.id]: x01, [cricket.id]: cricket, [cutthroat.id]: cutthroat };

export function getGame(id) {
  const g = GAMES[id];
  if (!g) throw new Error(`Jeu inconnu : ${id}`);
  return g;
}

export const GAME_LIST = Object.values(GAMES).map((g) => ({ id: g.id, label: g.label }));
