import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testBrowser } from './browser.js';
import { startStack, until } from './stack.js';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

const SHOTS = process.env.KP_SCREENSHOTS ? path.join(import.meta.dirname, '..', 'docs', 'screens') : null;
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `phone-${name}.png`) }); } };

async function withStack(opts, fn) {
  const stack = await startStack({ browser, tv: false, ...opts }); // phones never look at the big screen
  const contexts = [];
  const phone = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`${stack.url}/play`);
    return page;
  };
  try { await fn(stack, phone); } finally { for (const c of contexts) await c.close(); await stack.close(); }
}
const join = async (page, name) => { await page.getByLabel('Your name').fill(name); await page.getByRole('button', { name: 'Join' }).click(); };

test('joins with an Arabic name and waits for the host', () => withStack({}, async (stack, phone) => {
  const page = await phone();
  await shot(page, '1-join');
  await join(page, 'مالك');
  await page.getByText(/Waiting for the host/i).waitFor();
  assert.equal(await page.locator('.chip').first().innerText(), 'مالك');
  await shot(page, '2-waiting');
}));

test('renders <b>x</b> as literal text, never as markup', () => withStack({}, async (stack, phone) => {
  const page = await phone();
  await join(page, '<b>x</b>');
  await page.locator('.chip').first().waitFor();
  assert.equal(await page.locator('.chip').first().innerText(), '<b>x</b>');
  assert.equal(await page.locator('.chip b').count(), 0);
}));

test('refuses a duplicate name with a message and lets them try another', () => withStack({}, async (stack, phone) => {
  const first = await phone();
  await join(first, 'Sam');
  await first.locator('.chip').first().waitFor();
  const second = await phone();
  await join(second, 'sam');
  await second.getByText(/taken/i).waitFor();
  await join(second, 'Sami');
  await second.getByText(/Waiting for the host/i).waitFor();
}));

test('sees the prompt and countdown after start; typing is not wiped by countdown updates', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const page = await phone();
  await join(page, 'Sam');
  await page.locator('.chip').first().waitFor();
  await stack.host('/api/host/start');
  await page.getByText('Name a noodle dish').waitFor();
  await page.getByText(/Question 1 of 7/i).waitFor();
  await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#timer').innerText)); // first countdown tick arrives shortly after
  await page.getByLabel('Your answer').fill('abc');
  await page.waitForTimeout(1300); // several countdown snapshots arrive meanwhile
  assert.equal(await page.getByLabel('Your answer').inputValue(), 'abc');
  await shot(page, '3-question');
}));

test('an unknown answer says so and can be retried; an accepted one locks in', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const a = await phone();
  const b = await phone();
  await join(a, 'Sam');
  await join(b, 'Lea');
  await b.locator('.chip').nth(1).waitFor();
  await stack.host('/api/host/start');
  await a.getByText('Name a noodle dish').waitFor();
  await a.getByLabel('Your answer').fill('zzz');
  await a.getByRole('button', { name: /^dive$/i }).click();
  await a.getByText(/wasn.t recognised/i).waitFor();
  assert.equal(await a.getByLabel('Your answer').isEnabled(), true);
  await shot(a, '4-try-again');
  await a.getByLabel('Your answer').fill('ramen');
  await a.getByRole('button', { name: /^dive$/i }).click();
  await a.locator('#status', { hasText: /Locked in/i }).waitFor();
  assert.equal(await a.getByLabel('Your answer').isDisabled(), true);
  await shot(a, '5-locked');
}));

test('a near-miss shows Krillion\'s suggestion with the box filled in, and Dive confirms it', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const page = await phone();
  await join(page, 'Sam');
  await page.locator('.chip').first().waitFor();
  await stack.host('/api/host/start');
  await page.getByText('Name a noodle dish').waitFor();
  await page.getByLabel('Your answer').fill('raman');
  await page.getByRole('button', { name: /^dive$/i }).click();
  await page.getByText(/Did you mean/i).waitFor();
  assert.match(await page.locator('#status').innerText(), /“Ramen”/);
  assert.equal(await page.getByLabel('Your answer').inputValue(), 'Ramen'); // ready to confirm
  assert.equal(await page.getByLabel('Your answer').isEnabled(), true);
  await shot(page, '4b-suggestion');
  await page.getByRole('button', { name: /^dive$/i }).click();
  await page.getByText(/You were first/i).waitFor(); // the only player: accepted, so the round closes and the results show
}));

test('the reveal shows your answer, tier, points and who was first', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const a = await phone();
  const b = await phone();
  await join(a, 'Sam');
  await join(b, 'Lea');
  await b.locator('.chip').nth(1).waitFor();
  await stack.host('/api/host/start');
  await a.getByText('Name a noodle dish').waitFor();
  await a.getByLabel('Your answer').fill('ramen');
  await a.getByRole('button', { name: /^dive$/i }).click();
  await b.getByLabel('Your answer').fill('pho');
  await b.getByRole('button', { name: /^dive$/i }).click();
  await a.getByText(/You were first/i).waitFor();
  assert.match(await a.locator('#reveal').innerText(), /Ramen/);
  assert.match(await a.locator('#reveal').innerText(), /PLANKTON/);
  assert.match(await a.locator('#reveal').innerText(), /\+10/);
  await b.getByText(/Sam was first/i).waitFor();
  assert.match(await b.locator('#reveal').innerText(), /RARE/);
  await shot(a, '6-reveal');
}));

test('a reload mid-game rejoins with the saved token', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const page = await phone();
  await join(page, 'Sam');
  await page.locator('.chip').first().waitFor();
  await stack.host('/api/host/start');
  await page.getByText('Name a noodle dish').waitFor();
  await page.reload();
  await page.getByText('Name a noodle dish').waitFor();
  await page.getByLabel('Your answer').fill('ramen');
  await page.getByRole('button', { name: /^dive$/i }).click();
  await page.getByText(/You were first/i).waitFor(); // still the same player: the server accepted the saved token
}));

test('a phone arriving after the game started is told so and cannot join', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const early = await phone();
  await join(early, 'Sam');
  await early.locator('.chip').first().waitFor();
  await stack.host('/api/host/start');
  await early.getByText('Name a noodle dish').waitFor();
  const late = await phone();
  await late.getByText(/already started/i).waitFor();
  assert.equal(await late.getByRole('button', { name: 'Join' }).count(), 0);
}));

test('a player removed by the host is sent back to the join screen', () => withStack({}, async (stack, phone) => {
  const page = await phone();
  await join(page, 'Sam');
  await page.locator('.chip').first().waitFor();
  const id = stack.party.snapshot().players[0].id;
  await stack.host('/api/host/remove', { id });
  await page.getByRole('button', { name: 'Join' }).waitFor();
  await page.getByText(/not in this game/i).waitFor();
}));

test('the final screen shows your rank and the leaderboard', () => withStack({ fakeOpts: { timerSeconds: 20 } }, async (stack, phone) => {
  const page = await phone();
  await join(page, 'Sam');
  await page.locator('.chip').first().waitFor();
  await stack.host('/api/host/start');
  for (let i = 0; i < 7; i += 1) {
    await until(async () => (await page.getByText(new RegExp(`Question ${i + 1} of 7`)).count()) > 0);
    await page.getByLabel('Your answer').fill('ramen');
    await page.getByRole('button', { name: /^dive$/i }).click();
    await page.getByText(/You were first/i).waitFor();
    await stack.host('/api/host/next');
  }
  await page.getByText(/Game over/i).waitFor();
  assert.match(await page.locator('#final').innerText(), /70/);
  await shot(page, '7-final');
}));
