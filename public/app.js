/* The browser displays state; only the server decides moves, clocks and results. */
const $ = id => document.getElementById(id);
const socket = io({ reconnection: true });
const glyphs = { w: { k:'♔', q:'♕', r:'♖', b:'♗', n:'♘', p:'♙' }, b: { k:'♚', q:'♛', r:'♜', b:'♝', n:'♞', p:'♟' } };
const pieceNames = { k:'king', q:'queen', r:'rook', b:'bishop', n:'knight', p:'pawn' };
let state = null, code = null, playerToken = null, color = null, orientation = 'w';
let selected = null, viewing = null, promotionMove = null, drag = null;
let clockSample = null, toastTimer, lastResult = null, audioContext, busy = false;
let muted = read('kr:muted') === 'true';
let confirmAction = null;
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch { /* storage may be disabled */ } }
function tokenFor(room) { return read(`kr:token:${room}`); }
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500);
}
function request(event, data = {}) {
  return new Promise(resolve => {
    if (!socket.connected) { toast('You are offline. Reconnecting…', true); return resolve(null); }
    socket.timeout(7000).emit(event, data, (err, reply) => {
      if (err) { toast('No response from the server. Reconnecting may restore your game.', true); return resolve(null); }
      if (!reply?.ok) { toast(reply?.error ?? 'Request failed.', true); return resolve(null); }
      resolve(reply);
    });
  });
}
function setTab(join) {
  $('create-panel').hidden = join; $('join-panel').hidden = !join;
  $('create-tab').classList.toggle('active', !join); $('join-tab').classList.toggle('active', join);
  $('create-tab').setAttribute('aria-selected', !join); $('join-tab').setAttribute('aria-selected', join);
}
$('create-tab').onclick = () => setTab(false); $('join-tab').onclick = () => setTab(true);
$('time').onchange = () => $('custom-time').hidden = $('time').value !== 'custom';
$('name').value = read('kr:name') ?? 'Player';
function name() { const value = $('name').value.trim(); save('kr:name', value); return value; }
function enter(reply) {
  state = null;
  code = reply.code; playerToken = reply.token; color = reply.color; orientation = color ?? 'w';
  viewing = null; selected = null; lastResult = null;
  if (playerToken) save(`kr:token:${code}`, playerToken);
  history.replaceState(null, '', `/?room=${code}`);
  $('landing').hidden = true; $('game').hidden = false;
  receive(reply.state);
}
$('create-panel').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true;
  const reply = await request('createRoom', { name: name(), color: document.querySelector('input[name=color]:checked').value,
    takebacks: $('takebacks').checked, timeControl: { preset: $('time').value, minutes: Number($('minutes').value), increment: Number($('increment').value) } });
  busy = false; if (reply) enter(reply);
};
async function join(spectator = false) {
  if (busy) return; busy = true;
  const room = $('room-code').value.trim().toUpperCase();
  const reply = await request('joinRoom', { code: room, name: name(), spectator, token: spectator ? null : tokenFor(room) });
  busy = false; if (reply) enter(reply);
}
$('join-panel').onsubmit = e => { e.preventDefault(); join(); }; $('watch').onclick = () => join(true);
socket.on('connect', async () => {
  $('connection').textContent = 'Connected'; $('connection').classList.add('online');
  if (code) {
    const reply = await request('joinRoom', { code, token: playerToken, spectator: !playerToken, name: name() });
    if (reply) enter(reply);
    else showLanding();
  } else {
    const query = new URLSearchParams(location.search).get('room');
    if (query) {
      $('room-code').value = query.toUpperCase(); setTab(true);
      const storedToken = tokenFor(query.toUpperCase());
      if (storedToken) {
        const reply = await request('joinRoom', { code: query, token: storedToken, spectator: false, name: name() });
        if (reply) enter(reply);
      }
    }
  }
});
socket.on('disconnect', () => {
  $('connection').textContent = 'Reconnecting…'; $('connection').classList.remove('online');
  selected = null; if (state) render();
});
socket.on('connect_error', error => { $('connection').textContent = 'Offline'; toast(error.message || 'Connection failed.', true); });
socket.on('state', next => {
  if (code && next.code === code) receive(next);
});
socket.on('clockUpdate', sample => {
  if (!state || sample.generation !== state.generation) return;
  clockSample = { ...sample, received: performance.now() }; state.clocks = sample.clocks; renderClocks();
});
socket.on('gameOver', () => { /* Result and position arrive together in state. */ });
socket.on('opponentDisconnected', ({ color: disconnected }) => {
  if (disconnected !== color) toast('A player disconnected. They have 60 seconds to return.');
});
socket.on('roomExpired', ({ message }) => { toast(message, true); showLanding(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && code && socket.connected) request('sync').then(reply => reply && receive(reply.state)); });
function receive(next) {
  const previous = state;
  state = next;
  // Seats are identified by token, never by the client's requested color.
  if (previous && previous.generation !== next.generation) {
    color = color ? (color === 'w' ? 'b' : 'w') : null; orientation = color ?? orientation;
    viewing = null; lastResult = null; $('result-dialog').close();
  }
  if (previous && next.history.length > previous.history.length && previous.generation === next.generation) {
    const move = next.history.at(-1); sound(next.result ? 'end' : move.san.includes('+') ? 'check' : move.captured ? 'capture' : 'move');
  } else if (next.result && !previous?.result) sound('end');
  clockSample = { clocks: next.clocks, turn: next.turn, running: next.running, generation: next.generation, received: performance.now() };
  if (viewing !== null) viewing = Math.min(viewing, next.history.length);
  selected = null; promotionMove = null; $('promotion').close(); render();
  const key = `${next.generation}:${next.result?.reason}`;
  if (next.result && lastResult !== key) { lastResult = key; showResult(); }
}
function boardMap(fen) {
  const map = {}; fen.split(' ')[0].split('/').forEach((row, rank) => {
    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) file += Number(char);
      else { map[`${'abcdefgh'[file++]}${8-rank}`] = { type: char.toLowerCase(), color: char === char.toUpperCase() ? 'w' : 'b' }; }
    }
  }); return map;
}
function displayedPly() { return viewing === null ? state.history.length : viewing; }
function isLive() { return viewing === null || viewing === state.history.length; }
function mayMove() { return socket.connected && color && isLive() && !state.result && state.players.w && state.players.b && state.turn === color; }
function renderBoard() {
  const ply = displayedPly(), fen = ply ? state.history[ply-1].after : state.initialFen;
  const pieces = boardMap(fen), last = ply ? state.history[ply-1] : null;
  const files = orientation === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = orientation === 'w' ? '87654321' : '12345678';
  const fragment = document.createDocumentFragment();
  [...ranks].forEach((rank, r) => [...files].forEach((file, f) => {
    const square = `${file}${rank}`, piece = pieces[square], button = document.createElement('button');
    button.type = 'button'; button.dataset.square = square; button.className = 'square';
    const dark = (file.charCodeAt(0) - 97 + Number(rank)) % 2 === 1;
    button.classList.toggle('dark', dark); button.classList.toggle('has-piece', !!piece);
    button.classList.toggle('last', last?.from === square || last?.to === square);
    button.classList.toggle('selected', selected === square);
    button.classList.toggle('legal', !!selected && mayMove() && state.legalMoves.some(m => m.from === selected && m.to === square));
    button.classList.toggle('check', isLive() && state.checkSquare === square);
    button.setAttribute('aria-label', `${square}${piece ? `, ${piece.color === 'w' ? 'White' : 'Black'} ${pieceNames[piece.type]}` : ', empty'}`);
    if (piece) { const span = document.createElement('span'); span.className = `piece ${piece.color === 'w' ? 'white' : 'black'}`; span.textContent = glyphs[piece.color][piece.type]; button.append(span); }
    if (f === 0) { const label = document.createElement('span'); label.className = 'coordinate'; label.textContent = rank; button.append(label); }
    if (r === 7) { const label = document.createElement('span'); label.className = 'coordinate file'; label.textContent = file; button.append(label); }
    button.onclick = () => clickSquare(square);
    fragment.append(button);
  }));
  $('board').replaceChildren(fragment);
}
function clickSquare(square) {
  if (!mayMove()) return;
  const piece = boardMap(state.fen)[square];
  if (selected && state.legalMoves.some(m => m.from === selected && m.to === square)) return attempt(selected, square);
  selected = piece?.color === color ? (selected === square ? null : square) : null; renderBoard();
}
async function attempt(from, to) {
  const candidates = state.legalMoves.filter(m => m.from === from && m.to === to);
  if (!candidates.length || !mayMove()) return;
  if (candidates.some(m => m.promotion)) {
    promotionMove = { from, to }; $('promotion-pieces').replaceChildren();
    for (const type of ['q','r','b','n']) {
      const button = document.createElement('button'); button.textContent = glyphs[color][type]; button.setAttribute('aria-label', `Promote to ${pieceNames[type]}`);
      button.onclick = () => { const move = promotionMove; $('promotion').close(); promotionMove = null; sendMove({ ...move, promotion: type }); };
      $('promotion-pieces').append(button);
    }
    $('promotion').showModal();
  } else sendMove({ from, to });
}
async function sendMove(move) { selected = null; renderBoard(); await request('move', move); }
$('cancel-promotion').onclick = () => { promotionMove = null; $('promotion').close(); };
// Pointer events give mouse drag and touch drag the same behavior; click remains keyboard-accessible.
$('board').addEventListener('pointerdown', event => {
  if (!mayMove() || event.button !== 0) return;
  const square = event.target.closest('[data-square]')?.dataset.square;
  const piece = boardMap(state.fen)[square];
  if (piece?.color !== color) return;
  drag = { from: square, piece, x: event.clientX, y: event.clientY, active: false };
});
document.addEventListener('pointermove', event => {
  if (!drag) return;
  if (!drag.active && Math.hypot(event.clientX-drag.x,event.clientY-drag.y) > 7) {
    drag.active = true; selected = drag.from; renderBoard();
    drag.ghost = document.createElement('span'); drag.ghost.className = 'drag-ghost'; drag.ghost.textContent = glyphs[drag.piece.color][drag.piece.type];
    drag.ghost.style.fontSize = `${$('board').clientWidth/9}px`; document.body.append(drag.ghost);
  }
  if (drag.active) { event.preventDefault(); drag.ghost.style.left = `${event.clientX}px`; drag.ghost.style.top = `${event.clientY}px`; }
}, { passive:false });
document.addEventListener('pointerup', event => {
  if (!drag) return;
  const current = drag; drag = null;
  if (current.active) {
    current.ghost.remove(); const to = document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-square]')?.dataset.square;
    // Suppress the synthetic click following the drop.
    $('board').addEventListener('click', e => { e.stopImmediatePropagation(); e.preventDefault(); }, { capture:true, once:true });
    if (to && state.legalMoves.some(m => m.from === current.from && m.to === to)) attempt(current.from,to);
    else { selected = null; renderBoard(); }
  }
});
document.addEventListener('pointercancel', () => { drag?.ghost?.remove(); drag = null; selected = null; if (state) renderBoard(); });
function renderPlayer(container, side) {
  const p = state.players[side]; container.replaceChildren();
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = glyphs[side].k;
  const info = document.createElement('div'); info.className = 'player-info';
  const label = document.createElement('div'); label.className = 'player-name'; label.textContent = p ? `${p.name}${color === side ? ' (you)' : ''}` : 'Waiting for a friend…';
  const detail = document.createElement('div'); detail.className = 'player-detail'; detail.textContent = `${side === 'w' ? 'White' : 'Black'}${p ? p.connected ? ' · connected' : ' · disconnected' : ' · share your room code'}`;
  const captured = document.createElement('div'); captured.className = 'captured';
  captured.textContent = state.history.slice(0,displayedPly()).filter(m => m.color === side && m.captured).map(m => glyphs[side === 'w' ? 'b' : 'w'][m.captured]).join('');
  captured.setAttribute('aria-label', 'Captured pieces'); info.append(label,detail,captured);
  const clock = document.createElement('div'); clock.className = 'clock'; clock.id = `clock-${side}`; clock.setAttribute('aria-label', `${side === 'w' ? 'White' : 'Black'} clock`);
  container.append(avatar,info,clock);
}
function formatTime(ms) {
  if (ms === null) return '∞';
  const sec = Math.max(0, ms)/1000;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.floor(Math.ceil(sec)/60)}:${String(Math.ceil(sec)%60).padStart(2,'0')}`;
}
function renderClocks() {
  if (!state || !clockSample) return;
  for (const side of ['w','b']) {
    const el = $(`clock-${side}`); if (!el) continue;
    let time = clockSample.clocks[side];
    // Cosmetic interpolation only. A browser never declares a flag or result.
    if (time !== null && clockSample.running && clockSample.turn === side && socket.connected) time = Math.max(0,time-(performance.now()-clockSample.received));
    el.textContent = formatTime(time); el.classList.toggle('active', clockSample.running && clockSample.turn === side && !state.result);
    el.classList.toggle('low', time !== null && time < 10000);
  }
}
setInterval(renderClocks,100);
function renderMoves() {
  const list = $('move-list'), fragment = document.createDocumentFragment();
  if (!state.history.length) { const p = document.createElement('p'); p.className = 'empty-moves'; p.textContent = 'A fresh board.\nWhite makes the first move.'; fragment.append(p); }
  for (let i=0;i<state.history.length;i+=2) {
    const row = document.createElement('div'); row.className = 'move-row';
    const num = document.createElement('span'); num.textContent = `${i/2+1}.`; row.append(num);
    for (let j=i;j<i+2;j++) {
      if (!state.history[j]) { row.append(document.createElement('span')); continue; }
      const button = document.createElement('button'); button.textContent = state.history[j].san;
      button.classList.toggle('current', displayedPly() === j+1); button.onclick = () => navigate(j+1); row.append(button);
    } fragment.append(row);
  }
  list.replaceChildren(fragment); if (isLive()) list.scrollTop = list.scrollHeight;
  $('move-count').textContent = `${Math.ceil(state.history.length/2)} moves`;
  $('first').disabled = $('prev').disabled = displayedPly() === 0;
  $('next').disabled = $('live').disabled = isLive();
}
function renderOffers() {
  const box = $('offers'); box.replaceChildren(); box.hidden = true;
  const offer = state.drawOffer ? { kind:'draw', side:state.drawOffer, text:'a draw' } : state.takebackOffer ? { kind:'takeback', side:state.takebackOffer, text:'a takeback' } : null;
  if (!offer) return;
  box.hidden = false;
  const p = document.createElement('div'); p.textContent = offer.side === color ? `You offered ${offer.text}. Waiting for your opponent.` : `${state.players[offer.side]?.name} requested ${offer.text}.`; box.append(p);
  if (color && offer.side !== color) for (const [label,accept] of [['Accept',true],['Decline',false]]) {
    const button = document.createElement('button'); button.className = accept ? 'primary' : 'secondary'; button.textContent = label;
    button.onclick = () => request(offer.kind === 'draw' ? 'drawResponse' : 'takebackResponse',{ accept }); box.append(button);
  }
}
function render() {
  if (!state) return;
  $('display-code').textContent = state.code; $('control-label').textContent = state.timeControl.label;
  $('seat-label').textContent = color ? `You’re playing ${color === 'w' ? 'White' : 'Black'}.` : 'You’re watching as a spectator.';
  $('game-title').textContent = state.result ? 'A game well played' : !state.players.w || !state.players.b ? 'Invite your opponent' : 'At the board';
  renderBoard(); renderPlayer($('top-player'), orientation === 'w' ? 'b' : 'w'); renderPlayer($('bottom-player'),orientation); renderClocks(); renderMoves(); renderOffers();
  $('board-status').textContent = !socket.connected ? 'Offline · reconnecting' : !isLive() ? `Reviewing move ${displayedPly()} · return to live to play` : state.result ? `${state.result.score} · ${state.result.reason}` : !state.players.w || !state.players.b ? 'Waiting for opponent' : `${state.turn === 'w' ? 'White' : 'Black'} to move${state.checkSquare ? ' · check' : ''}`;
  const playable = !!color && !state.result && !!state.players.w && !!state.players.b && socket.connected;
  $('draw').disabled = !playable || !!state.drawOffer; $('resign').disabled = !playable;
  $('draw').hidden = $('resign').hidden = !!state.result;
  $('takeback').hidden = !state.takebacks || !!state.result || !color;
  $('takeback').disabled = !playable || state.history.at(-1)?.color !== color || !!state.takebackOffer;
  $('rematch').hidden = !state.result || !color;
  $('rematch').disabled = !!state.result && state.rematchVotes.includes(color);
  $('rematch').textContent = state.rematchVotes.includes(color) ? 'Rematch requested · waiting…' : state.rematchVotes.length ? 'Accept rematch · swap colors' : 'Play again · swap colors';
  const disconnected = Object.entries(state.players).filter(([,p]) => p && !p.connected);
  $('notice').hidden = !disconnected.length || !!state.result;
  $('notice').textContent = disconnected.map(([c,p]) => `${p.name} (${c === 'w' ? 'White' : 'Black'}) disconnected. They have 60 seconds to reconnect.`).join(' ');
}
function navigate(ply) { viewing = ply >= state.history.length ? null : Math.max(0,ply); selected = null; render(); }
$('first').onclick = () => navigate(0); $('prev').onclick = () => navigate(displayedPly()-1);
$('next').onclick = () => navigate(displayedPly()+1); $('live').onclick = () => navigate(state.history.length);
$('flip').onclick = () => { orientation = orientation === 'w' ? 'b' : 'w'; render(); };
document.addEventListener('keydown', event => {
  if (!state || $('game').hidden || event.target.matches('input,select') || document.querySelector('dialog[open]')) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(displayedPly()-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigate(displayedPly()+1); }
});
$('draw').onclick = () => request('drawOffer'); $('takeback').onclick = () => request('takebackRequest');
function confirm(title,text,action) { $('confirm-title').textContent = title; $('confirm-text').textContent = text; confirmAction = action; $('confirm-dialog').showModal(); }
$('confirm-cancel').onclick = () => $('confirm-dialog').close();
$('confirm-ok').onclick = () => { $('confirm-dialog').close(); confirmAction?.(); confirmAction = null; };
$('resign').onclick = () => confirm('Resign this game?', 'Your opponent will win by resignation.', () => request('resign'));
$('rematch').onclick = () => request('rematch');
$('modal-rematch').onclick = async () => { const reply = await request('rematch'); if (reply) { $('result-dialog').close(); toast('Rematch requested. Both players must agree.'); } };
function showResult() {
  $('result-title').textContent = state.result.winner ? `${state.result.winner === 'w' ? 'White' : 'Black'} wins` : 'It’s a draw';
  $('result-reason').textContent = state.result.reason; $('result-score').textContent = state.result.score;
  $('modal-rematch').hidden = !color; $('result-dialog').showModal();
}
$('close-result').onclick = () => $('result-dialog').close();
function showLanding() {
  code = null; state = null; color = null; playerToken = null; clockSample = null;
  for (const dialog of document.querySelectorAll('dialog')) dialog.close();
  $('game').hidden = true; $('landing').hidden = false; history.replaceState(null,'','/');
}
$('leave').onclick = () => confirm('Leave this room?', state.result ? 'You can return using the room link until it expires.' : 'Your seat is reserved. Return within 60 seconds to avoid an abandonment loss once both players have joined.', async () => { if (await request('leaveRoom')) showLanding(); });
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { toast(`Copy this: ${text}`); }
}
$('copy-code').onclick = () => copy(code); $('copy-link').onclick = () => copy(`${location.origin}/?room=${code}`);
function applyTheme(theme) { document.documentElement.dataset.theme = theme; save('kr:theme',theme); $('theme').setAttribute('aria-label',`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`); }
applyTheme(read('kr:theme') ?? 'dark'); $('theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
function updateMute() { $('mute').textContent = muted ? '♪̸' : '♫'; $('mute').setAttribute('aria-label',muted ? 'Unmute sounds' : 'Mute sounds'); }
updateMute(); $('mute').onclick = () => { muted = !muted; save('kr:muted',muted); updateMute(); };
// Small synthesized sounds keep the project self-contained, without audio downloads.
document.addEventListener('pointerdown', () => {
  if (!audioContext) { const Audio = window.AudioContext || window.webkitAudioContext; if (Audio) audioContext = new Audio(); }
  if (audioContext?.state === 'suspended') audioContext.resume();
}, { passive:true });
function sound(kind) {
  if (muted || !audioContext || audioContext.state !== 'running') return;
  const notes = { move:[330],capture:[220,150],check:[520,660],end:[392,494,587] }[kind];
  notes.forEach((frequency,i) => {
    const osc = audioContext.createOscillator(), gain = audioContext.createGain(), at = audioContext.currentTime+i*.11;
    osc.type = 'sine'; osc.frequency.value = frequency; gain.gain.setValueAtTime(.0001,at); gain.gain.exponentialRampToValueAtTime(.07,at+.01); gain.gain.exponentialRampToValueAtTime(.0001,at+.14);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(at); osc.stop(at+.16);
  });
}
