import { chromium } from 'playwright-core';

// Tests drive the machine's own Chrome (or Edge); nothing is downloaded.
export async function testBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch { /* try the next browser */ }
  }
  throw new Error('The tests need Google Chrome or Microsoft Edge installed.');
}
