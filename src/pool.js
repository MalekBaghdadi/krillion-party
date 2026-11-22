// One Krillion session per player, all in one Chrome. The methods here never throw for a
// single player's problem: that player just becomes {status:'error'} and everyone else carries on.
import { KrillionError, openSession as realOpen, plainLine } from './krillion.js';

export function createPool({ browser, config, open = realOpen, openOptions = {}, log = () => {} }) {
  const sessions = new Map(); // player id -> KrillionSession

  // Messages already written for people pass through. Anything else (a raw browser error) goes to
  // the log and the screen gets one plain sentence.
  function describe(err) {
    if (err instanceof KrillionError) return { code: err.code, message: err.message };
    log(plainLine(err));
    return { code: 'ERROR', message: "This player's Krillion window had a problem." };
  }
  const openOne = () => open(browser, { ...openOptions, gameNumber: config.gameNumber, unlockLink: config.unlockLink });

  async function drop(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.close();
  }

  return {
    async openAll(players) {
      const settled = await Promise.allSettled(players.map(() => openOne()));
      const failed = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') sessions.set(players[i].id, r.value);
        else failed.push({ id: players[i].id, ...describe(r.reason) });
      });
      const texts = new Set([...sessions.values()].map((s) => s.prompt.text));
      return { failed, mismatch: texts.size > 1 };
    },

    referencePrompt() {
      return sessions.values().next().value?.prompt ?? null;
    },

    async submit(id, answer) {
      const session = sessions.get(id);
      if (!session) return { status: 'error', message: 'This player has no Krillion window.' };
      try {
        return await session.submit(answer);
      } catch (err) {
        await drop(id);
        return { status: 'error', message: describe(err).message };
      }
    },

    async waitForResult(id) {
      const session = sessions.get(id);
      if (!session) return { status: 'error', message: 'This player has no Krillion window.' };
      try {
        return await session.waitForResult();
      } catch (err) {
        await drop(id);
        return { status: 'error', message: describe(err).message };
      }
    },

    // Asks every session at once: players who already locked in have no countdown on their page and
    // answer "null" slowly, which must not hold up the readings that matter.
    async readTimer() {
      const readings = await Promise.all([...sessions.values()].map((s) => s.readTimer().catch(() => null)));
      return readings.find((t) => t !== null) ?? null;
    },

    async advance() {
      const entries = [...sessions.entries()];
      const results = await Promise.allSettled(entries.map(([, s]) => s.next()));
      const failed = [];
      let done = false;
      let prompt = null;
      for (let i = 0; i < entries.length; i += 1) {
        const [id] = entries[i];
        const r = results[i];
        if (r.status === 'rejected') { failed.push({ id, message: describe(r.reason).message }); await drop(id); }
        else if (r.value.done) done = true;
        else prompt ??= r.value.prompt;
      }
      return { done: done || !prompt, prompt, failed };
    },

    async closeAll() {
      await Promise.all([...sessions.keys()].map(drop));
    },

    // Used by the "Test setup" button: two throwaway windows, confirm they see the same question.
    async check() {
      const settled = await Promise.allSettled([openOne(), openOne()]);
      const opened = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const lines = [];
      try {
        if (opened.length === 0) {
          return { ok: false, lines: [`✘ ${describe(settled[0].reason).message}`] };
        }
        lines.push(`✔ Chrome works and Krillion opened game ${config.gameNumber}.`);
        if (config.gameNumber > 1 && config.unlockLink) lines.push('✔ Your unlock link worked.');
        if (opened.length < 2) {
          const why = settled.find((r) => r.status === 'rejected');
          lines.push(`✘ Only one of two test windows could open${why ? `: ${describe(why.reason).message}` : '.'}`);
        } else if (opened[0].prompt.text === opened[1].prompt.text) {
          lines.push(`✔ Two separate windows got the same first question: "${opened[0].prompt.text}".`);
        } else {
          lines.push('✘ The two test windows got different questions, so a race would be unfair.');
        }
        return { ok: lines.every((l) => l.startsWith('✔')), lines };
      } finally {
        await Promise.all(opened.map((s) => s.close()));
      }
    },
  };
}
