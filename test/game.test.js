import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/game.js';

function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

// A game with the given names, started, with prompt 0 open.
function started(names, opts = {}) {
  const c = clock();
  const g = createGame({ now: c.now, ...opts });
  const ids = names.map((n) => g.join(n).id);
  g.begin();
  g.openPrompt({ index: 0, total: 7, text: 'Name a noodle dish' });
  return { g, c, ids };
}

const accepted = (points = 10, answer = 'Ramen') => ({ status: 'accepted', tier: 'PLANKTON', answer, points, flavor: 'meh' });

test('trims names, collapses spaces and keeps Arabic and emoji', () => {
  const g = createGame();
  g.join('  مالك   🦐 ');
  assert.equal(g.snapshot().players[0].name, 'مالك 🦐');
});

test('refuses duplicate names case-insensitively', () => {
  const g = createGame();
  g.join('Sam');
  assert.throws(() => g.join('sam'), (e) => e instanceof GameError && /taken/.test(e.message) && /sam/i.test(e.message));
});

test('refuses an empty name with a friendly message', () => {
  const g = createGame();
  assert.throws(() => g.join('   '), (e) => e instanceof GameError && /name/i.test(e.message));
});

test('truncates a 40 char name to 20 characters, counting emoji as one', () => {
  const g = createGame();
  g.join('x'.repeat(40));
  g.join('🦐'.repeat(30));
  const [a, b] = g.snapshot().players;
  assert.equal(Array.from(a.name).length, 20);
  assert.equal(Array.from(b.name).length, 20);
});

test('keeps <img onerror> as literal text', () => {
  const g = createGame();
  g.join('<img src=x onerror=alert(1)>');
  assert.equal(g.snapshot().players[0].name, '<img src=x onerror=a');
});

test('refuses joins past maxPlayers and after the game has begun', () => {
  const g = createGame({ maxPlayers: 2 });
  g.join('a'); g.join('b');
  assert.throws(() => g.join('c'), (e) => e instanceof GameError && /full/i.test(e.message));
  g.begin();
  assert.throws(() => g.join('d'), (e) => e instanceof GameError && /already started/i.test(e.message));
});

test('begin needs at least one player', () => {
  assert.throws(() => createGame().begin(), GameError);
});

test('playerByToken finds the player and rejects unknown tokens', () => {
  const g = createGame();
  const { id, token } = g.join('Sam');
  assert.equal(g.playerByToken(token).id, id);
  assert.equal(g.playerByToken('nope'), null);
});

test('recordAttempt: ok, invalid, busy, repeat, too-many, resolved, closed', () => {
  const lobby = createGame();
  const id0 = lobby.join('x').id;
  assert.deepEqual(lobby.recordAttempt(id0, 'ramen'), { ok: false, reason: 'closed' });

  const { g, c, ids } = started(['a', 'b'], { maxAttempts: 5 });
  const [a, b] = ids;
  assert.deepEqual(g.recordAttempt(a, '   '), { ok: false, reason: 'invalid' });
  assert.deepEqual(g.recordAttempt(a, 'x'.repeat(61)), { ok: false, reason: 'invalid' });

  const first = g.recordAttempt(a, '  pho  ');
  assert.equal(first.ok, true);
  assert.equal(first.receivedAt, c.now());
  assert.equal(first.answer, 'pho'); // the cleaned text is what gets typed into Krillion
  assert.deepEqual(g.recordAttempt(a, 'pad thai'), { ok: false, reason: 'busy' });

  g.recordResult(a, { status: 'rejected' });
  assert.deepEqual(g.recordAttempt(a, 'PHO'), { ok: false, reason: 'repeat' });

  for (const w of ['w1', 'w2', 'w3', 'w4']) {
    assert.equal(g.recordAttempt(b, w).ok, true);
    g.recordResult(b, { status: 'rejected' });
  }
  assert.equal(g.recordAttempt(b, 'w5').ok, true);
  g.recordResult(b, { status: 'rejected' });
  assert.deepEqual(g.recordAttempt(b, 'w6'), { ok: false, reason: 'too-many' });

  assert.equal(g.recordAttempt(a, 'ramen').ok, true);
  g.recordResult(a, accepted());
  assert.deepEqual(g.recordAttempt(a, 'udon'), { ok: false, reason: 'resolved' });
});

