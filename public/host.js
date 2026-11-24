// The host / TV page. Like the phone page it only updates text, so nothing flickers.
import { $, el, fillBoard, postJson, ranked, tierBadge } from '/common.js';

const SECTIONS = { lobby: 'lobby', starting: 'starting', prompt: 'prompt', reveal: 'reveal', finished: 'finished' };
let snap = null;
let settings = null;
let busy = false;
let lastPhase = null;
let toastTimer = null;
let shownPlayUrl = null;
let streaming = false;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 7000);
}

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => { $('banner').classList.add('hidden'); loadSettings(); };
  source.onerror = () => $('banner').classList.remove('hidden');
  source.onmessage = (e) => { snap = JSON.parse(e.data); render(); };
}

async function loadSettings() {
  try {
    settings = await (await fetch('/api/host/settings')).json();
  } catch { return; }
  $('playUrl').textContent = settings.playUrl.replace(/^http:\/\//, '');
  if (settings.playUrl !== shownPlayUrl) { // only reload the QR when the address really changed
    shownPlayUrl = settings.playUrl;
    $('qr').src = `/qr.svg?${Date.now()}`;
  }
  $('otherAddresses').classList.toggle('hidden', settings.addresses.length < 2);
  $('addressButtons').replaceChildren(...settings.addresses.map((ip) => {
    const pick = el('button', 'btn secondary small addr', ip);
    pick.type = 'button';
    pick.setAttribute('aria-pressed', String(ip === settings.address));
    pick.addEventListener('click', async () => { await postJson('/api/host/address', { address: ip }); loadSettings(); });
    return pick;
  }));
  $('noWifi').classList.toggle('hidden', settings.addresses.length > 0);
  $('gameLabel').textContent = `Game ${settings.gameNumber}`;
  $('linkStatus').textContent = settings.hasUnlockLink ? '✔ Unlock link saved' : 'No unlock link saved';
  $('linkStatus').className = `status ${settings.hasUnlockLink ? 'good' : ''}`.trim();
  if (!$('settings').open) $('gameNumber').value = settings.gameNumber;
}

const nameSpan = (name) => { const n = el('span', 'nm', name); n.setAttribute('dir', 'auto'); return n; };

// The real Krillion page, live, while a question is on. Streams only while it is on screen, and
// the page falls back to its simple layout whenever the server says the big screen isn't there.
function renderScreen() {
  const on = Boolean(snap.tv) && (snap.phase === 'prompt' || snap.phase === 'reveal');
  $('stage').classList.toggle('has-tv', on);
  $('tvScreen').classList.toggle('hidden', !on);
  if (on && !streaming) {
    streaming = true;
    $('tvStream').src = `/tv.mjpeg?${Date.now()}`;
  } else if (!on && streaming) {
    streaming = false;
    $('tvStream').removeAttribute('src');
  }
}
// If the video connection drops (say the app restarted), pick it up again.
$('tvStream').addEventListener('error', () => {
  if (!streaming) return;
  setTimeout(() => { if (streaming) $('tvStream').src = `/tv.mjpeg?${Date.now()}`; }, 1000);
});

function render() {
  for (const [phase, id] of Object.entries(SECTIONS)) $(id).classList.toggle('hidden', snap.phase !== phase);
  renderScreen();
  $('notice').textContent = snap.notice ?? '';
  $('notice').classList.toggle('hidden', !snap.notice);
  ({ lobby: renderLobby, starting: renderStarting, prompt: renderPrompt, reveal: renderReveal, finished: renderFinished }[snap.phase])();
  if (snap.phase !== lastPhase) { // new screen: put the main button under the space bar
    lastPhase = snap.phase;
    const main = { lobby: 'start', reveal: 'next', finished: 'again' }[snap.phase];
    if (main && (document.activeElement === document.body || !document.activeElement)) $(main).focus({ preventScroll: true });
  }
}

function renderLobby() {
  const n = snap.players.length;
  $('playerCount').textContent = n ? `(${n})` : '';
  $('lobbyHint').classList.toggle('hidden', n > 0);
  $('start').disabled = n === 0 || busy;
  $('lobbyPlayers').replaceChildren(...snap.players.map((p) => {
    const chip = el('li', 'chip');
    const remove = el('button', 'x', '✕');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${p.name}`);
    remove.addEventListener('click', () => postJson('/api/host/remove', { id: p.id }));
    chip.append(nameSpan(p.name), remove);
    return chip;
  }));
}

function renderStarting() {
  const n = snap.players.length;
  $('startingCount').textContent = `${n} ${n === 1 ? 'player' : 'players'}`;
}

function renderPrompt() {
  const { prompt } = snap;
  $('hostQ').textContent = `Question ${prompt.index + 1} of ${prompt.total}`;
  $('hostPrompt').textContent = prompt.text;
  const t = snap.timeLeft;
  $('hostTimer').textContent = typeof t === 'number' ? String(t) : '–';
  $('hostTimer').classList.toggle('low', typeof t === 'number' && t <= 5);
  $('hostChips').replaceChildren(...snap.players.map((p) => {
    const chip = el('li', `chip${p.locked ? ' locked' : ''}${p.errored ? ' errored' : ''}`);
    chip.append(nameSpan(p.name));
    if (p.locked) chip.append(el('span', 'tick', ' ✓'));
    return chip;
  }));
  const live = snap.players.filter((p) => !p.errored);
  $('hostLocked').textContent = `${live.filter((p) => p.locked).length} of ${live.length} locked in`;
}

function renderReveal() {
  const { reveal, prompt } = snap;
  const winner = snap.players.find((p) => p.id === reveal.winnerId);
  const flash = $('hostFlash');
  flash.replaceChildren();
  if (winner) flash.append('⚡ ', nameSpan(winner.name), ' was first!');
  else flash.append('Nobody landed an answer this time.');

  const entries = [...reveal.entries].sort((a, b) => (b.points ?? -1) - (a.points ?? -1));
  $('hostTable').tBodies[0].replaceChildren(...entries.map((e) => {
    const row = el('tr', e.playerId === reveal.winnerId ? 'winner' : '');
    const player = el('td'); player.append(nameSpan(e.name));
    const answer = el('td', '', e.status === 'accepted' ? `“${e.answer}”` : '—');
    answer.setAttribute('dir', 'auto');
    const rarity = el('td');
    if (e.status === 'accepted') rarity.append(tierBadge(e));
    else rarity.textContent = e.status === 'error' ? 'had a problem' : 'no answer';
    row.append(player, answer, rarity, el('td', 'pts', e.status === 'accepted' ? `+${e.points}` : '0'));
    return row;
  }));
  fillBoard($('hostBoard'), snap.players);
  const last = prompt.index + 1 >= prompt.total;
  $('next').textContent = last ? 'Final results ▶' : 'Next question ▶';
  $('next').disabled = busy;
}

function renderFinished() {
  const order = ranked(snap.players);
  const medals = ['🥇', '🥈', '🥉'];
  $('podium').replaceChildren(...order.slice(0, 3).map((p, i) => {
    const place = el('div', `place p${i + 1}`);
    place.append(el('div', 'medal', medals[i]), nameSpan(p.name), el('div', 'pts', `${p.score} pts`), el('div', 'wins', p.raceWins ? `⚡ ${p.raceWins} first${p.raceWins === 1 ? '' : 's'}` : ''));
    return place;
  }));
  fillBoard($('finalBoard'), snap.players);
  $('again').disabled = busy;
}

async function act(route, button) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try {
    const { ok, data } = await postJson(route);
    if (!ok) toast(data.message || 'Something went wrong. Please try again.');
  } catch {
    toast("Couldn't reach the game. Is the Krillion Party window still open?");
  } finally {
    busy = false;
    if (snap) render();
  }
}

$('start').addEventListener('click', () => act('/api/host/start', $('start')));
$('next').addEventListener('click', () => act('/api/host/next', $('next')));
$('again').addEventListener('click', () => act('/api/host/again', $('again')));

// Space or Enter drives the main button when nothing else is focused (a focused button handles its own keys).
document.addEventListener('keydown', (e) => {
  if ((e.key !== ' ' && e.key !== 'Enter') || !snap || $('settings').open) return;
  if (e.target.closest?.('button, input, textarea, select, a, dialog')) return;
  const main = $({ lobby: 'start', reveal: 'next', finished: 'again' }[snap.phase] ?? 'toast');
  if (main && main.tagName === 'BUTTON' && !main.disabled) { e.preventDefault(); main.click(); }
});

$('check').addEventListener('click', async () => {
  const out = $('checkResult');
  $('check').disabled = true;
  out.replaceChildren(el('li', 'muted', 'Testing… this takes about 10 seconds.'));
  try {
    const { data } = await postJson('/api/host/check');
    out.replaceChildren(...(data.lines ?? [data.message ?? 'The test could not run.']).map((line) => el('li', line.startsWith('✔') ? 'ok' : 'bad', line)));
  } catch {
    out.replaceChildren(el('li', 'bad', "✘ Couldn't reach the game. Is the Krillion Party window still open?"));
  } finally {
    $('check').disabled = false;
  }
});

$('openSettings').addEventListener('click', () => {
  $('settingsError').textContent = '';
  if (settings) $('gameNumber').value = settings.gameNumber;
  $('settings').showModal();
});
$('closeSettings').addEventListener('click', () => $('settings').close());

async function saveSettings(patch) {
  $('settingsError').textContent = '';
  const { ok, data } = await postJson('/api/host/settings', patch);
  if (!ok) { $('settingsError').textContent = data.message || 'Could not save. Please try again.'; return; }
  settings = data;
  $('unlockLink').value = ''; // the link is never shown again once saved
  await loadSettings();
}

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const patch = { gameNumber: Number($('gameNumber').value) };
  const link = $('unlockLink').value.trim();
  if (link) patch.unlockLink = link;
  saveSettings(patch);
});
$('removeLink').addEventListener('click', () => saveSettings({ unlockLink: '' }));

// Wi-Fi can come and go while the app is open: keep the address fresh while waiting in the lobby.
setInterval(() => { if (snap?.phase === 'lobby' && !document.hidden) loadSettings(); }, 5000);

connect();
