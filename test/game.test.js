import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { control, makeRoom, clocksAt, applyMove, flag, canMate, undoMove, reset, newCode } from '../server/game.js';

function game(preset = '3+2') {
  const room = makeRoom('ABC234', control({ preset }), true, 0);
  room.players.w = { name:'White', sockets:new Set(['w']) };
  room.players.b = { name:'Black', sockets:new Set(['b']) };
  return room;
}
function play(room, san, time = 0) {
  const move = room.chess.moves({ verbose:true }).find(m => m.san === san);
  assert.ok(move, `Expected legal move ${san}`);
  return applyMove(room, room.chess.turn(), { from:move.from, to:move.to, ...(move.promotion ? { promotion:move.promotion } : {}) }, time);
}
test('room codes are six unambiguous characters, unique against store', () => {
  const rooms = new Map();
  for (let i=0;i<1000;i++) { const code = newCode(rooms); assert.match(code,/^[A-HJ-NP-Z2-9]{6}$/); assert.ok(!rooms.has(code)); rooms.set(code,{}); }
});
test('custom bounds and unknown controls are rejected', () => {
  assert.throws(() => control({preset:'bogus'}));
  for (const minutes of [0,181,1.5,'5']) assert.throws(() => control({preset:'custom',minutes,increment:0}));
  assert.equal(control({preset:'custom',minutes:15,increment:10}).initial,900000);
});
test('clock starts after first white move and increments both sides', () => {
  const r = game(); assert.deepEqual(clocksAt(r,100000),{w:180000,b:180000});
  play(r,'e4',100000); assert.deepEqual(clocksAt(r,101000),{w:182000,b:179000});
  play(r,'e5',103000); assert.deepEqual(clocksAt(r,104000),{w:181000,b:179000});
});
test('wrong turn and illegal moves cannot change board or clock', () => {
  const r = game(), fen = r.chess.fen();
  assert.throws(() => applyMove(r,'b',{from:'e7',to:'e5'},10),/turn/);
  assert.throws(() => applyMove(r,'w',{from:'e2',to:'e5'},10),/legal/);
  assert.equal(r.chess.fen(),fen); assert.equal(r.clockAt,null);
});
test('untimed never flags', () => {
  const r = game('untimed'); play(r,'e4'); assert.equal(flag(r,1e12),false); assert.equal(r.clocks.w,null);
});
test('flag fall ends game and cannot be bypassed by a late move', () => {
  const r = game('1+0'); play(r,'e4',0);
  assert.throws(() => play(r,'e5',60001),/expired/);
  assert.equal(r.result.winner,'w'); assert.equal(r.history.length,1);
});
test('flag with bare king opponent is draw', () => {
  const r = game('1+0'); r.chess = new Chess('7k/8/8/8/8/8/6q1/K7 b - - 0 1'); r.clockAt = 0;
  assert.equal(flag(r,60001),true); assert.equal(r.result.winner,null);
});
test('mating material handles bare kings, lone minors, two knights and enemy blockers', () => {
  assert.equal(canMate(new Chess('7k/8/8/8/8/8/8/KN6 w - - 0 1'),'w'),false);
  assert.equal(canMate(new Chess('7k/8/8/8/8/8/8/KNN5 w - - 0 1'),'w'),true);
  assert.equal(canMate(new Chess('7k/7p/8/8/8/8/8/KN6 w - - 0 1'),'w'),true);
  assert.equal(canMate(new Chess('7k/5b2/8/8/8/8/8/KB6 w - - 0 1'),'w'),false);
  assert.equal(canMate(new Chess('7k/6r1/8/8/8/8/8/KB6 w - - 0 1'),'w'),false);
  assert.equal(canMate(new Chess('7k/6q1/8/8/8/8/8/KB6 w - - 0 1'),'w'),false);
  assert.equal(canMate(new Chess('7k/6p1/8/8/8/8/8/KB6 w - - 0 1'),'w'),true);
});
test('checkmate produces SAN and final result', () => {
  const r = game(); for (const san of ['f3','e5','g4','Qh4#']) play(r,san);
  assert.equal(r.result.winner,'b'); assert.equal(r.result.reason,'Checkmate'); assert.equal(r.history.at(-1).san,'Qh4#');
});
test('castling moves rook and king', () => {
  const r = game(); for (const san of ['e4','e5','Nf3','Nc6','Bc4','Nf6','O-O']) play(r,san);
  assert.equal(r.chess.get('g1').type,'k'); assert.equal(r.chess.get('f1').type,'r');
});
test('en passant is recorded as a capture', () => {
  const r = game(); for (const san of ['e4','a6','e5','d5','exd6']) play(r,san);
  assert.equal(r.chess.get('d5'),undefined); assert.equal(r.history.at(-1).captured,'p');
});
test('promotion requires valid piece and supports underpromotion', () => {
  const r = game(); r.chess = new Chess('7k/P7/8/8/8/8/8/K7 w - - 0 1');
  assert.throws(() => applyMove(r,'w',{from:'a7',to:'a8'},0));
  applyMove(r,'w',{from:'a7',to:'a8',promotion:'n'},0); assert.equal(r.chess.get('a8').type,'n'); assert.equal(r.result.reason,'Insufficient material');
});
test('threefold repetition auto-draws', () => {
  const r = game(); for (const san of ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8']) play(r,san);
  assert.equal(r.result.reason,'Threefold repetition');
});
test('stalemate and fifty-move rule', () => {
  const r = game(); r.chess = new Chess('7k/5K2/6Q1/8/8/8/8/8 w - - 0 1'); play(r,'Qf5'); assert.equal(r.result.reason,'Stalemate');
  const s = game(); s.chess = new Chess('7k/8/8/8/8/8/8/KR6 w - - 99 1'); play(s,'Rb2'); assert.equal(s.result.reason,'50-move rule');
});
test('takeback restores position and pre-move clocks', () => {
  const r = game(); play(r,'e4',100); play(r,'e5',1100); undoMove(r,2100);
  assert.equal(r.chess.turn(),'b'); assert.equal(r.clocks.b,179000); assert.equal(r.clockAt,2100);
  undoMove(r,2200); assert.equal(r.clockAt,null); assert.equal(r.started,false); assert.equal(r.history.length,0);
});
test('rematch swaps seats, resets clocks/history and increments generation', () => {
  const r = game(), white = r.players.w; play(r,'e4'); reset(r,100);
  assert.equal(r.players.b,white); assert.equal(r.generation,2); assert.equal(r.history.length,0); assert.equal(r.clocks.w,180000);
});
