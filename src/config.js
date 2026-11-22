// Settings saved on the host's computer. The unlock link is a purchase token, so it lives only in
// this file (owner-only permissions) and is never returned by publicConfig().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const homeDir = () => process.env.KRILLION_PARTY_HOME || path.join(os.homedir(), '.krillion-party');
const file = () => path.join(homeDir(), 'config.json');

const DEFAULTS = { gameNumber: 1, unlockLink: '', port: 3000, maxPlayers: 8 };
const LINK_SHAPE = /^https:\/\/krillion\.io\/unlock\?\S*session_id=\S+$/;

export function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return {
      gameNumber: Number.isInteger(saved.gameNumber) && saved.gameNumber >= 1 ? saved.gameNumber : DEFAULTS.gameNumber,
      unlockLink: typeof saved.unlockLink === 'string' ? saved.unlockLink : '',
      port: Number.isInteger(saved.port) ? saved.port : DEFAULTS.port,
      maxPlayers: Number.isInteger(saved.maxPlayers) && saved.maxPlayers >= 1 ? saved.maxPlayers : DEFAULTS.maxPlayers,
    };
  } catch {
    return { ...DEFAULTS }; // missing or corrupt file: start fresh
  }
}

// Only gameNumber and unlockLink can be changed from the app. `undefined` means "leave as is".
export function saveConfig(patch) {
  const next = loadConfig();
  if (patch.gameNumber !== undefined) {
    const n = Number(patch.gameNumber);
    if (!Number.isInteger(n) || n < 1 || n > 99999) throw new Error('The game number must be a whole number from 1 to 99999.');
    next.gameNumber = n;
  }
  if (patch.unlockLink !== undefined) {
    const link = String(patch.unlockLink).trim();
    if (link && (link.length > 600 || !LINK_SHAPE.test(link))) {
      throw new Error("That doesn't look like a Krillion unlock link. It should start with https://krillion.io/unlock?session_id=");
    }
    next.unlockLink = link;
  }
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file(), 0o600); } catch { /* not supported on Windows */ }
  return next;
}

export const publicConfig = (cfg) => ({ gameNumber: cfg.gameNumber, port: cfg.port, hasUnlockLink: Boolean(cfg.unlockLink) });
