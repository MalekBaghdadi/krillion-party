import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed } from '../src/feed.js';
import { createTv, TV_VIEWPORT } from '../src/tv.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scripted Krillion window: records what it is told and can be made to fail.
function fakeSession(over = {}) {
  const s = {
    calls: [],
    closed: 0,
    onFrame: null,
    startScreencast: async (onFrame) => { s.onFrame = onFrame; },
    submit: async (answer) => { s.calls.push(['submit', answer]); await sleep(over.slow ?? 0); return over.submit?.(answer) ?? { status: 'accepted' }; },
    next: async () => { s.calls.push(['next']); if (over.next) throw over.next; return { done: false }; },
    close: async () => { s.closed += 1; },
  };
  return s;
}

test('opens a big-screen window at TV size and goes live', async () => {
  const session = fakeSession();
  let opened = null;
  const tv = createTv({ open: async (o) => { opened = o; return session; }, feed: createFeed() });
  assert.equal(tv.live, false);
  await tv.start();
  assert.equal(tv.live, true);
  assert.deepEqual(opened.viewport, TV_VIEWPORT);
});

test('a window that fails to open is closed and the error reaches the caller', async () => {
  const session = fakeSession();
  session.startScreencast = async () => { throw new Error('no video'); };
  const tv = createTv({ open: async () => session, feed: createFeed() });
  await assert.rejects(tv.start(), /no video/);
  assert.equal(tv.live, false);
  assert.equal(session.closed, 1);
});

test('steps run one at a time, in the order they were asked', async () => {
  const session = fakeSession({ slow: 40 });
  const tv = createTv({ open: async () => session, feed: createFeed() });
  await tv.start();
  tv.show('Ramen'); // slow: still running when the next step is asked for
  const live = await tv.advance();
  assert.deepEqual(session.calls, [['submit', 'Ramen'], ['next']]);
  assert.equal(live, true);
});

test('a refused answer is harmless: the screen stays live', async () => {
  const session = fakeSession({ submit: () => { throw new Error('page closed itself'); } });
  const logs = [];
  const tv = createTv({ open: async () => session, feed: createFeed(), log: (l) => logs.push(l) });
  await tv.start();
  await tv.show('Ramen');
  assert.equal(tv.live, true);
  assert.match(logs[0], /big screen \(show\)/);
});

test('if it cannot move to the next question it retires itself and clears the picture', async () => {
  const session = fakeSession({ next: new Error('timeout') });
  const feed = createFeed();
  feed.push(Buffer.from('old frame'));
  const tv = createTv({ open: async () => session, feed });
  await tv.start();
  assert.equal(await tv.advance(), false);
  assert.equal(tv.live, false);
  assert.equal(session.closed, 1);
  assert.equal(feed.latest(), null);
  await tv.show('late'); // asking after retirement does nothing
  assert.deepEqual(session.calls, [['next']]);
});

test('frames are thinned to the newest one, and the last picture is never lost', async () => {
  const session = fakeSession();
  const feed = createFeed();
  const sent = [];
  feed.subscribe((f) => sent.push(f));
  const tv = createTv({ open: async () => session, feed });
  await tv.start();
  for (let i = 1; i <= 20; i += 1) session.onFrame(i); // a burst, far faster than the cap
  await sleep(150);
  assert.ok(sent.length < 20, `sent ${sent.length}`);
  assert.equal(sent.at(-1), 20); // the newest always gets through
  await tv.close();
  assert.equal(feed.latest(), null);
});
