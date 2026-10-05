import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomInt } from 'node:crypto';
import { control, newCode, token, makeRoom, snapshot, clocksAt, flag, finish, applyMove, undoMove, reset, other } from './game.js';

// Monotonic time prevents wall-clock corrections from altering game clocks.
export function createChessServer(options = {}) {
  const now = options.now ?? (() => performance.now());
  const abandonMs = options.abandonMs ?? 60000;
  const idleMs = options.idleMs ?? 2 * 60 * 60 * 1000;
  const endedMs = options.endedMs ?? 10 * 60 * 1000;
  const app = express(), http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 8192, serveClient: true });
  const rooms = new Map(), connections = new Map(), ipBuckets = new Map();
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.static(publicDir));
  const broadcast = room => io.to(room.code).emit('state', snapshot(room, now()));
  function end(room, winner, reason) {
    if (finish(room, winner, reason, now())) { io.to(room.code).emit('gameOver', room.result); broadcast(room); }
  }
  function maintainRoom(room) {
    const t = now();
    if (flag(room, t)) { io.to(room.code).emit('gameOver', room.result); broadcast(room); }
    if (!room.result && room.players.w && room.players.b) {
      const offline = ['w', 'b'].filter(c => room.players[c].abandonAt !== null && room.players[c].abandonAt <= t);
      if (offline.length) {
        const earliest = offline.sort((a, b) => room.players[a].abandonAt - room.players[b].abandonAt)[0];
        end(room, other(earliest), 'Opponent abandoned the game');
      }
    }
    if ((room.result && t - room.endedAt > endedMs) || (!room.result && t - room.activityAt > idleMs)) {
      io.to(room.code).emit('roomExpired', { message: 'This room has expired. Create a new game.' });
      io.in(room.code).socketsLeave(room.code);
      for (const s of io.sockets.sockets.values()) if (s.data.code === room.code) { delete s.data.code; delete s.data.token; }
      rooms.delete(room.code);
    }
  }
  function codeOf(value) {
    if (typeof value !== 'string') throw new Error('Enter a six-character room code.');
    const code = value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error('Invalid code. Use six letters or numbers, without 0, O, 1 or I.');
    return code;
  }
  function roomOf(socket) {
    const room = rooms.get(socket.data.code);
    if (!room) throw new Error('Room not found or expired.');
    maintainRoom(room);
    if (!rooms.has(room.code)) throw new Error('This room has expired.');
    return room;
  }
  function colorOf(socket, room) {
    const color = ['w', 'b'].find(c => room.players[c]?.token === socket.data.token && room.players[c].sockets.has(socket.id));
    if (!color) throw new Error('Spectators cannot perform this action.');
    return color;
  }
  function active(socket) {
    const room = roomOf(socket), color = colorOf(socket, room);
    if (room.result) throw new Error('This game has ended.');
    if (!room.players.w || !room.players.b) throw new Error('Wait for your opponent to join.');
    return { room, color };
  }
  function detach(socket) {
    const room = rooms.get(socket.data.code);
    if (room) {
      socket.leave(room.code);
      const color = ['w', 'b'].find(c => room.players[c]?.token === socket.data.token);
      if (color) {
        const p = room.players[color]; p.sockets.delete(socket.id);
        if (!p.sockets.size) {
          p.abandonAt = now() + abandonMs;
          io.to(room.code).emit('opponentDisconnected', { color, seconds: abandonMs / 1000 });
        }
      }
      broadcast(room);
    }
    delete socket.data.code; delete socket.data.token;
  }
  function attach(socket, room, playerToken) {
    detach(socket); socket.join(room.code); socket.data.code = room.code; socket.data.token = playerToken;
    const color = ['w', 'b'].find(c => room.players[c]?.token === playerToken);
    if (color) { room.players[color].sockets.add(socket.id); room.players[color].abandonAt = null; }
    room.activityAt = now(); broadcast(room);
    return { code: room.code, token: color ? playerToken : null, color: color ?? null, state: snapshot(room, now()) };
  }
  function nameOf(name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24) throw new Error('Enter a name of 1–24 characters.');
    const clean = name.trim().replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!clean) throw new Error('Enter a name of 1–24 characters.');
    return clean;
  }
  const player = name => ({ name: nameOf(name), token: token(), sockets: new Set(), abandonAt: null });
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    if ((connections.get(ip) ?? 0) >= 30) return next(new Error('Too many connections. Please try again later.'));
    next();
  });
  io.on('connection', socket => {
    const ip = socket.handshake.address;
    connections.set(ip, (connections.get(ip) ?? 0) + 1);
    let credits = 40, refillAt = now(), lastCreate = -Infinity;
    const on = (event, handler) => socket.on(event, (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const t = now(); credits = Math.min(40, credits + (t - refillAt) / 150); refillAt = t;
        const bucket = ipBuckets.get(ip) ?? { credits: 150, at: t };
        bucket.credits = Math.min(150, bucket.credits + (t - bucket.at) / 50); bucket.at = t; ipBuckets.set(ip, bucket);
        if (credits < 1 || bucket.credits < 1) throw new Error('Too many requests. Please slow down.');
        credits--; bucket.credits--;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request.');
        ack({ ok: true, ...handler(data) });
      } catch (error) { ack({ ok: false, error: error.message }); }
    });
    on('createRoom', data => {
      if (now() - lastCreate < 2000) throw new Error('Please wait a moment before creating another room.');
      if (rooms.size >= 1000) throw new Error('Server is full. Please try again later.');
      if (!['w', 'b', 'random'].includes(data.color)) throw new Error('Choose White, Black or Random.');
      if (typeof data.takebacks !== 'boolean') throw new Error('Invalid takeback setting.');
      const p = player(data.name), time = control(data.timeControl);
      const room = makeRoom(newCode(rooms), time, data.takebacks, now());
      const color = data.color === 'random' ? (randomInt(2) ? 'w' : 'b') : data.color;
      room.players[color] = p; rooms.set(room.code, room); lastCreate = now();
      return attach(socket, room, p.token);
    });
    on('joinRoom', data => {
      const room = rooms.get(codeOf(data.code));
      if (!room) throw new Error('Room not found or expired. Check the code.');
      maintainRoom(room);
      if (!rooms.has(room.code)) throw new Error('This room has expired.');
      if (data.token !== undefined && data.token !== null && (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token))) throw new Error('Invalid player token.');
      const existing = ['w', 'b'].find(c => data.token && room.players[c]?.token === data.token);
      if (existing) return attach(socket, room, data.token);
      if (data.spectator === true) return attach(socket, room, null);
      if (data.spectator !== false) throw new Error('Choose Join or Watch.');
      if (room.result) throw new Error('This game has ended. You can watch it.');
      const color = ['w', 'b'].find(c => !room.players[c]);
      if (!color) throw new Error('This room is full. Use Watch game to join as a spectator.');
      const p = player(data.name); room.players[color] = p;
      return attach(socket, room, p.token);
    });
    on('move', data => {
      const { room, color } = active(socket);
      try { applyMove(room, color, data, now()); }
      finally { broadcast(room); }
      if (room.result) io.to(room.code).emit('gameOver', room.result);
      return {};
    });
    on('resign', () => { const { room, color } = active(socket); end(room, other(color), 'Resignation'); return {}; });
    on('drawOffer', () => {
      const { room, color } = active(socket);
      if (room.drawOffer) throw new Error('A draw offer is already pending.');
      room.drawOffer = color; broadcast(room); return {};
    });
    on('drawResponse', data => {
      const { room, color } = active(socket);
      if (typeof data.accept !== 'boolean' || !room.drawOffer || room.drawOffer === color) throw new Error('No opponent draw offer to answer.');
      if (data.accept) end(room, null, 'Draw by agreement');
      else { room.drawOffer = null; broadcast(room); }
      return {};
    });
    on('takebackRequest', () => {
      const { room, color } = active(socket);
      if (!room.takebacks) throw new Error('Takebacks are disabled in this room.');
      if (!room.history.length || room.history.at(-1).color !== color) throw new Error('You can only request to undo your own last move.');
      if (room.takebackOffer) throw new Error('A takeback request is already pending.');
      room.takebackOffer = color; broadcast(room); return {};
    });
    on('takebackResponse', data => {
      const { room, color } = active(socket);
      if (typeof data.accept !== 'boolean' || !room.takebackOffer || room.takebackOffer === color) throw new Error('No opponent takeback request to answer.');
      if (data.accept) undoMove(room, now()); else room.takebackOffer = null;
      broadcast(room); return {};
    });
    on('rematch', () => {
      const room = roomOf(socket), color = colorOf(socket, room);
      if (!room.result) throw new Error('Finish this game before requesting a rematch.');
      if (!room.players.w || !room.players.b || !room.players.w.sockets.size || !room.players.b.sockets.size) throw new Error('Both players must be connected for a rematch.');
      room.rematchVotes.add(color);
      if (room.rematchVotes.size === 2) reset(room, now());
      broadcast(room); return {};
    });
    on('sync', () => { const room = roomOf(socket); broadcast(room); return { state: snapshot(room, now()) }; });
    on('leaveRoom', () => { detach(socket); return {}; });
    socket.on('disconnect', () => {
      detach(socket);
      const remaining = (connections.get(ip) ?? 1) - 1;
      if (remaining) connections.set(ip, remaining); else connections.delete(ip);
    });
  });
  const timer = setInterval(() => {
    for (const room of rooms.values()) {
      maintainRoom(room);
      if (rooms.has(room.code)) io.to(room.code).emit('clockUpdate', {
        clocks: clocksAt(room, now()), running: room.clockAt !== null && !room.result,
        turn: room.chess.turn(), serverNow: Date.now(), generation: room.generation,
      });
    }
    for (const [ip, bucket] of ipBuckets) if (now() - bucket.at > 60000 && !connections.has(ip)) ipBuckets.delete(ip);
  }, options.tickMs ?? 250);
  timer.unref();
  return { app, http, io, rooms, close: async () => { clearInterval(timer); await new Promise(r => io.close(r)); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createChessServer();
  server.http.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Knight Room listening on port ${Number(process.env.PORT) || 3000}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
}
