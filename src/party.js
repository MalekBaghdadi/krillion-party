// The conductor: joins the game rules (game.js) to the Krillion sessions (pool.js).
// Every public method is safe to call at any time; trouble becomes a `notice` on the screen.
import { GameError } from './game.js';
import { KrillionError, plainLine } from './krillion.js';

const friendly = (err) => (err instanceof GameError || err instanceof KrillionError
  ? err.message
  : `Something went wrong: ${plainLine(err)}`);

export function createParty({ game, getPool, getTv, emit, pollMs = 500, spotlightGraceMs = 500, log = () => {} }) {
  let pool = null;
  let tv = null; // the big-screen window, when one is open (see tv.js)
  let spotlit = 0; // the prompt (promptGen) whose winning answer is already on the big screen
  let spotlightTimer = null;
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

  // Puts the race leader's answer into the big-screen window so the TV shows Krillion's own result
  // card. It waits a moment after the first answer lands, in case someone typed an earlier one that
  // is still being checked, unless everybody has already resolved.
  function spotlight() {
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
    if (!tv || spotlit === promptGen) return;
    const lead = game.leader();
    if (!lead) return;
    spotlit = promptGen;
    tv.show(lead.answer);
  }

  function maybeSpotlight() {
    if (!tv || spotlit === promptGen || !game.leader()) return;
    if (game.allResolved()) spotlight();
    else if (!spotlightTimer) {
      spotlightTimer = setTimeout(spotlight, spotlightGraceMs);
      spotlightTimer.unref?.();
    }
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
    maybeSpotlight();
    changed();
  }

  // Start listening for each live player's result on the prompt that just opened.
  function watch() {
    const gen = ++promptGen;
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
    for (const p of game.snapshot().players) {
      if (!p.errored) pool.waitForResult(p.id).then((r) => onResult(gen, p.id, r));
    }
    startPolling(gen);
  }

  async function teardown() {
    stopPolling();
    promptGen += 1;
    clearTimeout(spotlightTimer);
    spotlightTimer = null;
    const old = pool;
    const oldTv = tv;
    pool = null;
    tv = null;
    await Promise.all([old?.closeAll(), oldTv?.close()]);
  }

  // The big screen is a bonus: if its window can't open, the host page keeps its simple layout.
  async function openTv() {
    if (!getTv) return;
    try {
      const candidate = await getTv();
      await candidate.start();
      tv = candidate;
    } catch (err) {
      tv = null;
      log(`big screen could not open: ${plainLine(err)}`);
    }
  }

  async function start() {
    game.begin(); // throws a friendly GameError if nobody has joined or a game is running
    notice = null;
    changed();
    try {
      pool = await getPool();
      const players = game.snapshot().players.map(({ id, name }) => ({ id, name }));
      const tvOpening = openTv(); // in step with the players' windows so every countdown starts together
      const { failed, mismatch } = await pool.openAll(players);
      await tvOpening;
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
    maybeSpotlight();
    changed();
    return { ok: true };
  }

  async function next() {
    if (phase() !== 'reveal' || busy || !pool) return;
    busy = true;
    try {
      const tvStep = tv?.advance(); // the big screen moves on in step with the players' windows
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
      tvStep?.then(changed); // if the big screen fell out of step, tell the host page to go back to its simple layout
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
      return { ...game.snapshot(viewerId), timeLeft: phase() === 'prompt' ? timeLeft : null, notice, tv: Boolean(tv?.live) };
    },
  };
}
