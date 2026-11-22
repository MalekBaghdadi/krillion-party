import dgram from 'node:dgram';
import os from 'node:os';

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Adapters that phones on the Wi-Fi can't reach: VMs, containers, VPNs, AirDrop and friends.
const VIRTUAL = /(virtual|vmware|vmnet|vmenet|vbox|hyper-v|vethernet|docker|veth|wsl|utun|tun\d|tap\d|tailscale|zerotier|bridge|awdl|llw|loopback|pseudo)/i;

// This computer's IPv4 addresses, best guess for "the one phones should use" first:
// real adapters before virtual ones, then the address the computer actually routes through,
// then home-style private ranges before public ones.
export function lanAddresses({ interfaces = os.networkInterfaces(), routed = null } = {}) {
  const rows = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const i of list ?? []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.')) rows.push({ name, address: i.address });
    }
  }
  const score = (r) => (VIRTUAL.test(r.name) ? 4 : 0) + (r.address === routed ? 0 : 2) + (PRIVATE.test(r.address) ? 0 : 1);
  return [...new Set(rows.sort((a, b) => score(a) - score(b)).map((r) => r.address))];
}

// Which local address the computer would use to reach the internet. A UDP "connect" only asks
// the operating system to pick a route: no packet is sent.
export function routedAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (value) => { try { socket.close(); } catch { /* already closed */ } resolve(value); };
    socket.once('error', () => finish(null));
    try {
      socket.connect(53, '8.8.8.8', () => {
        try { finish(socket.address().address); } catch { finish(null); }
      });
    } catch { finish(null); }
    setTimeout(() => finish(null), 1000).unref();
  });
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