test('recordResult is idempotent once resolved', () => {
  const { g, ids } = started(['a']);
  g.recordAttempt(ids[0], 'ramen');
  g.recordResult(ids[0], accepted(10));
  g.recordResult(ids[0], accepted(99));
  g.recordResult(ids[0], { status: 'timeout' });
  const r = g.closePrompt();
  assert.equal(r.entries[0].points, 10);
  assert.equal(r.entries[0].status, 'accepted');
});

test('a session that dies after answering still marks the player errored for later prompts', () => {
  const { g, ids } = started(['a', 'b']);
  g.recordAttempt(ids[0], 'ramen');
  g.recordResult(ids[0], accepted(10));
  g.recordResult(ids[0], { status: 'error', message: 'Chrome closed' });
  g.recordResult(ids[1], { status: 'timeout' });
  const r = g.closePrompt();
  assert.equal(r.entries[0].status, 'accepted'); // this prompt's result stands
  g.openPrompt({ index: 1, total: 7, text: 'Next' });
  assert.equal(g.snapshot().players[0].errored, true);
  g.recordResult(ids[1], { status: 'timeout' });
  assert.equal(g.allResolved(), true);
});

test('winner is the earliest receivedAt even if its result is recorded last', () => {
  const { g, c, ids } = started(['fast', 'slow']);
  const [fast, slow] = ids;
  g.recordAttempt(fast, 'pho'); c.tick(50);
  g.recordAttempt(slow, 'ramen');
  g.recordResult(slow, accepted(10));
  g.recordResult(fast, accepted(60, 'Pho'));
  assert.equal(g.allResolved(), true);
  assert.equal(g.closePrompt().winnerId, fast);
});

test('no winner when nobody is accepted', () => {
  const { g, ids } = started(['a', 'b']);
  g.recordResult(ids[0], { status: 'timeout' });
  g.recordResult(ids[1], { status: 'error', message: 'boom' });
  const r = g.closePrompt();
  assert.equal(r.winnerId, null);
  assert.deepEqual(r.entries.map((e) => e.status), ['timeout', 'error']);
});

test('equal receivedAt resolves to the earlier joiner', () => {
  const { g, ids } = started(['first', 'second']);
  g.recordAttempt(ids[1], 'ramen');
  g.recordAttempt(ids[0], 'pho');
  g.recordResult(ids[1], accepted(10));
  g.recordResult(ids[0], accepted(60));
  assert.equal(g.closePrompt().winnerId, ids[0]);
});

test('closePrompt adds points and race wins; unresolved players count as timeout', () => {
  const { g, ids } = started(['a', 'b', 'c']);
  g.recordAttempt(ids[0], 'pho');
  g.recordResult(ids[0], accepted(60, 'Pho'));
  g.recordResult(ids[1], { status: 'timeout' });
  assert.equal(g.allResolved(), false);
  const r = g.closePrompt();
  assert.equal(r.entries[2].status, 'timeout');
  const snap = g.snapshot();
  assert.equal(snap.phase, 'reveal');
  assert.deepEqual(snap.players.map((p) => [p.score, p.raceWins]), [[60, 1], [0, 0], [0, 0]]);
});

test('an errored player stays resolved on later prompts and the game moves on', () => {
  const { g, ids } = started(['a', 'b']);
  g.recordResult(ids[1], { status: 'error', message: 'Chrome closed' });
  g.recordResult(ids[0], { status: 'timeout' });
  g.closePrompt();
  g.openPrompt({ index: 1, total: 7, text: 'Name a great ape' });
  g.recordResult(ids[0], { status: 'timeout' });
  assert.equal(g.allResolved(), true);
  assert.equal(g.snapshot().players[1].errored, true);
});

test('snapshot hides answers until reveal and shows only the viewer their own state', () => {
  const { g, ids } = started(['a', 'b']);
  g.recordAttempt(ids[0], 'pho');
  g.recordResult(ids[0], accepted(60, 'Pho'));
  const forB = g.snapshot(ids[1]);
  assert.equal(JSON.stringify(forB).includes('Pho'), false);
  assert.equal(forB.players[0].locked, true);
  assert.equal(forB.you.status, 'idle');
  assert.equal(g.snapshot(ids[0]).you.status, 'locked');
  g.recordResult(ids[1], { status: 'timeout' });
  g.closePrompt();
  assert.equal(JSON.stringify(g.snapshot(ids[1]).reveal).includes('Pho'), true);
});

