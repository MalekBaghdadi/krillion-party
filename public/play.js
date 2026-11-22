// The phone page. It builds nothing on each update: the screens exist in play.html and only their
// text changes, so the countdown ticking never wipes what someone is typing.
import { $, el, fillBoard, ordinal, postJson, ranked, tierBadge } from '/common.js';

const SCREENS = ['connecting', 'join', 'closed', 'lobby', 'starting', 'question', 'reveal', 'final'];
const show = (name) => SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== name));

let token = localStorage.getItem('kpToken');
let snap = null;
let source = null;
let sending = false;
let promptKey = null;
let suggestionKey = null;
let wasRemoved = false;
let flash = null; // a refusal from the server ("too late", "already tried that") until the player types again

function connect() {
  source?.close();
  source = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events');
  source.onopen = () => $('banner').classList.add('hidden');
  source.onerror = () => $('banner').classList.remove('hidden');
  source.onmessage = (e) => { snap = JSON.parse(e.data); render(); };
}

function forgetToken() {
  localStorage.removeItem('kpToken');
  token = null;
  connect();
}

function render() {
  if (token && !snap.you) { // our saved seat is gone: we were removed, or the host restarted the app
    wasRemoved = true;
    forgetToken();
    return;
  }
  if (!snap.you) {
    if (snap.phase === 'lobby') {
      show('join');
      $('joinNote').classList.toggle('hidden', !wasRemoved);
    } else {
      show('closed');
    }
    return;
  }
  if (snap.phase !== 'prompt') promptKey = null;
  ({ lobby: renderLobby, starting: () => show('starting'), prompt: renderQuestion, reveal: renderReveal, finished: renderFinal }[snap.phase] ?? (() => show('connecting')))();
}

function renderLobby() {
  show('lobby');
  $('meName').textContent = snap.you.name;
  $('lobbyChips').replaceChildren(...snap.players.map((p) => {
    const chip = el('li', p.id === snap.you.id ? 'chip me' : 'chip', p.name);
    chip.setAttribute('dir', 'auto');
    return chip;
  }));
}

function statusFor(you) {
  if (flash) return { text: flash, tone: 'bad' };
  switch (you.status) {
    case 'pending': return { text: 'Checking your answer…', tone: '' };
    case 'locked': return { text: `Locked in: “${you.answer}”. Waiting for the others…`, tone: 'good' };
    case 'timeout': return { text: "Time's up! The next question is coming.", tone: 'bad' };
    case 'error': return { text: "Your Krillion window had a problem. You'll be back on the next question.", tone: 'bad' };
    default:
      if (you.suggestion) { // Krillion's closest answer: the box already holds it, Send confirms
        return { text: `Did you mean “${you.suggestion.text}”? Tap Send to use it, or change it.`, tone: 'hint' };
      }
      if (you.rejected) {
        return you.attemptsLeft > 0
          ? { text: `“${you.rejected}” wasn’t recognised. Try another! (${you.attemptsLeft} ${you.attemptsLeft === 1 ? 'try' : 'tries'} left)`, tone: 'bad' }
          : { text: 'No tries left. Waiting for the clock…', tone: 'bad' };
      }
      return { text: 'Type one answer and press Send.', tone: '' };
  }
}

