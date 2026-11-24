// The newest picture of the big-screen Krillion window, shared with whoever is watching it.
// Frames are JPEG buffers. A viewer that joins late is handed the latest one straight away.
export function createFeed() {
  let latest = null;
  const listeners = new Set();
  return {
    push(frame) {
      latest = frame;
      for (const fn of listeners) {
        try { fn(frame); } catch { listeners.delete(fn); } // one broken viewer must not stop the rest
      }
    },
    latest: () => latest,
    clear() { latest = null; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
