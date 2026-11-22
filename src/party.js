// The conductor: joins the game rules (game.js) to the Krillion sessions (pool.js).
// Every public method is safe to call at any time; trouble becomes a `notice` on the screen.
import { GameError } from './game.js';
import { KrillionError, plainLine } from './krillion.js';

const friendly = (err) => (err instanceof GameError || err instanceof KrillionError
  ? err.message
  : `Something went wrong: ${plainLine(err)}`);

export function createParty({ game, getPool, emit, pollMs = 500 }) {
  let pool = null;
  let notice = null;
  let timeLeft = null;
  let pollTimer = null;
  let polling = false;
  let promptGen = 0; // bumped for every prompt so late results from an old one are ignored
  let busy = false;

  const phase = () => game.snapshot().phase;
  const nameOf = (id) => game.snapshot().players.find((p) => p.id === id)?.name ?? 'A player';
  const changed = () => { try { emit(); } catch { /* a broken listener must not stop the game */ } };
  const problems = (failed) => failed.map((f) => `${nameOf(f.id)}: ${f.message}`).join(' · ');

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    timeLeft = null;
  }

  function startPolling(gen) {
    stopPolling();
    const tick = async () => {
      if (polling || gen !== promptGen) return;
      polling = true;
      try {
        const t = await pool.readTimer();
        if (gen === promptGen && phase() === 'prompt' && t !== timeLeft) { timeLeft = t; changed(); }
      } catch { /* the next tick will try again */ } finally { polling = false; }
    };
    tick(); // don't make the first reading wait a whole interval
    pollTimer = setInterval(tick, pollMs);
    pollTimer.unref?.();
  }

  function maybeClose() {
    if (phase() === 'prompt' && game.allResolved()) {
      stopPolling();
      game.closePrompt();
    }
  }

  function onResult(gen, id, result) {
    if (gen !== promptGen) return;
    game.recordResult(id, result);
    maybeClose();
    changed();
  }

  // Start listening for each live player's result on the prompt that just opened.
  function watch() {
    const gen = ++promptGen;
    for (const p of game.snapshot().players) {
      if (!p.errored) pool.waitForResult(p.id).then((r) => onResult(gen, p.id, r));
    }
    startPolling(gen);
  }

  async function teardown() {
    stopPolling();
    promptGen += 1;
    const old = pool;
    pool = null;
    await old?.closeAll();
  }

  async function start() {
    game.begin(); // throws a friendly GameError if nobody has joined or a game is running
    notice = null;
    changed();
    try {
      pool = await getPool();
      const players = game.snapshot().players.map(({ id, name }) => ({ id, name }));
      const { failed, mismatch } = await pool.openAll(players);
      const first = failed.length >= players.length ? null : pool.referencePrompt(); // nobody got in: nothing to play
      if (!first) {
        notice = [...new Set(failed.map((f) => f.message))].join(' ') || 'Krillion could not be started.';
        await teardown();
        game.reset();
      } else {
        game.openPrompt(first);
        for (const f of failed) game.recordResult(f.id, { status: 'error', message: f.message });
        notice = [mismatch && 'The windows did not all get the same question, so this round may be unfair. Try Test setup.', problems(failed)].filter(Boolean).join(' · ') || null;
        watch();
        maybeClose();
      }
    } catch (err) {
      notice = friendly(err);
      await teardown();
      game.reset();
    }
    changed();
  }

  async function answer(playerId, text) {
    const attempt = game.recordAttempt(playerId, text);
    if (!attempt.ok) return attempt;
    const gen = promptGen;
    changed();
    let result;
    try {
      result = await pool.submit(playerId, attempt.answer);
    } catch (err) {
      result = { status: 'error', message: friendly(err) };
    }
    if (gen !== promptGen) return { ok: true };
    game.recordResult(playerId, result);
    maybeClose();
    changed();
    return { ok: true };
  }

  async function next() {
    if (phase() !== 'reveal' || busy || !pool) return;
    busy = true;
    try {
      const step = await pool.advance();
      for (const f of step.failed) game.recordResult(f.id, { status: 'error', message: f.message });
      if (step.failed.length) notice = problems(step.failed);
      if (step.done) {
        game.finish();
        await teardown();
      } else {
        game.openPrompt(step.prompt);
        watch();
        maybeClose();
      }
    } catch (err) {
      notice = friendly(err);
    } finally {
      busy = false;
      changed();
    }
  }

  async function again() {
    await teardown();
    game.reset();
    notice = null;
    changed();
  }

  return {
    join(name) { const r = game.join(name); changed(); return r; },
    playerByToken(token) { const p = game.playerByToken(token); return p ? { id: p.id } : null; },
    remove(id) { game.removePlayer(id); changed(); },
    start,
    answer,
    next,
    again,
    stop: teardown,
    snapshot(viewerId) {
      return { ...game.snapshot(viewerId), timeLeft: phase() === 'prompt' ? timeLeft : null, notice };
    },
  };
}
