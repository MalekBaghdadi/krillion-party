// A tiny stand-in for krillion.io that reproduces the real page's selectors and behaviour
// (see docs/krillion-dom.md), so every test can run offline and fast.
import http from 'node:http';

export const DEFAULT_PROMPTS = [
  'Name a noodle dish', 'Name a species of great ape', 'Name a character from Stranger Things',
  'Name a hot drink', 'Name a variety of wine', 'Name an interjection or exclamation',
  'Name a country with a coastline',
];

export const DEFAULT_ACCEPTED = {
  ramen: { tier: 'PLANKTON', points: 10, flavor: 'The answer everyone blurts out.' },
  pho: { tier: 'RARE', points: 60, flavor: 'Now we are talking.' },
  champon: { tier: 'ONE IN A KRILLION', points: 100, flavor: 'Absolutely unhinged. Respect.' },
};

export async function startFake(opts = {}) {
  const cfg = {
    prompts: opts.prompts ?? DEFAULT_PROMPTS,
    accepted: opts.accepted ?? DEFAULT_ACCEPTED,
    timerSeconds: opts.timerSeconds ?? 25,
    unlockToken: opts.unlockToken ?? 'cs_test',
    broken: Boolean(opts.broken),
  };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://fake');
    const page = { '/unlimited/classic': gamePage, '/restore': restorePage, '/unlock': unlockPage }[pathname];
    if (!page) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(cfg));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function gamePage(cfg) {
  return `<!doctype html><meta charset="utf-8"><title>Krillion fake</title>
<div id="app"></div>
<script>
const CFG = ${json(cfg)};
const game = Number(new URLSearchParams(location.search).get('game') || 1);
const app = document.getElementById('app');
const total = CFG.prompts.length;
let idx = 0, score = 0, left = 0, timer = null, resolved = false;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hud = () => '<div class="ds-hud"><div class="ds-pod ds-px ds-score-pod"><div class="label">SCORE</div><div class="ds-score-num">' + score + '</div></div></div>';

function home() {
  if (game > 1 && localStorage.getItem('unlocked') !== '1') {
    app.innerHTML = '<div class="lock">UNLOCK UNLIMITED · $5</div><p>one time. access to unlimited mode.</p>';
    return;
  }
  app.innerHTML = hud() + '<button class="ds-begin-btn" type="button">▼ BEGIN DESCENT ▼</button>';
  app.querySelector('.ds-begin-btn').onclick = () => { idx = 0; score = 0; showPrompt(); };
}

function showPrompt() {
  resolved = false; left = CFG.timerSeconds;
  const input = CFG.broken
    ? '<div class="no-input"></div>'
    : '<form id="f"><input class="ds-input" type="text" placeholder="type one answer…" autocomplete="off"><button type="submit">DIVE</button></form>';
  app.innerHTML = hud() +
    '<div class="ds-prompt-count">PROMPT ' + (idx + 1) + ' OF ' + total + '</div>' +
    '<div class="prompt">' + esc(CFG.prompts[idx]) + '</div>' +
    '<div class="ds-dock-inner"><div class="ds-sonar-wrap"><div class="ds-time-digits">' + left + '</div></div>' + input + '<div id="toast"></div></div>';
  const form = document.getElementById('f');
  if (form) form.onsubmit = (e) => { e.preventDefault(); submit(form.querySelector('input').value.trim()); };
  clearInterval(timer);
  timer = setInterval(() => {
    if (resolved) return;
    left -= 1;
    const d = document.querySelector('.ds-time-digits'); if (d) d.textContent = String(Math.max(left, 0));
    if (left <= 0) { resolved = true; clearInterval(timer); showTimeout(); }
  }, 1000);
}

function submit(raw) {
  if (!raw || resolved) return;
  const hit = CFG.accepted[raw.toLowerCase()];
  if (!hit) { document.getElementById('toast').textContent = '"' + raw + '": no echo. try again'; return; }
  resolved = true; clearInterval(timer);
  setTimeout(() => showAccepted(raw, hit), 300);
}

// While a card is up the real page already shows the NEXT prompt number.
const nextLabel = () => '<div class="ds-prompt-count">PROMPT ' + Math.min(idx + 2, total) + ' OF ' + total + '</div>';
const nextBtn = () => '<div class="ds-next-wrap"><button class="ds-next-btn" type="button">' + (idx + 1 >= total ? 'SURFACE ▲' : 'DESCEND ▼') + '</button></div>';

function showAccepted(raw, hit) {
  score += hit.points;
  const shown = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  app.innerHTML = hud() + nextLabel() +
    '<div class="tag"><div class="tname">' + hit.tier + '</div><div class="tans">“' + esc(shown) + '”</div>' +
    '<div class="tpts"><b>+' + hit.points + ' PTS</b> · sink 100m</div><div class="tsub">' + esc(hit.flavor || '') + '</div></div>' + nextBtn();
  wireNext();
}

// The real page reuses the accepted card for a timeout: same classes, tier text "NOTHING LANDED".
function showTimeout() {
  app.innerHTML = hud() + nextLabel() +
    '<div class="tag"><div class="tname">NOTHING LANDED</div><div class="tans">—</div>' +
    '<div class="tpts"><b>+0 PTS</b></div><div class="tsub">the clock beat you to it.</div></div>' + nextBtn();
  wireNext();
}

function wireNext() {
  app.querySelector('.ds-next-btn').onclick = () => {
    if (idx + 1 >= total) {
      app.innerHTML = hud() + '<div class="summary">SURFACED</div><button class="ds-again" type="button">PLAY THIS ONE AGAIN ↻</button>';
      return;
    }
    idx += 1; showPrompt();
  };
}

home();
</script>`;
}

function restorePage(cfg) {
  return `<!doctype html><meta charset="utf-8"><title>Restore</title>
<h1>RESTORE THE ENDLESS DIVE</h1>
<form id="f"><input type="text" placeholder="https://krillion.io/unlock?session_id=cs_..."><button type="submit">RE-ARM WITH LINK</button></form>
<p id="msg"></p>
<script>
const TOKEN = ${json(cfg.unlockToken)};
document.getElementById('f').onsubmit = (e) => {
  e.preventDefault();
  const v = e.target.querySelector('input').value;
  if (v.includes('session_id=' + TOKEN)) { localStorage.setItem('unlocked', '1'); location.href = '/unlimited/classic'; }
  else document.getElementById('msg').textContent = "that link didn't work";
};
</script>`;
}

function unlockPage(cfg) {
  return `<!doctype html><meta charset="utf-8"><title>Unlock</title><p id="msg"></p>
<script>
const ok = new URLSearchParams(location.search).get('session_id') === ${json(cfg.unlockToken)};
if (ok) { localStorage.setItem('unlocked', '1'); location.href = '/unlimited/classic'; }
else document.getElementById('msg').textContent = "that link didn't work";
</script>`;
}