function renderQuestion() {
  show('question');
  const { prompt, you } = snap;
  $('qCount').textContent = `Question ${prompt.index + 1} of ${prompt.total}`;
  $('prompt').textContent = prompt.text;
  const t = snap.timeLeft;
  $('timer').textContent = typeof t === 'number' ? String(t) : '–';
  $('timer').classList.toggle('low', typeof t === 'number' && t <= 5);

  const key = `${prompt.index}:${prompt.text}`;
  if (key !== promptKey) { // a new question: start with an empty box
    promptKey = key;
    suggestionKey = null;
    flash = null;
    $('answer').value = '';
    if (you.status === 'idle') $('answer').focus({ preventScroll: true });
  }
  // A new suggestion: put it in the box (only if they haven't started typing something else).
  const s = you.suggestion;
  const sKey = s ? `${s.typed}>${s.text}` : null;
  if (sKey !== suggestionKey) {
    suggestionKey = sKey;
    if (s && $('answer').value.trim().toLowerCase() === s.typed.toLowerCase()) {
      $('answer').value = s.text;
      if (document.activeElement === $('answer')) $('answer').select();
    }
  }
  const canType = you.status === 'idle' && you.attemptsLeft > 0;
  $('answer').disabled = !canType;
  $('send').disabled = !canType || sending;

  const { text, tone } = statusFor(you);
  $('status').textContent = text;
  $('status').className = `status ${tone}`.trim();
  const live = snap.players.filter((p) => !p.errored);
  $('lockedCount').textContent = `${live.filter((p) => p.locked).length} of ${live.length} locked in`;
}

function rankLine() {
  const order = ranked(snap.players);
  const pos = order.findIndex((p) => p.id === snap.you.id) + 1;
  const me = order[pos - 1];
  return `You're ${ordinal(pos)} of ${order.length} with ${me.score} points.`;
}

function renderReveal() {
  show('reveal');
  const { reveal, you } = snap;
  const winner = snap.players.find((p) => p.id === reveal.winnerId);
  const banner = $('revealBanner');
  banner.replaceChildren();
  if (reveal.winnerId === you.id) banner.append('⚡ You were first!');
  else if (winner) { const n = el('span', '', winner.name); n.setAttribute('dir', 'auto'); banner.append('⚡ ', n, ' was first.'); }
  else banner.append('Nobody landed an answer this time.');

  const mine = reveal.entries.find((e) => e.playerId === you.id);
  const box = $('revealMine');
  box.replaceChildren();
  if (mine?.status === 'accepted') {
    const row = el('div', 'mine');
    const answer = el('span', '', `Your answer: “${mine.answer}”`);
    answer.setAttribute('dir', 'auto');
    row.append(answer, tierBadge(mine), el('span', 'points', `+${mine.points} points`));
    box.append(row);
    if (mine.flavor) box.append(el('p', 'muted', mine.flavor));
  } else if (mine?.status === 'error') {
    box.append(el('p', 'muted', 'Your Krillion window had a problem, so you sat this one out.'));
  } else {
    box.append(el('p', 'muted', "You didn't land an answer in time."));
  }
  $('revealRank').textContent = rankLine();
  fillBoard($('revealBoard'), snap.players, you.id);
}

function renderFinal() {
  show('final');
  $('finalRank').textContent = rankLine();
  fillBoard($('finalBoard'), snap.players, snap.you.id);
}

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('joinError').textContent = '';
  const name = $('name').value.trim();
  if (!name) { $('joinError').textContent = 'Please type your name.'; return; }
  try {
    const { ok, data } = await postJson('/api/join', { name });
    if (!ok) { $('joinError').textContent = data.message || 'Could not join. Please try again.'; return; }
    token = data.token;
    localStorage.setItem('kpToken', token);
    wasRemoved = false;
    connect();
  } catch {
    $('joinError').textContent = "Couldn't reach the game. Are you on the same Wi-Fi as the TV?";
  }
});

$('answer').addEventListener('input', () => { flash = null; });

$('answerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const answer = $('answer').value.trim();
  if (!answer || sending) return;
  sending = true;
  flash = null;
  $('send').disabled = true;
  $('status').textContent = 'Checking your answer…';
  $('status').className = 'status';
  try {
    const { status, data } = await postJson('/api/answer', { token, answer });
    if (status === 401) { wasRemoved = true; forgetToken(); return; }
    if (data.ok === false) flash = data.message;
    else if (document.activeElement === $('answer')) $('answer').select(); // a retry replaces the text
  } catch {
    flash = "Couldn't reach the game. Check your Wi-Fi and try again.";
  } finally {
    sending = false;
    if (snap?.phase === 'prompt') renderQuestion();
  }
});

connect();
