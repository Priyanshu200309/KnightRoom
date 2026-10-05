import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createChessServer } from '../server/index.js';

async function harness(t, options = {}) {
  let clock = 0;
  const server = createChessServer({ now:() => clock, tickMs:10, ...options });
  await new Promise(r => server.http.listen(0,'127.0.0.1',r));
  const url = `http://127.0.0.1:${server.http.address().port}`, clients = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); });
  async function client() {
    const s = connect(url,{ transports:['websocket'], reconnection:false }); clients.push(s);
    await new Promise((resolve,reject) => { s.once('connect',resolve); s.once('connect_error',reject); }); return s;
  }
  const emit = (s,event,data = {}) => new Promise(r => s.emit(event,data,r));
  const create = s => emit(s,'createRoom',{name:'Alice',color:'w',takebacks:true,timeControl:{preset:'3+2'}});
  const join = (s,code,extra = {}) => emit(s,'joinRoom',{name:'Bob',code,spectator:false,...extra});
  const sleep = () => new Promise(r => setTimeout(r,40));
  return { server,url,client,emit,create,join,sleep,advance: n => { clock += n; } };
}
test('two seats, clear full error, spectator read-only and token secrecy', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client(), c = await h.client();
  const created = await h.create(a); assert.equal(created.ok,true); assert.equal(created.color,'w');
  assert.equal((await h.join(b,created.code)).color,'b');
  assert.match((await h.join(c,created.code)).error,/full/);
  const watch = await h.join(c,created.code,{spectator:true}); assert.equal(watch.color,null);
  assert.ok(!JSON.stringify(watch.state).includes(created.token));
  assert.match((await h.emit(c,'move',{from:'e2',to:'e4'})).error,/Spectators/);
  assert.match((await h.emit(b,'move',{from:'e7',to:'e5'})).error,/turn/);
  assert.equal((await h.emit(a,'move',{from:'e2',to:'e4'})).ok,true);
  assert.equal(h.server.rooms.get(created.code).history.length,1);
});
test('invalid and expired codes are rejected', async t => {
  const h = await harness(t), a = await h.client();
  assert.match((await h.join(a,'000001')).error,/Invalid code/);
  assert.match((await h.join(a,'ABC234')).error,/not found/);
});
test('reconnect restores seat, FEN, SAN and clocks', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client();
  const created = await h.create(a); await h.join(b,created.code);
  await h.emit(a,'move',{from:'e2',to:'e4'}); a.disconnect(); await h.sleep(); h.advance(1000);
  const restored = await h.join(await h.client(),created.code,{token:created.token});
  assert.equal(restored.color,'w'); assert.equal(restored.state.history[0].san,'e4');
  assert.equal(restored.state.clocks.b,179000); assert.equal(restored.state.players.w.connected,true);
});
test('one tab closing does not disconnect a seat still open in another tab', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client();
  const created = await h.create(a); await h.join(b,created.code);
  const duplicate = await h.client(); await h.join(duplicate,created.code,{token:created.token});
  a.disconnect(); await h.sleep(); assert.equal(h.server.rooms.get(created.code).players.w.abandonAt,null);
});
test('abandonment after grace period and reconnect cancels timer', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client();
  const created = await h.create(a), joined = await h.join(b,created.code);
  b.disconnect(); await h.sleep(); h.advance(30000);
  const replacement = await h.client(); await h.join(replacement,created.code,{token:joined.token});
  h.advance(40000); await h.sleep(); assert.equal(h.server.rooms.get(created.code).result,null);
  replacement.disconnect(); await h.sleep(); h.advance(60001); await h.sleep();
  assert.equal(h.server.rooms.get(created.code).result.winner,'w');
});
test('draw offer, authorization, acceptance and rematch color swap', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client();
  const created = await h.create(a); await h.join(b,created.code);
  await h.emit(a,'drawOffer'); assert.equal((await h.emit(a,'drawResponse',{accept:true})).ok,false);
  assert.equal((await h.emit(b,'drawResponse',{accept:true})).ok,true);
  assert.equal(h.server.rooms.get(created.code).result.winner,null);
  await h.emit(a,'rematch'); await h.emit(b,'rematch');
  assert.equal(h.server.rooms.get(created.code).players.b.token,created.token);
  assert.equal((await h.emit(a,'move',{from:'e2',to:'e4'})).ok,false);
  assert.equal((await h.emit(b,'move',{from:'e2',to:'e4'})).ok,true);
});
test('takeback requests require opponent approval and last mover', async t => {
  const h = await harness(t), a = await h.client(), b = await h.client();
  const created = await h.create(a); await h.join(b,created.code); await h.emit(a,'move',{from:'e2',to:'e4'});
  assert.equal((await h.emit(b,'takebackRequest')).ok,false);
  assert.equal((await h.emit(a,'takebackRequest')).ok,true);
  assert.equal((await h.emit(a,'takebackResponse',{accept:true})).ok,false);
  assert.equal((await h.emit(b,'takebackResponse',{accept:true})).ok,true);
  assert.equal(h.server.rooms.get(created.code).history.length,0);
});
test('resign and room expiry', async t => {
  const h = await harness(t,{endedMs:1000}), a = await h.client(), b = await h.client();
  const created = await h.create(a); await h.join(b,created.code); await h.emit(a,'resign');
  assert.equal(h.server.rooms.get(created.code).result.winner,'b'); h.advance(1001); await h.sleep();
  assert.equal(h.server.rooms.has(created.code),false);
});
test('idle room expiry and HTTP health/static assets', async t => {
  const h = await harness(t,{idleMs:1000}), a = await h.client();
  const created = await h.create(a); h.advance(1001); await h.sleep(); assert.equal(h.server.rooms.has(created.code),false);
  assert.equal((await fetch(`${h.url}/health`)).status,200);
  const html = await fetch(h.url); assert.match(await html.text(),/Knight Room/); assert.ok(html.headers.get('content-security-policy'));
});
test('event flooding is rate limited', async t => {
  const h = await harness(t), a = await h.client(); await h.create(a);
  const responses = await Promise.all(Array.from({length:50},() => h.emit(a,'sync')));
  assert.ok(responses.some(r => /Too many requests/.test(r.error)));
});
