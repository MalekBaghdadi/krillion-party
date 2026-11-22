import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './fake-krillion.js';
import { testBrowser } from './browser.js';
import { KrillionError } from '../src/krillion.js';
import { createPool } from '../src/pool.js';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

const config = { gameNumber: 1, unlockLink: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubSession = (over = {}) => ({
  prompt: { index: 0, total: 7, text: 'Q' },
  readTimer: async () => null,
  submit: async () => ({ status: 'accepted', tier: 'X', answer: 'a', points: 1, flavor: '' }),
  waitForResult: async () => ({ status: 'timeout' }),
  next: async () => ({ done: true }),
  close: async () => {},
  ...over,
});
const poolOf = (sessions, extra = {}) => createPool({ browser: null, config, open: async () => sessions.shift(), ...extra });

test('a late answer after the clock ran out does not knock the player out of the game', async () => {
  const fake = await startFake({ timerSeconds: 1 });
  const pool = createPool({ browser, config, openOptions: { baseUrl: fake.url, stepTimeoutMs: 4000 } });
  try {
    await pool.openAll([{ id: 'a', name: 'Ann' }]);
    assert.deepEqual(await pool.waitForResult('a'), { status: 'timeout' });
    assert.deepEqual(await pool.submit('a', 'ramen'), { status: 'timeout' });
    const step = await pool.advance();
    assert.equal(step.done, false);
    assert.deepEqual(step.failed, []); // still in the game for question 2
    assert.equal(step.prompt.index, 1);
  } finally { await pool.closeAll(); await fake.close(); }
});

test('readTimer asks every session at once, so locked-in players do not slow the countdown', async () => {
  const slowNull = () => stubSession({ readTimer: async () => { await sleep(400); return null; } });
  const pool = poolOf([slowNull(), slowNull(), slowNull(), stubSession({ readTimer: async () => 7 })]);
  await pool.openAll([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  const started = Date.now();
  assert.equal(await pool.readTimer(), 7);
  assert.ok(Date.now() - started < 900, `took ${Date.now() - started} ms (one after another would be 1200+)`);
});

test('problems shown on the TV are one plain line, never a raw Playwright error', async () => {
  const raw = () => new Error('locator.click: Timeout 20000ms exceeded.\nCall log:\n  - waiting for \u001b[2mlocator\u001b[22m');
  const failing = createPool({ browser: null, config, open: async () => { throw raw(); } });
  const { failed } = await failing.openAll([{ id: 'a' }]);
  const plain = (m) => !m.includes('\n') && !m.includes('\u001b') && !/Call log|locator\./.test(m);
  assert.ok(plain(failed[0].message), failed[0].message);

  const dying = poolOf([stubSession({ submit: async () => { throw raw(); }, waitForResult: () => new Promise(() => {}) })]);
  await dying.openAll([{ id: 'a' }]);
  const result = await dying.submit('a', 'x');
  assert.equal(result.status, 'error');
  assert.ok(plain(result.message), result.message);
});

test('messages already written for people (Krillion errors) pass through unchanged', async () => {
  const locked = createPool({ browser: null, config, open: async () => { throw new KrillionError('LOCKED', 'Game 2 is locked. Add your Krillion unlock link in Settings.'); } });
  const { failed } = await locked.openAll([{ id: 'a' }]);
  assert.deepEqual(failed, [{ id: 'a', code: 'LOCKED', message: 'Game 2 is locked. Add your Krillion unlock link in Settings.' }]);
});

test('unexpected failures go to the optional log, not the screen', async () => {
  const lines = [];
  const pool = createPool({ browser: null, config, log: (m) => lines.push(m), open: async () => { throw new Error('boom\nsecond line'); } });
  await pool.openAll([{ id: 'a' }]);
  assert.deepEqual(lines, ['boom']);
});
