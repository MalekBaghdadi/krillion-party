import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './fake-krillion.js';
import { testBrowser } from './browser.js';
import { createGame, GameError } from '../src/game.js';
import { createPool } from '../src/pool.js';
import { createParty } from '../src/party.js';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(25); }
  throw new Error('timed out waiting for condition');
}

// A real party: real game, real pool, fake Krillion.
async function realParty(fakeOpts, names, config = { gameNumber: 1, unlockLink: '' }) {
  const fake = await startFake(fakeOpts);
  const game = createGame();
  const emits = { n: 0 };
  const pool = createPool({ browser, config, openOptions: { baseUrl: fake.url, stepTimeoutMs: 4000 } });
  const party = createParty({ game, getPool: async () => pool, emit: () => { emits.n += 1; }, pollMs: 100 });
  const ids = names.map((n) => party.join(n).id);
  const phase = () => party.snapshot().phase;
  const stop = async () => { await party.stop(); await fake.close(); };
  return { fake, game, party, ids, phase, emits, stop };
}

// A scripted pool for exact timing and failure cases.
function stubPool(over = {}) {
  const pool = {
    closed: 0,
    waiters: [],
    openAll: async (players) => over.openAll?.(players) ?? { failed: [], mismatch: false },
    referencePrompt: () => ({ index: 0, total: 7, text: 'Name a noodle dish' }),
    submit: async (id, answer) => (over.submit ? over.submit(id, answer) : { status: 'accepted', tier: 'PLANKTON', answer, points: 10, flavor: '' }),
    waitForResult: (id) => new Promise((resolve) => pool.waiters.push({ id, resolve })),
    readTimer: async () => null,
    advance: async () => over.advance?.() ?? { done: false, prompt: { index: 1, total: 7, text: 'Name a great ape' }, failed: [] },
    closeAll: async () => { pool.closed += 1; },
  };
  return pool;
}
function stubParty(pool, names) {
  const game = createGame();
  const party = createParty({ game, getPool: async () => pool, emit: () => {}, pollMs: 50 });
  const ids = names.map((n) => party.join(n).id);
  return { game, party, ids, phase: () => party.snapshot().phase };
}

test('start refuses with a friendly message when nobody has joined', async () => {
  const { party, stop } = await realParty({}, []);
  await assert.rejects(party.start(), (e) => e instanceof GameError && /players/i.test(e.message));
  await stop();
});

test('a prompt: two answer, one times out, the earliest accepted wins, scores added', async () => {
  const { party, ids, phase, stop } = await realParty({ timerSeconds: 3 }, ['Ann', 'Bo', 'Cy']);
  await party.start();
  await until(() => phase() === 'prompt');
  assert.equal(party.snapshot().prompt.text, 'Name a noodle dish');
  await party.answer(ids[0], 'ramen');
  await party.answer(ids[1], 'pho');
  await until(() => phase() === 'reveal');
  const snap = party.snapshot();
  assert.equal(snap.reveal.winnerId, ids[0]);
  assert.deepEqual(snap.reveal.entries.map((e) => e.status), ['accepted', 'accepted', 'timeout']);
  assert.deepEqual(snap.players.map((p) => [p.score, p.raceWins]), [[10, 1], [60, 0], [0, 0]]);
  await stop();
});

test('a rejected answer lets the player retry and does not count', async () => {
  const { party, ids, phase, stop } = await realParty({ timerSeconds: 20 }, ['Ann']);
  await party.start();
  await until(() => phase() === 'prompt');
  await party.answer(ids[0], 'zzz');
  let you = party.snapshot(ids[0]).you;
  assert.equal(you.status, 'idle');
  assert.equal(you.rejected, 'zzz');
  assert.equal(you.attemptsLeft, 4);
  assert.deepEqual(await party.answer(ids[0], 'ZZZ'), { ok: false, reason: 'repeat' });
  await party.answer(ids[0], 'ramen');
  await until(() => phase() === 'reveal');
  you = party.snapshot(ids[0]).you;
  assert.equal(you.status, 'locked');
  assert.equal(party.snapshot().players[0].score, 10);
  await stop();
});

