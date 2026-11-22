// The game rules, with no I/O: players, prompts, attempts, the race winner and scores.
// Everything here is plain data so it can be tested with a fake clock.
import { randomUUID } from 'node:crypto';

// Messages on a GameError are friendly on purpose: they are shown to players on their phones.
export class GameError extends Error {}

const MAX_NAME = 20;
const MAX_ANSWER = 60;

const tidy = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => Array.from(s).slice(0, n).join('').trim(); // code points, so emoji count as one

const freshRound = () => ({ attempts: 0, tried: new Set(), pending: null, rejected: null, status: null, result: null, receivedAt: null, message: null });

export function createGame({ now = Date.now, maxPlayers = 8, maxAttempts = 5 } = {}) {
  let phase = 'lobby'; // lobby | starting | prompt | reveal | finished
  let prompt = null;
  let reveal = null;
  const players = [];

  const find = (id) => players.find((p) => p.id === id);

  function join(name) {
    if (phase !== 'lobby') throw new GameError('This game has already started. Join the next one!');
    if (players.length >= maxPlayers) throw new GameError(`The game is full (${maxPlayers} players).`);
    const clean = clip(tidy(name), MAX_NAME);
    if (!clean) throw new GameError('Please type your name.');
    const key = clean.toLocaleLowerCase();
    if (players.some((p) => p.name.toLocaleLowerCase() === key)) {
      throw new GameError(`The name "${clean}" is taken. Please pick another one.`);
    }
    const player = { id: randomUUID(), token: randomUUID(), name: clean, score: 0, raceWins: 0, errored: false, round: null };
    players.push(player);
    return { id: player.id, token: player.token };
  }

  const playerByToken = (token) => players.find((p) => p.token === token) ?? null;

  function removePlayer(id) {
    if (phase !== 'lobby') return;
    const i = players.findIndex((p) => p.id === id);
    if (i >= 0) players.splice(i, 1);
  }

  function resetScores() {
    for (const p of players) Object.assign(p, { score: 0, raceWins: 0, errored: false, round: null });
    prompt = null;
    reveal = null;
  }

  function begin() {
    if (phase !== 'lobby' && phase !== 'finished') throw new GameError('A game is already running.');
    if (players.length === 0) throw new GameError('Waiting for players to join.');
    resetScores();
    phase = 'starting';
  }

  function openPrompt({ index, total, text }) {
    prompt = { index, total, text };
    phase = 'prompt';
    for (const p of players) {
      p.round = freshRound();
      if (p.errored) p.round.status = 'error';
    }
  }

  function recordAttempt(playerId, answer) {
    const p = find(playerId);
    if (phase !== 'prompt' || !p) return { ok: false, reason: 'closed' };
    const r = p.round;
    if (r.status) return { ok: false, reason: 'resolved' };
    if (r.pending) return { ok: false, reason: 'busy' };
    if (r.attempts >= maxAttempts) return { ok: false, reason: 'too-many' };
    const clean = tidy(answer);
    if (!clean || Array.from(clean).length > MAX_ANSWER) return { ok: false, reason: 'invalid' };
    const key = clean.toLocaleLowerCase();
    if (r.tried.has(key)) return { ok: false, reason: 'repeat' };
    r.attempts += 1;
    r.tried.add(key);
    r.pending = { answer: clean, receivedAt: now() };
    return { ok: true, receivedAt: r.pending.receivedAt, answer: clean };
  }

  function recordResult(playerId, result) {
    const p = find(playerId);
    if (!p) return;
    if (!p.round) p.round = freshRound(); // an error can arrive before the first prompt opens
    const r = p.round;
    if (result.status === 'error') {
      p.errored = true; // sticks even after this prompt resolved: the session is gone for the next ones
      if (!r.status) { r.status = 'error'; r.message = result.message ?? 'Something went wrong.'; }
      r.pending = null;
      return;
    }
    if (r.status) return; // first outcome wins; later duplicates are ignored
    switch (result.status) {
      case 'rejected':
        r.rejected = r.pending?.answer ?? null;
        r.pending = null;
        break;
      case 'accepted':
        r.status = 'accepted';
        r.receivedAt = r.pending?.receivedAt ?? now();
        r.result = { answer: result.answer, tier: result.tier, points: result.points, flavor: result.flavor ?? '' };
        r.pending = null;
        break;
      case 'timeout':
        r.status = 'timeout';
        r.pending = null;
        break;
    }
  }

  const allResolved = () => players.every((p) => p.round?.status);

  function closePrompt() {
    if (phase !== 'prompt') throw new GameError('There is no open prompt.');
    const entries = players.map((p) => {
      const r = p.round;
      const status = r.status ?? 'timeout';
      return { playerId: p.id, name: p.name, status, ...(status === 'accepted' ? r.result : {}) };
    });
    let winner = null;
    for (const p of players) { // players are in join order, so ties keep the earlier joiner
      if (p.round.status === 'accepted' && (!winner || p.round.receivedAt < winner.round.receivedAt)) winner = p;
    }
    for (const p of players) if (p.round.status === 'accepted') p.score += p.round.result.points;
    if (winner) winner.raceWins += 1;
    reveal = { winnerId: winner?.id ?? null, entries };
    phase = 'reveal';
    return reveal;
  }

  const finish = () => { phase = 'finished'; };

  function reset() {
    resetScores();
    phase = 'lobby';
  }

  function viewOf(p) {
    const r = p.round;
    let status = 'idle';
    if (r?.status === 'accepted') status = 'locked';
    else if (r?.status) status = r.status;
    else if (r?.pending) status = 'pending';
    return {
      id: p.id,
      name: p.name,
      status,
      answer: r?.result?.answer ?? null,
      rejected: r?.rejected ?? null,
      attemptsLeft: r ? Math.max(0, maxAttempts - r.attempts) : maxAttempts,
    };
  }

  function snapshot(viewerId) {
    const viewer = viewerId ? find(viewerId) : null;
    return {
      phase,
      prompt,
      players: players.map((p) => ({
        id: p.id, name: p.name, score: p.score, raceWins: p.raceWins,
        locked: phase === 'prompt' && p.round?.status === 'accepted',
        errored: p.errored,
      })),
      reveal: phase === 'reveal' || phase === 'finished' ? reveal : null,
      you: viewer ? viewOf(viewer) : null,
    };
  }

  return { join, playerByToken, removePlayer, begin, openPrompt, recordAttempt, recordResult, allResolved, closePrompt, finish, reset, snapshot };
}
