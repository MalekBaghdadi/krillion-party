// The whole app (game, party, server, real pages) wired to a fake Krillion, for browser tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KRILLION_PARTY_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), 'kp-home-')); // before config.js is read
const { loadConfig, saveConfig } = await import('../src/config.js');
const { createGame } = await import('../src/game.js');
const { createPool } = await import('../src/pool.js');
const { createParty } = await import('../src/party.js');
const { createServer } = await import('../src/server.js');
const { startFake } = await import('./fake-krillion.js');

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function startStack({ browser, fakeOpts = {}, config = {} } = {}) {
  const fake = await startFake(fakeOpts);
  const cfg = () => ({ ...loadConfig(), ...config });
  const openOptions = { baseUrl: fake.url, stepTimeoutMs: 4000 };
  const game = createGame();
  let server;
  const party = createParty({
    game,
    getPool: async () => createPool({ browser, config: cfg(), openOptions }),
    emit: () => server?.broadcast(),
    pollMs: 200,
  });
  server = createServer({
    party,
    getConfig: cfg,
    saveConfig,
    runCheck: () => createPool({ browser, config: cfg(), openOptions }).check(),
    lan: null,
    publicDir,
  });
  const port = await server.listen(0);
  const url = `http://127.0.0.1:${port}`;
  // Host actions, as the host page would send them (loopback, no Origin).
  const host = async (route, body = {}) => (await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return {
    url, host, party, fake,
    async close() { await party.stop(); await server.close(); await fake.close(); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(30); }
  throw new Error('timed out waiting for condition');
}
