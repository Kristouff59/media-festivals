// Mécanique commune de marquage des cibles du Cricket (15 à 20 et bull).
// Ce module ne contient AUCUNE règle de score : le Cricket standard et le
// Cut-Throat définissent chacun leur propre attribution des points.
import { DomainError } from '../errors.js';

export const NUMBERS = [20, 19, 18, 17, 16, 15, 25];

export function createBoard(sides) {
  return {
    marks: Array.from({ length: sides }, () => Object.fromEntries(NUMBERS.map((n) => [n, 0]))),
    points: Array(sides).fill(0),
    current: 0,
    dartsInVisit: 0,
    turn: 1,
    finished: false,
    winner: null,
  };
}

export function checkDart({ segment, multiplier }) {
  if (!(Number.isInteger(segment) && ((segment >= 0 && segment <= 20) || segment === 25)))
    throw new DomainError('INVALID_DART', 'Segment invalide.');
  if (![1, 2, 3].includes(multiplier) || (segment === 25 && multiplier === 3))
    throw new DomainError('INVALID_DART', 'Multiplicateur invalide.');
}

export function isClosed(board, side, n) {
  return board.marks[side][n] >= 3;
}

export function allClosed(board, side) {
  return NUMBERS.every((n) => isClosed(board, side, n));
}

/** Ajoute les marques et renvoie le nombre de marques excédentaires (au-delà de la fermeture). */
export function addMarks(board, side, n, hits) {
  const before = board.marks[side][n];
  const needed = Math.max(0, 3 - before);
  board.marks[side][n] = before + Math.min(hits, needed);
  return Math.max(0, hits - needed);
}

export function totalMarks(board, side) {
  return NUMBERS.reduce((s, n) => s + Math.min(3, board.marks[side][n]), 0);
}

export function advance(board) {
  board.dartsInVisit += 1;
  if (board.dartsInVisit === 3) endVisit(board);
}

export function endVisit(board) {
  board.dartsInVisit = 0;
  board.current = (board.current + 1) % board.points.length;
  if (board.current === 0) board.turn += 1;
}

export function isTurnLimitReached(board, turnLimit) {
  return !!turnLimit && !board.finished && board.turn > turnLimit;
}
