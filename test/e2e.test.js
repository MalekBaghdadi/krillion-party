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
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `host-${name}.png`) }); } };

// A host screen (TV-sized) plus phones that have joined under the given names.
async function setup(opts, names, fn) {
  const stack = await startStack({ browser, ...opts });
  const contexts = [];
  try {
    const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    contexts.push(hostCtx);
    const host = await hostCtx.newPage();
    await host.goto(`${stack.url}/`);
    const phones = [];
    for (const name of names) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(`${stack.url}/play`);
      await page.getByLabel('Your name').fill(name);
      await page.getByRole('button', { name: 'Join' }).click();
      await page.getByText(/Waiting for the host/i).waitFor();
      phones.push(page);
    }
    await fn({ stack, host, phones });
  } finally { for (const c of contexts) await c.close(); await stack.close(); }
}
// Waits until a visible element's text matches (getByText only looks at descendants).
const waitText = (page, sel, re, timeout = 20000) => page.waitForFunction(([s, src, flags]) => {
  const el = document.querySelector(s);
  return Boolean(el && el.getClientRects().length && new RegExp(src, flags).test(el.innerText));
}, [sel, re.source, re.flags], { timeout });
const send = async (page, answer) => { await page.getByLabel('Your answer').fill(answer); await page.getByRole('button', { name: 'Send' }).click(); };

test('a full 7-question game with three phones', () => setup({ fakeOpts: { timerSeconds: 20 } }, ['Ann', 'Bo', 'Cy'], async ({ host, phones }) => {
  await test('lobby shows the QR and each joined player', async () => {
    await host.locator('#qr').waitFor();
    await until(async () => host.evaluate(() => document.querySelector('#qr').naturalWidth > 0));
    assert.match(await host.locator('#playUrl').innerText(), /\/play$/);
    await until(async () => (await host.locator('#lobbyPlayers .chip').count()) === 3);
    assert.deepEqual(await host.locator('#lobbyPlayers .chip .nm').allInnerTexts(), ['Ann', 'Bo', 'Cy']);
    await shot(host, '1-lobby');
  });

  await test('START opens sessions, then shows the prompt and countdown', async () => {
    await host.getByRole('button', { name: /start game/i }).click();
    await waitText(host, '#hostPrompt', /Name a noodle dish/);
    assert.match(await host.locator('#hostQ').innerText(), /Question 1 of 7/);
    await host.waitForFunction(() => /^\d+$/.test(document.querySelector('#hostTimer').innerText));
  });

  await test('host sees who has locked in, never the answers', async () => {
    await phones[0].getByText('Name a noodle dish').waitFor();
    await send(phones[0], 'ramen');
    await host.locator('#hostChips .chip.locked').waitFor();
    assert.equal(await host.locator('#hostChips .chip.locked').count(), 1);
    assert.match(await host.locator('#hostLocked').innerText(), /1 of 3/);
    assert.equal(/ramen/i.test(await host.locator('#stage').innerText()), false);
    await shot(host, '2-question');
  });

  await test('reveal marks the race winner and shows tiers and points', async () => {
    await send(phones[1], 'pho');
    await send(phones[2], 'champon');
    await waitText(host, '#hostFlash', /Ann was first/);
    const rows = await host.locator('#hostTable tbody tr').allInnerTexts();
    assert.equal(rows.length, 3);
    assert.match(rows.join('|'), /PLANKTON/);
    assert.match(rows.join('|'), /RARE/);
    assert.match(rows.join('|'), /ONE IN A KRILLION/);
    assert.match(rows.join('|'), /\+100/);
    await shot(host, '3-reveal');
  });

  await test('after 7 questions the leaderboard totals equal the points, and Ann won every race', async () => {
    await host.getByRole('button', { name: /next question/i }).click();
    for (let i = 1; i < 7; i += 1) {
      await waitText(host, '#hostQ', new RegExp(`Question ${i + 1} of 7`));
      for (const [k, page] of phones.entries()) {
        await page.getByText(new RegExp(`Question ${i + 1} of 7`)).waitFor();
        await send(page, ['ramen', 'pho', 'champon'][k]);
      }
      await host.locator('#hostFlash').waitFor();
      await host.getByRole('button', { name: /next question|final results/i }).click();
    }
    await host.locator('#podium').waitFor();
    const rows = await host.locator('#finalBoard li').allInnerTexts();
    const flat = rows.map((r) => r.replace(/\s+/g, ' '));
    assert.match(flat[0], /Cy 700/);
    assert.match(flat[1], /Bo 420/);
    assert.match(flat[2], /Ann 70 ⚡7/); // earliest typist in all seven races
    const total = (await host.locator('#finalBoard .score').allInnerTexts()).reduce((n, s) => n + Number(s), 0);
    assert.equal(total, 7 * (10 + 60 + 100));
    assert.match(await host.locator('#podium').innerText(), /Cy/);
    await shot(host, '4-finished');
  });

  await test('Play again returns to the lobby with the players kept', async () => {
    await host.getByRole('button', { name: /play again/i }).click();
    await host.getByRole('button', { name: /start game/i }).waitFor();
    assert.equal(await host.locator('#lobbyPlayers .chip').count(), 3);
  });
}));

