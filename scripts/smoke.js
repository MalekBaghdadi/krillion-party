#!/usr/bin/env node
// Live check against the real krillion.io (free game 1, no login). Run: npm run smoke
// If this fails, Krillion probably changed its page: see docs/krillion-dom.md.
import { launchBrowser, openSession } from '../src/krillion.js';

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
let browser;
try {
  browser = await launchBrowser();
  const session = await openSession(browser, { gameNumber: 1 });
  const { prompt } = session;
  if (prompt.total === 7 && prompt.index === 0 && prompt.text) console.log(`OK    opened game 1, prompt 1 of ${prompt.total}: "${prompt.text}"`);
  else fail(`unexpected first prompt: ${JSON.stringify(prompt)}`);

  const rejected = await session.submit('qzxqzxqzx');
  if (rejected.status === 'rejected') console.log('OK    a nonsense answer is rejected and the prompt stays open');
  else fail(`nonsense answer returned ${JSON.stringify(rejected)}`);

  const timer = await session.readTimer();
  if (typeof timer === 'number' && timer > 0) console.log(`OK    countdown readable (${timer}s left)`);
  else fail(`countdown not readable: ${timer}`);
  await session.close();
} catch (err) {
  fail(`${err.code ?? 'ERROR'}: ${err.message}`);
} finally {
  await browser?.close();
}
if (!process.exitCode) console.log('Krillion still looks the way this app expects.');