test('a suggestion leaves the player open, costs no try, and is offered back to that player only', () => {
  const { g, ids } = started(['a', 'b'], { maxAttempts: 2 });
  assert.equal(g.recordAttempt(ids[0], 'raman').ok, true);
  g.recordResult(ids[0], { status: 'suggestion', typed: 'raman', suggestion: 'Ramen' });
  const you = g.snapshot(ids[0]).you;
  assert.deepEqual(you.suggestion, { typed: 'raman', text: 'Ramen' });
  assert.equal(you.status, 'idle');
  assert.equal(you.rejected, null);
  assert.equal(you.attemptsLeft, 2); // the suggestion was free
  assert.equal(JSON.stringify(g.snapshot(ids[1])).includes('Ramen'), false); // nobody else sees it
  assert.equal(g.snapshot().players[0].locked, false); // and it is not an answer yet

  assert.equal(g.recordAttempt(ids[0], 'phoo').ok, true); // a second suggestion is free too
  g.recordResult(ids[0], { status: 'suggestion', typed: 'phoo', suggestion: 'Pho' });
  assert.equal(g.recordAttempt(ids[0], 'x1').ok, true);
  g.recordResult(ids[0], { status: 'rejected' });
  assert.equal(g.snapshot(ids[0]).you.suggestion, null); // a rejection replaces the suggestion
  assert.equal(g.recordAttempt(ids[0], 'x2').ok, true);
  g.recordResult(ids[0], { status: 'rejected' });
  assert.deepEqual(g.recordAttempt(ids[0], 'x3'), { ok: false, reason: 'too-many' }); // only the two rejections counted
});

test('answering clears the suggestion, and accepting the suggested answer wins as usual', () => {
  const { g, ids } = started(['a']);
  g.recordAttempt(ids[0], 'raman');
  g.recordResult(ids[0], { status: 'suggestion', typed: 'raman', suggestion: 'Ramen' });
  assert.equal(g.recordAttempt(ids[0], 'Ramen').ok, true);
  assert.equal(g.snapshot(ids[0]).you.suggestion, null);
  g.recordResult(ids[0], accepted(10));
  assert.equal(g.closePrompt().winnerId, ids[0]);
});

test('the viewer sees their last rejected answer', () => {
  const { g, ids } = started(['a']);
  g.recordAttempt(ids[0], 'zzz');
  assert.equal(g.snapshot(ids[0]).you.status, 'pending');
  g.recordResult(ids[0], { status: 'rejected' });
  const you = g.snapshot(ids[0]).you;
  assert.equal(you.status, 'idle');
  assert.equal(you.rejected, 'zzz');
});

test('finish then begin again zeroes scores; reset keeps players', () => {
  const { g, ids } = started(['a', 'b']);
  g.recordAttempt(ids[0], 'pho');
  g.recordResult(ids[0], accepted(60));
  g.recordResult(ids[1], { status: 'timeout' });
  g.closePrompt();
  g.finish();
  assert.equal(g.snapshot().phase, 'finished');
  g.reset();
  const snap = g.snapshot();
  assert.equal(snap.phase, 'lobby');
  assert.deepEqual(snap.players.map((p) => [p.name, p.score, p.raceWins, p.errored]), [['a', 0, 0, false], ['b', 0, 0, false]]);
  assert.equal(snap.reveal, null);
});

test('leader() is the earliest typist among the accepted so far, and null before anyone is accepted', () => {
  const { g, c, ids } = started(['Ann', 'Bo', 'Cy']);
  assert.equal(g.leader(), null);
  c.tick(10); g.recordAttempt(ids[1], 'pho');
  c.tick(10); g.recordAttempt(ids[0], 'ramen');
  g.recordResult(ids[0], accepted(10, 'Ramen')); // Ann typed second but was accepted first
  assert.deepEqual(g.leader(), { playerId: ids[0], answer: 'Ramen' });
  g.recordResult(ids[1], accepted(60, 'Pho')); // Bo typed earlier: now he leads
  assert.deepEqual(g.leader(), { playerId: ids[1], answer: 'Pho' });
  g.recordResult(ids[2], { status: 'timeout' });
  assert.equal(g.closePrompt().winnerId, ids[1]); // the same rule decides the real winner
});