test('a near-miss is offered back as a suggestion, and confirming it locks the answer in', async () => {
  const { party, ids, phase, stop } = await realParty({ timerSeconds: 20 }, ['Ann']);
  await party.start();
  await until(() => phase() === 'prompt');
  await party.answer(ids[0], 'raman');
  const you = party.snapshot(ids[0]).you;
  assert.deepEqual(you.suggestion, { typed: 'raman', text: 'Ramen' });
  assert.equal(you.status, 'idle');
  assert.equal(phase(), 'prompt'); // a suggestion is not an answer: nothing is decided yet
  await party.answer(ids[0], 'Ramen');
  await until(() => phase() === 'reveal');
  assert.equal(party.snapshot().players[0].score, 10);
  assert.equal(party.snapshot().reveal.winnerId, ids[0]);
  await stop();
});

test('race winner is the earliest typist even when its result arrives later', async () => {
  const pool = stubPool({
    submit: async (id, answer) => {
      if (answer === 'pho') await sleep(250); // the earlier typist's Krillion is slower
      return { status: 'accepted', tier: 'X', answer, points: 10, flavor: '' };
    },
  });
  const { party, ids, phase } = stubParty(pool, ['early', 'late']);
  await party.start();
  const first = party.answer(ids[0], 'pho');
  await sleep(30);
  const second = party.answer(ids[1], 'ramen');
  await Promise.all([first, second]);
  await until(() => phase() === 'reveal');
  assert.equal(party.snapshot().reveal.winnerId, ids[0]);
});

test('a player whose session fails to open is marked errored and the rest play on', async () => {
  const pool = stubPool({ openAll: async (players) => ({ failed: [{ id: players[1].id, code: 'ERROR', message: 'Chrome crashed' }], mismatch: false }) });
  const { party, ids, phase } = stubParty(pool, ['ok', 'broken']);
  await party.start();
  assert.equal(phase(), 'prompt');
  assert.equal(party.snapshot().players[1].errored, true);
  assert.match(party.snapshot().notice, /broken/);
  await party.answer(ids[0], 'ramen');
  await until(() => phase() === 'reveal');
  assert.equal(party.snapshot().reveal.entries[1].status, 'error');
});

test('a session that errors mid-prompt resolves as error without stalling the prompt', async () => {
  const pool = stubPool({ submit: async (id, answer) => (answer === 'boom' ? { status: 'error', message: 'window closed' } : { status: 'accepted', tier: 'X', answer, points: 10, flavor: '' }) });
  const { party, ids, phase } = stubParty(pool, ['a', 'b']);
  await party.start();
  await party.answer(ids[1], 'boom');
  await party.answer(ids[0], 'ramen');
  await until(() => phase() === 'reveal');
  assert.deepEqual(party.snapshot().reveal.entries.map((e) => e.status), ['accepted', 'error']);
});

test('a prompt mismatch sets a notice', async () => {
  const pool = stubPool({ openAll: async () => ({ failed: [], mismatch: true }) });
  const { party } = stubParty(pool, ['a']);
  await party.start();
  assert.match(party.snapshot().notice, /same question/i);
});

test('if every session fails, the game returns to the lobby with the reason', async () => {
  const pool = stubPool({ openAll: async (players) => ({ failed: players.map((p) => ({ id: p.id, code: 'LOCKED', message: 'Game 2 is locked.' })), mismatch: false }) });
  const { party, phase } = stubParty(pool, ['a', 'b']);
  await party.start();
  assert.equal(phase(), 'lobby');
  assert.match(party.snapshot().notice, /Game 2 is locked/);
  assert.equal(party.snapshot().players.length, 2);
  assert.equal(pool.closed, 1);
});

