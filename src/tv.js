// The big screen: one more real Krillion window on the same game, shown live on the host's screen.
// It follows the race. When a player's answer lands first, that same answer goes into this window,
// so the TV shows Krillion's own result card for it (tier, points, how deep it sinks).
// Nothing here ever throws into the party: if this window has trouble the screen just falls back.
import { plainLine } from './krillion.js';

export const TV_VIEWPORT = { width: 1280, height: 720 };
const FRAME_GAP_MS = 50; // at most about 20 pictures a second is plenty for a TV

export function createTv({ open, feed, log = () => {} }) {
  let session = null;
  let alive = false;
  let queue = Promise.resolve();

  // Pictures can arrive faster than we want to send them: keep only the newest, and always send it.
  let lastSent = 0;
  let pending = null;
  let trailing = null;
  const flush = () => {
    clearTimeout(trailing);
    trailing = null;
    if (!pending) return;
    lastSent = Date.now();
    feed.push(pending);
    pending = null;
  };
  const onFrame = (frame) => {
    pending = frame;
    const wait = lastSent + FRAME_GAP_MS - Date.now();
    if (wait <= 0) flush();
    else trailing ??= setTimeout(flush, wait);
  };

  // Steps run one at a time and in order, so "show the winner" can never overlap "next question".
  function enqueue(label, fn) {
    queue = queue.then(async () => {
      if (!alive) return false;
      try {
        await fn();
        return true;
      } catch (err) {
        log(`big screen (${label}): ${plainLine(err)}`);
        return false;
      }
    });
    return queue;
  }

  return {
    get live() { return alive; },

    async start() {
      try {
        session = await open({ viewport: TV_VIEWPORT });
        await session.startScreencast(onFrame, { maxWidth: TV_VIEWPORT.width, maxHeight: TV_VIEWPORT.height });
        alive = true;
      } catch (err) {
        await session?.close();
        session = null;
        throw err;
      }
    },

    // Types the winning answer into the big-screen window. A refusal there is harmless: the screen
    // simply keeps showing the open question.
    show: (answer) => enqueue('show', () => session.submit(answer)),

    // Moves to the next question. If it can't (the window got out of step), the big screen is retired
    // and the host page goes back to its simple layout. Resolves to whether the screen is still live.
    async advance() {
      const ok = await enqueue('next', () => session.next());
      if (!ok && alive) await this.close();
      return alive;
    },

    async close() {
      alive = false;
      clearTimeout(trailing);
      trailing = null;
      pending = null;
      const old = session;
      session = null;
      await old?.close();
      feed.clear();
    },
  };
}
