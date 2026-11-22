import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFake } from './fake-krillion.js';
import { testBrowser } from './browser.js';
import { openSession, launchBrowser, KrillionError } from '../src/krillion.js';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

const LINK = 'https://krillion.io/unlock?session_id=cs_test';
const open = (fake, extra = {}) => openSession(browser, { baseUrl: fake.url, stepTimeoutMs: 4000, ...extra });

async function withFake(opts, fn) {
  const fake = await startFake(opts);
  try { await fn(fake); } finally { await fake.close(); }
}

test('launchBrowser starts Chrome or Edge', async () => {
  const b = await launchBrowser();
  assert.equal(b.isConnected(), true);
  await b.close();
});

test('opens game 1 and reads the prompt', () => withFake({}, async (fake) => {
  const s = await open(fake);
  assert.deepEqual(s.prompt, { index: 0, total: 7, text: 'Name a noodle dish' });
  await s.close();
}));

test('submit accepted returns tier, answer, points and flavour', () => withFake({}, async (fake) => {
  const s = await open(fake);
  const r = await s.submit('pho');
  assert.deepEqual(r, { status: 'accepted', tier: 'RARE', answer: 'Pho', points: 60, flavor: 'Now we are talking.' });
  await s.close();
}));

test('submit rejected leaves the prompt open and a retry works', () => withFake({}, async (fake) => {
  const s = await open(fake);
  assert.deepEqual(await s.submit('zzz'), { status: 'rejected' });
  assert.deepEqual(await s.submit('qqq'), { status: 'rejected' });
  assert.equal((await s.submit('ramen')).status, 'accepted');
  await s.close();
}));

test('waitForResult resolves timeout when the clock runs out', () => withFake({ timerSeconds: 1 }, async (fake) => {
  const s = await open(fake);
  assert.deepEqual(await s.waitForResult(), { status: 'timeout' });
  await s.close();
}));

test('waitForResult also settles when an answer is accepted', () => withFake({}, async (fake) => {
  const s = await open(fake);
  const waiting = s.waitForResult();
  await s.submit('ramen');
  assert.equal((await waiting).status, 'accepted');
  await s.close();
}));

test('readTimer returns the countdown as a number', () => withFake({ timerSeconds: 20 }, async (fake) => {
  const s = await open(fake);
  const t = await s.readTimer();
  assert.equal(typeof t, 'number');
  assert.ok(t <= 20 && t > 0);
  await s.close();
}));

test('next walks all 7 prompts, then reports done', () => withFake({}, async (fake) => {
  const s = await open(fake);
  for (let i = 0; i < 6; i += 1) {
    await s.submit('ramen');
    const step = await s.next();
    assert.equal(step.done, false);
    assert.equal(step.prompt.index, i + 1);
  }
  await s.submit('ramen');
  assert.deepEqual(await s.next(), { done: true });
  await s.close();
}));

test('game 2 without a link rejects LOCKED', () => withFake({}, async (fake) => {
  await assert.rejects(open(fake, { gameNumber: 2 }), (e) => e instanceof KrillionError && e.code === 'LOCKED');
}));

test('game 2 with the right link opens', () => withFake({}, async (fake) => {
  const s = await open(fake, { gameNumber: 2, unlockLink: LINK });
  assert.equal(s.prompt.index, 0);
  await s.close();
}));

test('a wrong link rejects UNLOCK_FAILED and never leaks the link', () => withFake({}, async (fake) => {
  const secret = 'https://krillion.io/unlock?session_id=SECRET123';
  await assert.rejects(open(fake, { gameNumber: 2, unlockLink: secret }), (e) => {
    assert.equal(e.code, 'UNLOCK_FAILED');
    assert.equal(e.message.includes('SECRET123'), false);
    return true;
  });
}));

test('a link is not needed (or used) for game 1', () => withFake({}, async (fake) => {
  const s = await open(fake, { gameNumber: 1, unlockLink: 'https://krillion.io/unlock?session_id=SECRET123' });
  assert.equal(s.prompt.index, 0);
  await s.close();
}));

test('two sessions do not share storage', () => withFake({}, async (fake) => {
  const unlocked = await open(fake, { gameNumber: 2, unlockLink: LINK });
  await assert.rejects(open(fake, { gameNumber: 2 }), (e) => e.code === 'LOCKED');
  await unlocked.close();
}));

test('a changed page rejects SITE_CHANGED quickly and saves a screenshot', () => withFake({ broken: true }, async (fake) => {
  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-debug-'));
  const started = Date.now();
  await assert.rejects(open(fake, { stepTimeoutMs: 1500, debugDir }), (e) => e.code === 'SITE_CHANGED');
  assert.ok(Date.now() - started < 6000);
  assert.ok(fs.readdirSync(debugDir).some((f) => f.endsWith('.png')));
}));
