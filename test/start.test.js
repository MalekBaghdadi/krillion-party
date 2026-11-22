import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-start-home-'));
process.env.KRILLION_PARTY_HOME = home;
const { startApp } = await import('../src/app.js');
const { KrillionError } = await import('../src/krillion.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const setPort = (port) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port }));
const post = async (url, route, body = {}) => (await fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

test('startApp serves the host page and API on the configured port', async () => {
  const port = await freePort();
  setPort(port);
  const app = await startApp({ open: false });
  try {
    assert.equal(app.port, port);
    assert.match(app.hostUrl, new RegExp(`^http://127\\.0\\.0\\.1:${port}$`));
    assert.match(await (await fetch(app.hostUrl)).text(), /Krillion Party/);
    assert.equal((await (await fetch(`${app.hostUrl}/api/host/settings`)).json()).gameNumber, 1);
  } finally { await app.stop(); }
});

test('falls back to the next port when the first is busy', async () => {
  const port = await freePort();
  const squatter = net.createServer().listen(port, '0.0.0.0');
  await new Promise((r) => squatter.once('listening', r));
  setPort(port);
  const app = await startApp({ open: false });
  try {
    assert.equal(app.port > port && app.port <= port + 10, true, `got ${app.port}`);
  } finally { await app.stop(); squatter.close(); }
});

test('stop() shuts the server down', async () => {
  setPort(await freePort());
  const app = await startApp({ open: false });
  await app.stop();
  await assert.rejects(fetch(app.hostUrl));
});

test('a missing Chrome gives a friendly notice and the game stays in the lobby', async () => {
  setPort(await freePort());
  const launch = async () => { throw new KrillionError('NO_BROWSER', 'Google Chrome was not found on this computer. Please install Chrome (google.com/chrome) and start again.'); };
  const app = await startApp({ open: false, launch });
  try {
    await post(app.hostUrl, '/api/join', { name: 'Ann' });
    await post(app.hostUrl, '/api/host/start');
    const check = await post(app.hostUrl, '/api/host/check');
    assert.equal(check.ok, false);
    assert.match(check.lines[0], /Chrome/);
    const snapshot = await new Promise((resolve) => {
      fetch(`${app.hostUrl}/api/events`).then(async (res) => {
        const reader = res.body.getReader();
        let text = '';
        for (;;) {
          const { value } = await reader.read();
          text += Buffer.from(value).toString();
          const m = /data: (.*)\n\n/.exec(text);
          if (m) { reader.cancel(); resolve(JSON.parse(m[1])); return; }
        }
      });
    });
    assert.equal(snapshot.phase, 'lobby');
    assert.match(snapshot.notice, /Chrome/);
    assert.equal(snapshot.players.length, 1);
  } finally { await app.stop(); }
});

test('run as a program it prints where to connect', async () => {
  const port = await freePort();
  setPort(port);
  const child = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    env: { ...process.env, KRILLION_PARTY_HOME: home, KRILLION_PARTY_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  try {
    const deadline = Date.now() + 15000;
    while (!/Host screen: .*\n/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, new RegExp(`Host screen: http://127\\.0\\.0\\.1:${port}`));
    assert.match(out, /Phones join at: http:\/\/\S+\/play/);
    assert.match(out, /Ctrl\+C/);
    assert.equal(/[^\x00-\x7F]/.test(out), false, 'Windows consoles show non-ASCII characters as junk');
  } finally { child.kill(); }
});

test('the Mac launcher has a shebang and LF endings; the Windows one has CRLF', () => {
  const mac = fs.readFileSync(path.join(root, 'Start Krillion Party.command'), 'utf8');
  assert.match(mac, /^#!\/bin\/bash\n/);
  assert.equal(mac.includes('\r'), false);
  const win = fs.readFileSync(path.join(root, 'Start Krillion Party.bat'), 'utf8');
  assert.equal(win.split('\n').slice(0, -1).every((l) => l.endsWith('\r')), true);
});

test('package.json bin points at an executable-style script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bin = path.join(root, pkg.bin['krillion-party']);
  assert.equal(fs.existsSync(bin), true);
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.equal(pkg.engines.node, '>=18');
});

test('the phone address comes from the network ranking, can be switched by the host, and survives refreshes', async () => {
  setPort(await freePort());
  let list = ['10.9.8.7', '192.168.9.9'];
  const app = await startApp({ open: false, getAddresses: async () => list });
  try {
    assert.match(app.playUrl, /^http:\/\/10\.9\.8\.7:\d+\/play$/);
    const settings = async () => (await fetch(`${app.hostUrl}/api/host/settings`)).json();
    assert.deepEqual((await settings()).addresses, ['10.9.8.7', '192.168.9.9']);
    await post(app.hostUrl, '/api/host/address', { address: '192.168.9.9' });
    assert.match((await settings()).playUrl, /192\.168\.9\.9/);
    list = ['192.168.9.9']; // the network changed underneath us; the choice is still valid
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await settings()).address, '192.168.9.9');
  } finally { await app.stop(); }
});
