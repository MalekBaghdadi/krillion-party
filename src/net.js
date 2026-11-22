import os from 'node:os';

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// This computer's IPv4 addresses on the local network, home-style (private) ranges first.
export function lanAddresses() {
  const all = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
  return [...new Set(all)].sort((a, b) => Number(PRIVATE.test(b)) - Number(PRIVATE.test(a)));
}

const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// True only for the host computer itself, asked through a loopback name. The Host/Origin checks
// stop a web page (or a DNS-rebinding trick) from driving the host controls from the same machine.
export function isLocalRequest(req) {
  if (!LOOPBACK_ADDR.has(req.socket?.remoteAddress)) return false;
  const host = String(req.headers?.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!LOOPBACK_NAMES.has(host)) return false;
  const origin = req.headers?.origin;
  if (origin) {
    try { if (!LOOPBACK_NAMES.has(new URL(origin).hostname)) return false; } catch { return false; }
  }
  return true;
}
