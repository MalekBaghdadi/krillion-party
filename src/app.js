// Wires everything together and starts the server. index.js is just the command-line wrapper.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, saveConfig } from './config.js';
import { createGame } from './game.js';
import { launchBrowser } from './krillion.js';
import { lanAddresses, routedAddress } from './net.js';
import { createParty } from './party.js';
import { createPool } from './pool.js';
import { createServer } from './server.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

async function listenWithFallback(server, first) {
  for (let port = first; port <= first + 10; port += 1) {
    try { return await server.listen(port); } catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  throw new Error(`Ports ${first} to ${first + 10} are all in use. Close other programs and try again.`);
}

const rankedAddresses = async () => lanAddresses({ routed: await routedAddress() });

export async function startApp({ open = true, launch = launchBrowser, getAddresses = rankedAddresses } = {}) {
  const config = loadConfig();
  const game = createGame({ maxPlayers: config.maxPlayers });
  const debugDir = path.join(homeDir(), 'debug');

  // Chrome is only launched when it is first needed, so the app starts (and can explain a
  // missing Chrome on screen) even if it isn't installed.
  let browser = null;
  const getBrowser = async () => {
    if (!browser?.isConnected()) browser = await launch({ headless: true });
    return browser;
  };
  const makePool = async () => createPool({
    browser: await getBrowser(),
    config: loadConfig(),
    openOptions: { debugDir },
    log: (line) => console.error(`[krillion] ${line}`), // technical detail stays in the terminal, off the TV
  });

  // Which address the QR code points at: the best guess, unless the host picked another one.
  // Re-checked every few seconds because Wi-Fi can connect after the app starts.
  let addresses = await getAddresses();
  let chosen = null;
  const refresh = setInterval(async () => { try { addresses = await getAddresses(); } catch { /* keep the last list */ } }, 5000);
  refresh.unref();
  const currentLan = () => (chosen && addresses.includes(chosen) ? chosen : addresses[0] ?? null);

  let server;
  const party = createParty({ game, getPool: makePool, emit: () => server?.broadcast() });
  server = createServer({
    party,
    getConfig: loadConfig,
    saveConfig,
    runCheck: async () => {
      try { return await (await makePool()).check(); } catch (err) { return { ok: false, lines: [`✘ ${err.message}`] }; }
    },
    lan: currentLan,
    addresses: () => addresses,
    setLan: (ip) => { chosen = ip; },
    publicDir,
  });

  const port = await listenWithFallback(server, config.port);
  const hostUrl = `http://127.0.0.1:${port}`; // the host page only works through a loopback address
  if (open) openInBrowser(hostUrl);

  return {
    port,
    hostUrl,
    playUrl: server.playUrl(),
    party,
    async stop() {
      clearInterval(refresh);
      await party.stop();
      await server.close();
      await browser?.close().catch(() => {});
    },
  };
}
