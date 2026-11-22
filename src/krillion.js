// Drives the real krillion.io in a browser, one isolated session per player.
// Everything this file knows about the site is listed in docs/krillion-dom.md.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Messages are written for the people at the party, not for developers.
export class KrillionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KrillionError';
    this.code = code; // NO_BROWSER | LOCKED | UNLOCK_FAILED | SITE_CHANGED | ERROR
  }
}

export async function launchBrowser({ headless = true } = {}) {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless });
    } catch { /* try the next browser */ }
  }
  throw new KrillionError('NO_BROWSER', 'Google Chrome was not found on this computer. Please install Chrome (google.com/chrome) and start again.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The first line of an error, without colour codes: safe to log, never a wall of text.
export const plainLine = (err) => String(err?.message ?? err).replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0].trim().slice(0, 200);

// Polls until one of the locators is visible and returns its name (or null on timeout).
// Polling beats Locator.or() here: or() can resolve to a hidden element that comes first in the DOM.
async function waitForAny(candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [name, locator] of Object.entries(candidates)) {
      if (await locator.first().isVisible().catch(() => false)) return name;
    }
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

async function saveScreenshot(page, debugDir) {
  if (!debugDir || page.isClosed()) return null;
  const url = page.url();
  if (/restore|unlock/i.test(url)) return null; // those pages can show the unlock link
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const file = path.join(debugDir, `krillion-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}

const SITE_CHANGED_TEXT = "Krillion doesn't look the way this app expects, so it can't play it right now. The website may have changed.";

async function explain(page, err, { debugDir, secrets = [] }) {
  if (err instanceof KrillionError) {
    if (err.code === 'SITE_CHANGED') await saveScreenshot(page, debugDir);
    return err;
  }
  let msg = String(err?.message ?? err).split('\n')[0]; // first line only: later lines can echo typed values
  for (const s of secrets.filter(Boolean)) msg = msg.split(s).join('[link]');
  if (/net::ERR_|ENOTFOUND|getaddrinfo|ERR_INTERNET/i.test(msg)) {
    return new KrillionError('ERROR', "Couldn't reach krillion.io. Check this computer's internet connection.");
  }
  if (err?.name === 'TimeoutError') {
    await saveScreenshot(page, debugDir);
    return new KrillionError('SITE_CHANGED', SITE_CHANGED_TEXT);
  }
  return new KrillionError('ERROR', `Krillion session problem: ${msg}`);
}

export class KrillionSession {
  constructor(context, page, { stepTimeoutMs, debugDir }) {
    this.context = context;
    this.page = page;
    this.stepTimeoutMs = stepTimeoutMs;
    this.debugDir = debugDir;
    this.prompt = null; // {index (0-based), total, text}
  }

  async readPrompt() {
    const text = (await this.page.locator('.prompt').first().innerText()).trim();
    const count = await this.page.locator('.ds-prompt-count').first().innerText();
    const m = /(\d+)\s*OF\s*(\d+)/i.exec(count);
    if (!m) throw new KrillionError('SITE_CHANGED', SITE_CHANGED_TEXT);
    return { index: Number(m[1]) - 1, total: Number(m[2]), text };
  }

  async readTimer() {
    try {
      const n = Number.parseInt(await this.page.locator('.ds-time-digits').first().innerText({ timeout: 300 }), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  // Reads the result card that is on screen: accepted (tier, answer, points) or a timeout.
  async readResult() {
    const { page } = this;
    const which = await waitForAny({ hit: page.locator('.tname'), miss: page.getByText('NOTHING LANDED') }, 5000);
    if (!which) throw new KrillionError('SITE_CHANGED', SITE_CHANGED_TEXT);
    const text = async (sel) => (await page.locator(sel).first().innerText({ timeout: 2000 }).catch(() => '')).trim();
    const tier = await text('.tname');
    // A timeout reuses the accepted card with the tier "NOTHING LANDED" (seen on the live site).
    if (which === 'miss' || /NOTHING LANDED/i.test(tier)) return { status: 'timeout' };
    const points = Number.parseInt((await text('.tpts b')).replace(/[^\d]/g, ''), 10);
    return {
      status: 'accepted',
      tier,
      answer: (await text('.tans')).replace(/^[“"']|[”"']$/g, ''),
      points: Number.isFinite(points) ? points : 0,
      flavor: await text('.tsub'),
    };
  }

  // Types one answer. Returns {status:'rejected'} or the final result once the card shows.
  async submit(answer) {
    const { page } = this;
    const card = page.locator('.ds-next-btn');
    const cardUp = () => card.first().isVisible().catch(() => false);
    const input = page.locator('input.ds-input');
    // An answer can arrive just as the clock runs out: the result card is already up and the box
    // is gone. Never wait for a box that isn't there (it could reappear on the NEXT question and
    // receive this answer by mistake): report what the card says instead.
    if (await cardUp()) return this.readResult();
    if (!(await input.first().isVisible().catch(() => false))) return { status: 'rejected' };
    try {
      await input.fill(answer, { timeout: 2000 });
      await input.press('Enter', { timeout: 2000 });
    } catch (err) {
      if (await cardUp()) return this.readResult();
      if (err?.name === 'TimeoutError') return { status: 'rejected' };
      throw err;
    }
    const rejectedNote = page.getByText(/try again/i).filter({ hasText: answer });
    const which = await waitForAny({ card: page.locator('.ds-next-btn'), rejected: rejectedNote }, Math.max(this.stepTimeoutMs, 8000));
    if (page.isClosed()) throw new KrillionError('ERROR', 'The Krillion window was closed.');
    if (which === 'card') return this.readResult();
    return { status: 'rejected' }; // also covers "nothing recognisable happened": the prompt is still open
  }

  // Settles when this prompt's result card shows, whoever caused it (an answer or the clock).
  async waitForResult() {
    const which = await waitForAny({ card: this.page.locator('.ds-next-btn') }, Math.max(this.stepTimeoutMs, 60000));
    if (which !== 'card') throw new KrillionError('ERROR', 'Krillion stopped responding.');
    return this.readResult();
  }

  async next() {
    const last = this.prompt.index + 1 >= this.prompt.total;
    await this.page.locator('.ds-next-btn').first().click({ force: true });
    if (last) return { done: true };
    await this.page.locator('input.ds-input').waitFor({ state: 'visible' });
    this.prompt = await this.readPrompt();
    return { done: false, prompt: this.prompt };
  }

  async close() {
    await this.context.close().catch(() => {});
  }

  // ---- start-up helpers (used by openSession) ----

  async openGamePage(gameUrl) {
    const { page } = this;
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
    const begin = page.locator('.ds-begin-btn');
    const which = await waitForAny({ begin, locked: page.getByText(/UNLOCK UNLIMITED/i) }, this.stepTimeoutMs);
    if (which === 'begin') return 'ok';
    if (which === 'locked') return 'locked';
    const body = await page.innerText('body').catch(() => '');
    if (/unlock/i.test(body)) return 'locked';
    throw new KrillionError('SITE_CHANGED', SITE_CHANGED_TEXT);
  }

  // Both re-arm paths are best effort: the real test is whether the game opens afterwards.
  async rearmWithForm(baseUrl, link) {
    const { page } = this;
    try {
      await page.goto(`${baseUrl}/restore?pack=classic`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[placeholder*="unlock?session_id"]').first().fill(link);
      await page.getByText('RE-ARM WITH LINK').first().click({ force: true });
      await page.waitForFunction(
        () => !location.pathname.startsWith('/restore') || /didn.?t work|invalid|expired|not found|try again/i.test(document.body.innerText),
        null,
        { timeout: Math.min(this.stepTimeoutMs, 8000) },
      ).catch(() => {});
      await sleep(800);
    } catch { /* fall through to the next method */ }
  }

  async rearmWithDirectLink(baseUrl, link) {
    const { page } = this;
    try {
      const u = new URL(link);
      await page.goto(`${baseUrl}${u.pathname}${u.search}`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await sleep(1000);
    } catch { /* verified by opening the game next */ }
  }

  async start({ baseUrl, gameNumber, unlockLink }) {
    const { page } = this;
    const gameUrl = `${baseUrl}/unlimited/classic?game=${gameNumber}`;
    let state = await this.openGamePage(gameUrl);
    if (state === 'locked') {
      if (!unlockLink) {
        throw new KrillionError('LOCKED', `Game ${gameNumber} is locked. Add your Krillion unlock link in Settings, or play game 1, which is free.`);
      }
      for (const rearm of [this.rearmWithForm, this.rearmWithDirectLink]) {
        await rearm.call(this, baseUrl, unlockLink);
        state = await this.openGamePage(gameUrl);
        if (state === 'ok') break;
      }
      if (state !== 'ok') {
        throw new KrillionError('UNLOCK_FAILED', "Krillion didn't accept the unlock link. Check that the whole link was copied, or play game 1, which is free.");
      }
    }
    await page.locator('.ds-begin-btn').first().click({ force: true });
    await page.locator('input.ds-input').first().waitFor({ state: 'visible' });
    this.prompt = await this.readPrompt();
  }
}

export async function openSession(browser, opts = {}) {
  const { baseUrl = 'https://krillion.io', gameNumber = 1, unlockLink = '', stepTimeoutMs = 20000, debugDir } = opts;
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  page.setDefaultTimeout(stepTimeoutMs);
  const session = new KrillionSession(context, page, { stepTimeoutMs, debugDir });
  try {
    await session.start({ baseUrl, gameNumber, unlockLink });
    return session;
  } catch (err) {
    const wrapped = await explain(page, err, { debugDir, secrets: [unlockLink] });
    await context.close().catch(() => {});
    throw wrapped;
  }
}
