// The small web server on the host's computer: phone page, host page, QR code and a JSON API.
// Phones can join and answer; everything that controls the game or reads settings is host-only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { GameError } from './game.js';
import { publicConfig } from './config.js';
import { isLocalRequest, lanAddresses } from './net.js';

const MAX_BODY = 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const REFUSED = {
  closed: 'Too late: this question is closed.',
  busy: 'Hold on, your last answer is still being checked.',
  resolved: 'You already locked in an answer for this question.',
  'too-many': 'No more tries on this question.',
  invalid: 'Type an answer first (up to 60 characters).',
  repeat: 'You already tried that one. Try something different!',
  error: 'Something went wrong. Please try again.',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
    else if (size > 64 * 1024) req.destroy(); // keep draining small overruns so the client gets a clean 413
  }
  if (size > MAX_BODY) throw new HttpError(413, 'That message was too big.');
  if (size === 0) return {};
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'That did not look right. Please try again.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'That did not look right. Please try again.');
  return data;
}

export function createServer({ party, getConfig, saveConfig, runCheck, lan, publicDir }) {
  let port = 0;
  const clients = new Set(); // open event streams: {res, token}
  let pingTimer = null;
  let checking = false;

  const playUrl = () => `http://${lan ?? 'localhost'}:${port}/play`;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(body);
  };
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });

  function sendFile(res, name) {
    const file = path.join(publicDir, name);
    let data;
    try { data = fs.readFileSync(file); } catch { return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' }); }
    const type = TYPES[path.extname(name)] ?? 'application/octet-stream';
    return send(res, 200, data, { 'content-type': type, ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}) });
  }

  function snapshotFor(client) {
    const viewerId = client.token ? party.playerByToken(client.token)?.id : undefined;
    return `data: ${JSON.stringify(party.snapshot(viewerId))}\n\n`;
  }

  function broadcast() {
    for (const client of clients) {
      try { client.res.write(snapshotFor(client)); } catch { clients.delete(client); }
    }
  }

  function events(req, res, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const client = { res, token: url.searchParams.get('token') || null };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    res.write(`retry: 1000\n\n${snapshotFor(client)}`);
  }

  async function host(req, res, url) {
    if (!isLocalRequest(req)) return sendJson(res, 403, { message: 'Only the host computer can do that.' });
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/host/settings') {
      return sendJson(res, 200, { ...publicConfig(getConfig()), playUrl: playUrl(), addresses: lanAddresses() });
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    switch (route) {
      case 'POST /api/host/settings': {
        let saved;
        try { saved = saveConfig({ gameNumber: body.gameNumber, unlockLink: body.unlockLink }); } catch (err) { throw new HttpError(400, err.message); }
        return sendJson(res, 200, { ...publicConfig(saved), playUrl: playUrl(), addresses: lanAddresses() });
      }
      case 'POST /api/host/start':
        await party.start();
        return sendJson(res, 200, { ok: true });
      case 'POST /api/host/next':
        await party.next();
        return sendJson(res, 200, { ok: true });
      case 'POST /api/host/again':
        await party.again();
        return sendJson(res, 200, { ok: true });
      case 'POST /api/host/remove':
        if (typeof body.id === 'string') party.remove(body.id);
        return sendJson(res, 200, { ok: true });
      case 'POST /api/host/check': {
        if (party.snapshot().phase !== 'lobby') return sendJson(res, 200, { ok: false, lines: ['✘ Finish or end the current game first, then run Test setup.'] });
        if (checking) return sendJson(res, 200, { ok: false, lines: ['✘ A test is already running. Please wait a moment.'] });
        checking = true;
        try { return sendJson(res, 200, await runCheck()); } finally { checking = false; }
      }
      default:
        return sendJson(res, 404, { message: 'Not found' });
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/') {
      if (!isLocalRequest(req)) return send(res, 302, '', { location: '/play' });
      return sendFile(res, 'index.html');
    }
    if (req.method === 'GET' && pathname === '/play') return sendFile(res, 'play.html');
    if (req.method === 'GET' && pathname === '/qr.svg') {
      const svg = await QRCode.toString(playUrl(), { type: 'svg', margin: 1, width: 360 });
      return send(res, 200, svg, { 'content-type': 'image/svg+xml' });
    }
    if (req.method === 'GET' && pathname === '/api/events') return events(req, res, url);

    if (pathname.startsWith('/api/host/')) return host(req, res, url);

    if (req.method === 'POST' && pathname === '/api/join') {
      const body = await readJson(req);
      if (typeof body.name !== 'string') throw new HttpError(400, 'Please type your name.');
      try {
        const { token } = party.join(body.name);
        return sendJson(res, 200, { token });
      } catch (err) {
        if (err instanceof GameError) throw new HttpError(400, err.message);
        throw err;
      }
    }

    if (req.method === 'POST' && pathname === '/api/answer') {
      const body = await readJson(req);
      const player = typeof body.token === 'string' ? party.playerByToken(body.token) : null;
      if (!player) throw new HttpError(401, 'Please rejoin the game.');
      if (typeof body.answer !== 'string') throw new HttpError(400, 'Type an answer first.');
      const result = await party.answer(player.id, body.answer);
      return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, message: REFUSED[result.reason] ?? REFUSED.error });
    }

    if (req.method === 'GET' && /^\/[A-Za-z0-9._-]+$/.test(pathname)) return sendFile(res, pathname.slice(1));
    return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, message: err.message });
      return sendJson(res, 500, { ok: false, message: 'Something went wrong. Please try again.' }); // never echo internals or request bodies
    });
  });

  return {
    listen(wanted) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted, '0.0.0.0', () => {
          port = server.address().port;
          pingTimer = setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { clients.delete(c); } } }, 15000);
          pingTimer.unref();
          resolve(port);
        });
      });
    },
    broadcast,
    playUrl,
    close() {
      clearInterval(pingTimer);
      for (const c of clients) c.res.end();
      clients.clear();
      return new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    },
  };
}
