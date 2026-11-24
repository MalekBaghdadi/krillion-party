import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed } from '../src/feed.js';

test('subscribers get every frame, the latest is kept, and unsubscribing stops delivery', () => {
  const feed = createFeed();
  const seen = [];
  const stop = feed.subscribe((f) => seen.push(f));
  feed.push('a');
  feed.push('b');
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(feed.latest(), 'b');
  stop();
  feed.push('c');
  assert.deepEqual(seen, ['a', 'b']);
  feed.clear();
  assert.equal(feed.latest(), null);
});

test('a viewer that throws is dropped without stopping the others', () => {
  const feed = createFeed();
  const seen = [];
  feed.subscribe(() => { throw new Error('boom'); });
  feed.subscribe((f) => seen.push(f));
  feed.push(1);
  feed.push(2);
  assert.deepEqual(seen, [1, 2]);
});
