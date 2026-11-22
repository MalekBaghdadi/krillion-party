#!/usr/bin/env node
// Starts Krillion Party: `npm start`, the double-click launchers, or `npx github:MalekBaghdadi/krillion-party`.
if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('Krillion Party needs Node.js 20 or newer. Get it free at https://nodejs.org');
  process.exit(1);
}

let startApp;
try {
  ({ startApp } = await import('./app.js'));
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  console.error('\nKrillion Party is missing some of its setup files (an earlier setup was probably interrupted).');
  console.error('To fix it: delete the folder called "node_modules" inside the Krillion Party folder, then start it again.\n');
  process.exit(1);
}

// A hiccup in one player's session must never take the whole party down.
const survive = (err) => console.error('Something unexpected happened (the game keeps running):', err?.message ?? err);
process.on('unhandledRejection', survive);
process.on('uncaughtException', survive);

let app;
try {
  app = await startApp({ open: !process.env.KRILLION_PARTY_NO_OPEN });
} catch (err) {
  console.error(`\nKrillion Party could not start: ${err.message}\n`);
  process.exit(1);
}

// Plain ASCII only: Windows consoles show emoji and curly characters as junk.
console.log(`
  KRILLION PARTY is running!

  Host screen: ${app.hostUrl}   (opens by itself: show this on the TV)
  Phones join at: ${app.playUrl}   (or just scan the QR code on the host screen)

  Keep this window open while you play. Press Ctrl+C to stop.
`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nStopping...');
    setTimeout(() => process.exit(0), 5000).unref(); // don't hang if a window refuses to close
    await app.stop();
    process.exit(0);
  });
}
