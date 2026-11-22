import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GameError } from '../src/game.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-home-'));
process.env.KRILLION_PARTY_HOME = home; // must be set before config.js reads it

const { loadConfig, saveConfig, publicConfig } = await import('../src/config.js');
const { lanAddresses, isLocalRequest } = await import('../src/net.js');
const { createServer } = await import('../src/server.js');

const LINK = 'https://krillion.io/unlock?session_id=cs_live_SECRET123';
const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-public-'));
fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>host</title>host page');
fs.writeFileSync(path.join(publicDir, 'play.html'), '<!doctype html><title>play</title>play page');
fs.writeFileSync(path.join(publicDir, 'style.css'), 'body{}');

function stubParty() {
  const calls = [];
  const listeners = [];
  return {
    calls,
    join(name) { if (name === 'taken') throw new GameError('The name "taken" is taken. Please pick another one.'); calls.push(['join', name]); return { id: 'p1', token: 't1' }; },
    playerByToken: (t) => (t === 't1' ? { id: 'p1' } : null),
    answer: async (id, a) => { calls.push(['answer', id, a]); return a === 'late' ? { ok: false, reason: 'closed' } : { ok: true }; },
    start: async () => { calls.push(['start']); },
    next: async () => { calls.push(['next']); },
    again: async () => { calls.push(['again']); },
    remove: (id) => { calls.push(['remove', id]); },
    stop: async () => {},
    phase: 'lobby',
    snapshot(viewerId) { return { phase: this.phase, players: [], prompt: null, reveal: null, you: viewerId ? { id: viewerId } : null, timeLeft: null, notice: null }; },
    onEmit: (fn) => listeners.push(fn),
  };
}

let party, server, port, lan;
before(async () => {
  party = stubParty();
  lan = lanAddresses()[0] ?? null;
  server = createServer({
    party,
    getConfig: loadConfig,
    saveConfig,
    runCheck: async () => ({ ok: true, lines: ['✔ fine'] }),
    lan,
    publicDir,
  });
  port = await server.listen(0);
});
after(async () => { await server.close(); });

function request(method, host, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host, port, method, path: urlPath, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const local = (m, p, o) => request(m, '127.0.0.1', p, o);

test('isLocalRequest accepts loopback, refuses LAN addresses, foreign Origin and foreign Host', () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: 'localhost:3000', ...headers } });
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLocalRequest(req(a)), true, a);
  assert.equal(isLocalRequest(req('192.168.1.20')), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { origin: 'https://evil.example' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { origin: 'http://localhost:3000' })), true);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'evil.example' })), false); // DNS rebinding
});