test('late results from the previous prompt are ignored', async () => {
  const pool = stubPool();
  const { party, ids, phase } = stubParty(pool, ['a', 'b']);
  await party.start();
  await party.answer(ids[0], 'ramen');
  await party.answer(ids[1], 'pho');
  await until(() => phase() === 'reveal');
  const stale = pool.waiters.splice(0);
  await party.next();
  stale.forEach((w) => w.resolve({ status: 'timeout' })); // old prompt's waiters fire late
  await sleep(50);
  assert.equal(phase(), 'prompt');
  assert.deepEqual(party.snapshot().players.map((p) => p.locked), [false, false]);
});

test('next walks to the finished phase after 7 prompts and closes the sessions', async () => {
  const { party, ids, phase, stop } = await realParty({ timerSeconds: 20 }, ['Ann', 'Bo']);
  await party.start();
  for (let i = 0; i < 7; i += 1) {
    await until(() => phase() === 'prompt' && party.snapshot().prompt.index === i);
    await Promise.all(ids.map((id) => party.answer(id, 'ramen')));
    await until(() => phase() === 'reveal');
    await party.next();
  }
  assert.equal(phase(), 'finished');
  const snap = party.snapshot();
  assert.deepEqual(snap.players.map((p) => p.score), [70, 70]);
  assert.equal(snap.players.reduce((n, p) => n + p.raceWins, 0), 7);
  await stop();
});

test('again returns to the lobby with players kept and sessions closed', async () => {
  const pool = stubPool();
  const { party, phase } = stubParty(pool, ['a', 'b']);
  await party.start();
  await party.again();
  assert.equal(phase(), 'lobby');
  assert.equal(party.snapshot().players.length, 2);
  assert.equal(pool.closed, 1);
});

test('timeLeft follows the page countdown and is null outside a prompt', async () => {
  const { party, ids, phase, stop } = await realParty({ timerSeconds: 20 }, ['Ann']);
  assert.equal(party.snapshot().timeLeft, null);
  await party.start();
  await until(() => typeof party.snapshot().timeLeft === 'number');
  const t = party.snapshot().timeLeft;
  assert.ok(t > 0 && t <= 20);
  await party.answer(ids[0], 'ramen');
  await until(() => phase() === 'reveal');
  assert.equal(party.snapshot().timeLeft, null);
  await stop();
});

test('emit fires on joins and on every state change', async () => {
  const { party, ids, emits, phase, stop } = await realParty({ timerSeconds: 20 }, ['Ann']);
  const afterJoin = emits.n;
  assert.ok(afterJoin >= 1);
  await party.start();
  await until(() => phase() === 'prompt');
  assert.ok(emits.n > afterJoin);
  await stop();
});

test('real pool: a locked game surfaces the reason and returns to the lobby', async () => {
  const { party, phase, stop } = await realParty({}, ['Ann', 'Bo'], { gameNumber: 2, unlockLink: '' });
  await party.start();
  assert.equal(phase(), 'lobby');
  assert.match(party.snapshot().notice, /locked/i);
  await stop();
});

test('the first countdown reading arrives immediately, not after a full poll interval', async () => {
  const pool = stubPool();
  pool.readTimer = async () => 7;
  const game = createGame();
  const party = createParty({ game, getPool: async () => pool, emit: () => {}, pollMs: 60000 });
  party.join('a');
  await party.start();
  await until(() => party.snapshot().timeLeft === 7, 1000);
  await party.stop();
});

// ---- the big screen (see tv.js): a scripted window, so timing is exact ----
function stubTv(over = {}) {
  const tv = {
    live: false, shown: [], advanced: 0, closed: 0,
    start: async () => { if (over.start) throw over.start; tv.live = true; },
    show: async (answer) => { tv.shown.push(answer); },
    advance: async () => { tv.advanced += 1; if (over.advanceFails) tv.live = false; return tv.live; },
    close: async () => { tv.live = false; tv.closed += 1; },
  };
  return tv;
}
function tvParty(pool, tv, names, extra = {}) {
  const game = createGame();
  const emits = { n: 0 };
  const party = createParty({ game, getPool: async () => pool, getTv: async () => tv, emit: () => { emits.n += 1; }, pollMs: 50, spotlightGraceMs: 40, ...extra });
  const ids = names.map((n) => party.join(n).id);
  return { party, ids, emits, phase: () => party.snapshot().phase };
}

