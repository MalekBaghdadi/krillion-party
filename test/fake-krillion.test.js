import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFake } from './fake-krillion.js';
import { testBrowser } from './browser.js';

let browser;
before(async () => { browser = await testBrowser(); });
after(async () => { await browser?.close(); });

async function openGame(fake, game = 1) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${fake.url}/unlimited/classic?game=${game}`);
  return { ctx, page };
}

test('plays a dive with the real selectors', async () => {
  const fake = await startFake();
  const { ctx, page } = await openGame(fake);
  await page.locator('.ds-begin-btn').click({ force: true });
  assert.equal(await page.locator('.prompt').innerText(), 'Name a noodle dish');
  assert.match(await page.locator('.ds-prompt-count').innerText(), /PROMPT 1 OF 7/);
  await page.locator('input.ds-input').fill('ramen');
  await page.keyboard.press('Enter');
  await page.locator('.ds-next-btn').waitFor();
  assert.equal(await page.locator('.tname').innerText(), 'PLANKTON');
  assert.equal(await page.locator('.tpts b').innerText(), '+10 PTS');
  await ctx.close(); await fake.close();
});

test('rejects unknown answers without ending the prompt', async () => {
  const fake = await startFake();
  const { ctx, page } = await openGame(fake);
  await page.locator('.ds-begin-btn').click({ force: true });
  await page.locator('input.ds-input').fill('zzz');
  await page.keyboard.press('Enter');
  await page.getByText(/no echo\. try again/).waitFor();
  assert.equal(await page.locator('input.ds-input').isVisible(), true);
  await ctx.close(); await fake.close();
});

test('times out when the clock runs out', async () => {
  const fake = await startFake({ timerSeconds: 1 });
  const { ctx, page } = await openGame(fake);
  await page.locator('.ds-begin-btn').click({ force: true });
  await page.getByText('NOTHING LANDED').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.ds-next-btn').isVisible(), true);
  await ctx.close(); await fake.close();
});

test('locks game 2 until re-armed', async () => {
  const fake = await startFake();
  const { ctx, page } = await openGame(fake, 2);
  await page.getByText('UNLOCK UNLIMITED').waitFor();
  assert.equal(await page.locator('.ds-begin-btn').count(), 0);

  await page.goto(`${fake.url}/restore?pack=classic`);
  await page.locator('input[placeholder*="unlock?session_id"]').fill('https://krillion.io/unlock?session_id=wrong');
  await page.getByText('RE-ARM WITH LINK').click();
  await page.getByText("that link didn't work").waitFor();

  await page.locator('input[placeholder*="unlock?session_id"]').fill('https://krillion.io/unlock?session_id=cs_test');
  await page.getByText('RE-ARM WITH LINK').click();
  await page.waitForURL(/\/unlimited\/classic/);
  await page.goto(`${fake.url}/unlimited/classic?game=2`);
  await page.locator('.ds-begin-btn').waitFor();
  await ctx.close(); await fake.close();
});