test('host routes answer 403 when requested through the LAN address', { skip: !lanAddresses()[0] && 'no LAN address on this machine' }, async () => {
  for (const [m, p] of [['GET', '/api/host/settings'], ['POST', '/api/host/settings'], ['POST', '/api/host/start'], ['POST', '/api/host/next'], ['POST', '/api/host/again'], ['POST', '/api/host/remove'], ['POST', '/api/host/check'], ['POST', '/api/host/address']]) {
    const r = await request(m, lan, p, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(party.calls.some(([c]) => c === 'start' || c === 'next' || c === 'again' || c === 'remove'), false);
});

test('host routes also refuse a foreign Origin even from loopback', async () => {
  const r = await local('POST', '/api/host/start', { body: {}, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('settings never contain the unlock link, even right after saving it', async () => {
  const saved = await local('POST', '/api/host/settings', { body: { gameNumber: 3, unlockLink: LINK } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json().hasUnlockLink, true);
  assert.equal(saved.text.includes('SECRET123'), false);
  const got = await local('GET', '/api/host/settings');
  assert.equal(got.text.includes('SECRET123'), false);
  assert.equal(got.json().gameNumber, 3);
  assert.match(got.json().playUrl, /\/play$/);
  assert.ok(fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes('SECRET123')); // stored locally, only there
  const sse = await readSse('/api/events');
  assert.equal(sse.includes('SECRET123'), false);
  await local('POST', '/api/host/settings', { body: { gameNumber: 1, unlockLink: '' } });
});

test('settings refuse a bad link or game number with a friendly message', async () => {
  for (const body of [{ unlockLink: 'https://evil.example/unlock?session_id=x' }, { unlockLink: 'hello' }, { gameNumber: 0 }, { gameNumber: 'abc' }, { gameNumber: 1.5 }, { gameNumber: 100000 }]) {
    const r = await local('POST', '/api/host/settings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.json().message, 'string');
  }
  assert.throws(() => saveConfig({ unlockLink: 'nope' }), /unlock link/i);
});

test('config file is private (mode 0600) on non-Windows', { skip: process.platform === 'win32' }, () => {
  saveConfig({ gameNumber: 1 });
  assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
});

test('loadConfig falls back to defaults when the file is missing or corrupt', () => {
  fs.writeFileSync(path.join(home, 'config.json'), '{not json');
  assert.deepEqual(publicConfig(loadConfig()), { gameNumber: 1, port: 3000, hasUnlockLink: false });
  fs.rmSync(path.join(home, 'config.json'));
  assert.equal(loadConfig().maxPlayers, 8);
});

test('join validates input and surfaces friendly game errors', async () => {
  const ok = await local('POST', '/api/join', { body: { name: 'Sam' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json().token, 't1');
  const taken = await local('POST', '/api/join', { body: { name: 'taken' } });
  assert.equal(taken.status, 400);
  assert.match(taken.json().message, /taken/);
  assert.equal((await local('POST', '/api/join', { body: '{broken' })).status, 400);
  assert.equal((await local('POST', '/api/join', { body: { name: 'x'.repeat(2000) } })).status, 413);
  assert.equal((await local('POST', '/api/join', { body: { } })).status, 400);
});

test('answer validates the token and explains why an answer was refused', async () => {
  assert.equal((await local('POST', '/api/answer', { body: { token: 'nope', answer: 'x' } })).status, 401);
  assert.equal((await local('POST', '/api/answer', { body: { answer: 'x' } })).status, 401);
  assert.equal((await local('POST', '/api/answer', { body: '[]' })).status, 400);
  assert.equal((await local('POST', '/api/answer', { body: 'x'.repeat(2000) })).status, 413);
  const ok = await local('POST', '/api/answer', { body: { token: 't1', answer: 'ramen' } });
  assert.deepEqual(ok.json(), { ok: true });
  assert.deepEqual(party.calls.at(-1), ['answer', 'p1', 'ramen']);
  const late = await local('POST', '/api/answer', { body: { token: 't1', answer: 'late' } });
  assert.equal(late.status, 200);
  assert.equal(late.json().ok, false);
  assert.match(late.json().message, /closed|late/i);
  const before = party.calls.length;
  await local('POST', '/api/answer', { body: { token: 't1', answer: 42 } });
  assert.equal(party.calls.length, before); // non-string answers never reach the game
});

test('host actions call the party', async () => {
  for (const [p, call] of [['/api/host/start', 'start'], ['/api/host/next', 'next'], ['/api/host/again', 'again']]) {
    assert.equal((await local('POST', p, { body: {} })).status, 200);
    assert.equal(party.calls.at(-1)[0], call);
  }
  await local('POST', '/api/host/remove', { body: { id: 'p9' } });
  assert.deepEqual(party.calls.at(-1), ['remove', 'p9']);
});

test('Test setup runs the check only while in the lobby', async () => {
  const ok = await local('POST', '/api/host/check', { body: {} });
  assert.deepEqual(ok.json(), { ok: true, lines: ['✔ fine'] });
  party.phase = 'prompt';
  const busy = await local('POST', '/api/host/check', { body: {} });
  assert.equal(busy.json().ok, false);
  assert.match(busy.json().lines[0], /game/i);
  party.phase = 'lobby';
});

test('GET / serves the host page locally and sends the LAN to /play', { skip: !lanAddresses()[0] && 'no LAN address on this machine' }, async () => {
  const mine = await request('GET', 'localhost', '/');
  assert.match(mine.text, /host page/);
  const phone = await request('GET', lan, '/');
  assert.equal(phone.status, 302);
  assert.equal(phone.headers.location, '/play');
});

test('pages are served with utf-8, a CSP and no path traversal', async () => {
  const play = await local('GET', '/play');
  assert.match(play.headers['content-type'], /text\/html; charset=utf-8/);
  assert.match(play.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await local('GET', '/style.css')).headers['content-type'].startsWith('text/css'), true);
  for (const p of ['/..%2fpackage.json', '/%2e%2e/package.json', '/..\\package.json', '/nope.txt']) {
    assert.equal((await local('GET', p)).status, 404, p);
  }
});

test('/qr.svg is an SVG', async () => {
  const r = await local('GET', '/qr.svg');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /image\/svg\+xml/);
  assert.match(r.text, /<svg/);
});

// Opens the event stream, returns what arrived within a short window.
function readSse(urlPath, { onOpen } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      setTimeout(() => { onOpen?.(); }, 100);
      setTimeout(() => { req.destroy(); resolve(text); }, 400);
    });
    req.on('error', () => {});
  });
}

test('SSE sends a per-viewer snapshot at connect and again after broadcast', async () => {
  const text = await readSse('/api/events?token=t1', { onOpen: () => server.broadcast() });
  const events = text.split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5)));
  assert.ok(events.length >= 2, `got ${events.length} events`);
  assert.equal(events[0].you.id, 'p1');
  const anon = await readSse('/api/events');
  assert.equal(JSON.parse(anon.split('\n\n').find((b) => b.startsWith('data:')).slice(5)).you, null);
});

test('the host can pick which network address the QR code points at', async () => {
  let chosen = '192.168.1.5';
  const second = createServer({
    party,
    getConfig: loadConfig,
    saveConfig,
    runCheck: async () => ({ ok: true, lines: [] }),
    lan: () => chosen,
    addresses: () => ['192.168.1.5', '10.0.0.4'],
    setLan: (ip) => { chosen = ip; },
    publicDir,
  });
  const p = await second.listen(0);
  const call = (method, route, body) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: p, method, path: route, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  try {
    const before = await call('GET', '/api/host/settings');
    assert.equal(before.json.playUrl, `http://192.168.1.5:${p}/play`);
    assert.deepEqual(before.json.addresses, ['192.168.1.5', '10.0.0.4']);
    const picked = await call('POST', '/api/host/address', { address: '10.0.0.4' });
    assert.equal(picked.status, 200);
    assert.equal(picked.json.playUrl, `http://10.0.0.4:${p}/play`);
    const refused = await call('POST', '/api/host/address', { address: '8.8.8.8' });
    assert.equal(refused.status, 400);
    assert.equal(chosen, '10.0.0.4'); // an address that isn't this computer's is never accepted
  } finally { await second.close(); }
});