test('big screen: the race leader\'s answer goes onto it once per question, and the snapshot says it is live', async () => {
  const tv = stubTv();
  const { party, ids } = tvParty(stubPool(), tv, ['Ann', 'Bo']);
  await party.start();
  assert.equal(party.snapshot().tv, true);
  await party.answer(ids[0], 'ramen');
  assert.deepEqual(tv.shown, []); // waits a moment in case an earlier typist is still being checked
  await until(() => tv.shown.length === 1);
  assert.deepEqual(tv.shown, ['ramen']);
  await party.answer(ids[1], 'pho');
  await sleep(120);
  assert.deepEqual(tv.shown, ['ramen']); // the question already has its winner on screen
  await party.stop();
});

test('big screen: when everyone has resolved it shows the winner straight away', async () => {
  const tv = stubTv();
  const { party, ids } = tvParty(stubPool(), tv, ['Ann'], { spotlightGraceMs: 10000 });
  await party.start();
  await party.answer(ids[0], 'ramen');
  assert.deepEqual(tv.shown, ['ramen']); // no waiting for the grace period
  await party.stop();
});

test('big screen: an earlier typist who is checked a little later still wins the screen', async () => {
  const tv = stubTv();
  const pool = stubPool({ submit: async (id, answer) => { await sleep(answer === 'ramen' ? 100 : 5); return { status: 'accepted', tier: 'PLANKTON', answer, points: 10, flavor: '' }; } });
  const { party, ids } = tvParty(pool, tv, ['Ann', 'Bo'], { spotlightGraceMs: 250 });
  await party.start();
  const ann = party.answer(ids[0], 'ramen'); // typed first, but Krillion takes longer to check it
  await sleep(15);
  const bo = party.answer(ids[1], 'pho'); // typed second, accepted first
  await Promise.all([ann, bo]);
  await until(() => tv.shown.length > 0);
  assert.deepEqual(tv.shown, ['ramen']); // the same rule that decides the real winner
  assert.equal(party.snapshot().reveal.winnerId, ids[0]);
  await party.stop();
});

test('big screen: nobody accepted means nothing is shown, and the next question moves it on', async () => {
  const tv = stubTv();
  const pool = stubPool({ submit: async () => ({ status: 'timeout' }) });
  const { party, ids, phase } = tvParty(pool, tv, ['Ann']);
  await party.start();
  await party.answer(ids[0], 'zzz');
  await until(() => phase() === 'reveal');
  assert.deepEqual(tv.shown, []);
  await party.next();
  assert.equal(tv.advanced, 1);
  await party.stop();
});

test('big screen: if it falls out of step the host page is told and the game carries on', async () => {
  const tv = stubTv({ advanceFails: true });
  const { party, ids, emits, phase } = tvParty(stubPool(), tv, ['Ann']);
  await party.start();
  await party.answer(ids[0], 'ramen');
  await until(() => phase() === 'reveal');
  const before = emits.n;
  await party.next();
  await until(() => party.snapshot().tv === false);
  assert.ok(emits.n > before); // the page hears about it, so it can go back to its simple layout
  assert.equal(party.snapshot().phase, 'prompt'); // and the game itself kept going
  await party.stop();
});

test('big screen: a window that will not open never stops the game', async () => {
  const tv = stubTv({ start: new Error('no memory') });
  const logs = [];
  const { party, phase } = tvParty(stubPool(), tv, ['Ann'], { log: (l) => logs.push(l) });
  await party.start();
  assert.equal(phase(), 'prompt');
  assert.equal(party.snapshot().tv, false);
  assert.equal(party.snapshot().notice, null); // nothing alarming on the TV
  assert.match(logs[0], /big screen could not open/);
  await party.stop();
});

test('big screen: it is closed when the game is stopped', async () => {
  const tv = stubTv();
  const { party } = tvParty(stubPool(), tv, ['Ann']);
  await party.start();
  await party.stop();
  assert.equal(tv.closed, 1);
  assert.equal(party.snapshot().tv, false);
});
