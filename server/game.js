import { Chess } from 'chess.js';
import { randomInt, randomBytes } from 'node:crypto';

export const PRESETS = {
  '1+0': [1, 0], '2+1': [2, 1], '3+0': [3, 0], '3+2': [3, 2],
  '5+0': [5, 0], '10+0': [10, 0], '15+10': [15, 10], '30+0': [30, 0],
};
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const other = color => color === 'w' ? 'b' : 'w';
export const token = () => randomBytes(32).toString('hex');
export function newCode(rooms) {
  let code;
  do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
  return code;
}
export function control(input = {}) {
  if (input.preset === 'untimed') return { initial: null, increment: 0, label: 'Untimed' };
  let pair = PRESETS[input.preset];
  if (input.preset === 'custom') {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 180 ||
        !Number.isInteger(input.increment) || input.increment < 0 || input.increment > 120) {
      throw new Error('Custom time must be 1–180 minutes and 0–120 increment seconds.');
    }
    pair = [input.minutes, input.increment];
  }
  if (!pair) throw new Error('Choose a valid time control.');
  return { initial: pair[0] * 60000, increment: pair[1] * 1000, label: `${pair[0]}+${pair[1]}` };
}
export function makeRoom(code, timeControl, takebacks, now) {
  return {
    code, timeControl, takebacks, chess: new Chess(), players: { w: null, b: null },
    clocks: { w: timeControl.initial, b: timeControl.initial }, clockAt: null,
    started: false, history: [], clockHistory: [], result: null,
    drawOffer: null, takebackOffer: null, rematchVotes: new Set(),
    createdAt: now, activityAt: now, endedAt: null, generation: 1,
  };
}
export function clocksAt(room, now) {
  const clocks = { ...room.clocks };
  if (room.clockAt !== null && !room.result && room.timeControl.initial !== null) {
    const turn = room.chess.turn();
    clocks[turn] = Math.max(0, clocks[turn] - Math.max(0, now - room.clockAt));
  }
  return clocks;
}
export function finish(room, winner, reason, now) {
  if (room.result) return false;
  room.clocks = clocksAt(room, now);
  room.clockAt = null;
  room.result = { winner, score: winner === 'w' ? '1–0' : winner === 'b' ? '0–1' : '½–½', reason };
  room.drawOffer = null;
  room.takebackOffer = null;
  room.endedAt = now;
  room.activityAt = now;
  return true;
}
// Material-based mating potential for flag falls, including cooperative mates.
// A lone minor can sometimes mate when suitable enemy pieces block the king.
export function canMate(chess, color) {
  const own = [], enemy = [];
  chess.board().forEach((row, rank) => row.forEach((p, file) => {
    if (p && p.type !== 'k') (p.color === color ? own : enemy).push({ ...p, parity: (rank + file) % 2 });
  }));
  if (!own.length) return false;
  if (own.some(p => 'pqr'.includes(p.type))) return true;
  const bishops = own.filter(p => p.type === 'b');
  const knights = own.filter(p => p.type === 'n');
  if (knights.length >= 2 || (knights.length && bishops.length)) return true;
  if (new Set(bishops.map(p => p.parity)).size > 1) return true;
  if (knights.length) return enemy.some(p => p.type !== 'q');
  return enemy.some(p => p.type === 'p' || p.type === 'n' || (p.type === 'b' && p.parity !== bishops[0].parity));
}
export function flag(room, now) {
  if (!room.result && room.clockAt !== null && clocksAt(room, now)[room.chess.turn()] <= 0) {
    const winner = other(room.chess.turn());
    return finish(room, canMate(room.chess, winner) ? winner : null,
      canMate(room.chess, winner) ? 'Time expired' : 'Time expired · insufficient mating material', now);
  }
  return false;
}
export function applyMove(room, color, input, now) {
  if (room.result) throw new Error('This game has ended.');
  if (!room.players.w || !room.players.b) throw new Error('Wait for your opponent to join.');
  if (room.chess.turn() !== color) throw new Error('It is not your turn.');
  if (flag(room, now)) throw new Error('Your time has expired.');
  if (!input || typeof input.from !== 'string' || typeof input.to !== 'string' || !/^[a-h][1-8]$/.test(input.from) || !/^[a-h][1-8]$/.test(input.to) ||
      (input.promotion !== undefined && (typeof input.promotion !== 'string' || !/^[qrbn]$/.test(input.promotion)))) throw new Error('Invalid move format.');
  const before = { clocks: clocksAt(room, now), started: room.started };
  let move;
  try { move = room.chess.move({ from: input.from, to: input.to, promotion: input.promotion }); }
  catch { throw new Error('That move is not legal.'); }
  room.clockHistory.push(before);
  room.clocks = { ...before.clocks };
  if (room.timeControl.initial !== null) room.clocks[color] += room.timeControl.increment;
  room.started = true;
  room.clockAt = room.timeControl.initial === null ? null : now;
  room.history.push({ from: move.from, to: move.to, san: move.san, color, captured: move.captured,
    piece: move.piece, promotion: move.promotion, before: move.before, after: move.after });
  room.drawOffer = null; room.takebackOffer = null; room.activityAt = now;
  if (room.chess.isCheckmate()) finish(room, color, 'Checkmate', now);
  else if (room.chess.isStalemate()) finish(room, null, 'Stalemate', now);
  else if (room.chess.isThreefoldRepetition()) finish(room, null, 'Threefold repetition', now);
  else if (room.chess.isDrawByFiftyMoves()) finish(room, null, '50-move rule', now);
  else if (room.chess.isInsufficientMaterial()) finish(room, null, 'Insufficient material', now);
  return move;
}
export function undoMove(room, now) {
  room.chess.undo(); room.history.pop();
  const previous = room.clockHistory.pop();
  room.clocks = previous.clocks; room.started = previous.started;
  room.clockAt = room.started && room.timeControl.initial !== null ? now : null;
  room.takebackOffer = null; room.drawOffer = null; room.activityAt = now;
}
export function reset(room, now) {
  [room.players.w, room.players.b] = [room.players.b, room.players.w];
  room.chess = new Chess(); room.history = []; room.clockHistory = [];
  room.clocks = { w: room.timeControl.initial, b: room.timeControl.initial };
  room.clockAt = null; room.started = false; room.result = null;
  room.drawOffer = null; room.takebackOffer = null; room.rematchVotes.clear();
  room.endedAt = null; room.activityAt = now; room.generation++;
}
export function snapshot(room, now) {
  return {
    code: room.code, fen: room.chess.fen(), initialFen: new Chess().fen(), turn: room.chess.turn(),
    legalMoves: room.result ? [] : room.chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion })),
    checkSquare: room.chess.inCheck() ? room.chess.board().flat().find(p => p?.type === 'k' && p.color === room.chess.turn())?.square : null,
    players: Object.fromEntries(['w', 'b'].map(c => [c, room.players[c] ? {
      name: room.players[c].name, connected: room.players[c].sockets.size > 0,
      abandonAt: room.players[c].abandonAt,
    } : null])),
    history: room.history, clocks: clocksAt(room, now), serverNow: Date.now(),
    running: room.clockAt !== null && !room.result, started: room.started,
    timeControl: room.timeControl, result: room.result, takebacks: room.takebacks,
    drawOffer: room.drawOffer, takebackOffer: room.takebackOffer,
    rematchVotes: [...room.rematchVotes], generation: room.generation,
  };
}