test('Space starts the game and Enter moves on', () => setup({ fakeOpts: { timerSeconds: 20 } }, ['Ann'], async ({ host, phones }) => {
  await host.locator('#lobbyPlayers .chip').waitFor();
  await host.locator('body').click({ position: { x: 5, y: 5 } });
  await host.keyboard.press('Space');
  await waitText(host, '#hostPrompt', /Name a noodle dish/);
  await phones[0].getByText('Name a noodle dish').waitFor();
  await send(phones[0], 'ramen');
  await host.locator('#hostFlash').waitFor();
  await host.locator('body').click({ position: { x: 5, y: 5 } });
  await host.keyboard.press('Enter');
  await waitText(host, '#hostQ', /Question 2 of 7/);
}));

test('Test setup explains a locked game, and passes on a free one', async () => {
  await setup({ config: { gameNumber: 2, unlockLink: '' } }, [], async ({ host }) => {
    await host.getByRole('button', { name: /test setup/i }).click();
    await waitText(host, '#checkResult', /unlock link/i, 30000);
    assert.match(await host.locator('#checkResult').innerText(), /✘/);
  });
  await setup({}, [], async ({ host }) => {
    await host.getByRole('button', { name: /test setup/i }).click();
    await waitText(host, '#checkResult', /same first question/i, 30000);
    assert.match(await host.locator('#checkResult').innerText(), /✔ Chrome works/);
  });
});

test('Settings saves the game number and says the unlock link is saved, without ever showing it', () => setup({}, [], async ({ host, stack }) => {
  await host.getByRole('button', { name: /settings/i }).click();
  await host.locator('#gameNumber').fill('3');
  await host.locator('#unlockLink').fill('https://krillion.io/unlock?session_id=cs_live_SECRET123');
  await host.getByRole('button', { name: /^save/i }).click();
  await waitText(host, '#linkStatus', /unlock link saved/i);
  assert.equal(await host.locator('#unlockLink').inputValue(), '');
  const everything = await host.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' ') + document.documentElement.innerHTML);
  assert.equal(everything.includes('SECRET123'), false);
  const settings = await (await fetch(`${stack.url}/api/host/settings`)).json();
  assert.equal(settings.gameNumber, 3);
  assert.equal(settings.hasUnlockLink, true);
  await host.getByRole('button', { name: /remove link/i }).click();
  await waitText(host, '#linkStatus', /no unlock link/i);
  await host.locator('#unlockLink').fill('not a link');
  await host.getByRole('button', { name: /^save/i }).click();
  await waitText(host, '#settingsError', /doesn't look like/i);
}));

test('the host can remove a player in the lobby', () => setup({}, ['Ann', 'Ghost'], async ({ host, phones }) => {
  await until(async () => (await host.locator('#lobbyPlayers .chip').count()) === 2);
  await host.getByRole('button', { name: 'Remove Ghost' }).click();
  await until(async () => (await host.locator('#lobbyPlayers .chip').count()) === 1);
  await phones[1].getByRole('button', { name: 'Join' }).waitFor();
}));

test('Start with nobody joined explains what to do instead of failing silently', () => setup({}, [], async ({ host }) => {
  assert.equal(await host.getByRole('button', { name: /start game/i }).isDisabled(), true);
  await host.getByText(/waiting for players/i).first().waitFor();
}));

test('the host can switch the address the QR code uses when phones cannot connect', () => setup({ addresses: ['192.168.1.5', '10.0.0.4'] }, [], async ({ host }) => {
  await waitText(host, '#playUrl', /192\.168\.1\.5:\d+\/play/);
  await host.getByRole('button', { name: '10.0.0.4' }).click();
  await waitText(host, '#playUrl', /10\.0\.0\.4:\d+\/play/);
  assert.equal(await host.getByRole('button', { name: '10.0.0.4' }).getAttribute('aria-pressed'), 'true');
}));

test('with a single network address the picker stays out of the way', () => setup({ addresses: ['192.168.1.5'] }, [], async ({ host }) => {
  await waitText(host, '#playUrl', /192\.168\.1\.5/);
  assert.equal(await host.locator('#otherAddresses').isVisible(), false);
}));
