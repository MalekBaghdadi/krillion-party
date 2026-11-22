# Krillion Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-technical-friendly app where family members join from their phones by QR code, race to answer Krillion prompts, and a laptop enters each person's answers into their own real krillion.io session.

**Architecture:** A Node server on the laptop serves a phone page, a host/TV page and a QR code, and keeps a pure game state machine (`game.js`). A pool of isolated Playwright browser contexts (one per player) drives krillion.io `unlimited/classic?game=N`; a `party.js` conductor ties game, pool and HTTP together. A fake Krillion server makes everything testable offline.

**Tech Stack:** Node 18+ (ESM), `playwright-core` (uses installed Chrome, fallback Edge), `qrcode`, built-in `node:test` and `node:http`. Plain HTML/CSS/JS pages, no framework.

**Spec:** `docs/superpowers/specs/2026-11-22-krillion-party-design.md`

## Global Constraints

- Node `>=18`, ESM (`"type": "module"`). Only two runtime dependencies: `playwright-core`, `qrcode`. No dev dependencies (use `node --test`).
- Krillion selectors (full list in `docs/krillion-dom.md`): answer `input.ds-input`; prompt `.prompt`; count `.ds-prompt-count`; countdown `.ds-time-digits`; start `.ds-begin-btn`; result `.tname .tans .tpts b .tsub`; next `.ds-next-btn` ("DESCEND ▼", last "SURFACE ▲"). Animated buttons need `click({force:true})`. Rejection text: `“answer”: no echo. try again`. Timeout text: `NOTHING LANDED`.
- Fixed prompts: `https://krillion.io/unlimited/classic?game=N`. Never hardcode the timer length; read `.ds-time-digits`.
- Max 5 attempts per prompt per player; answers 1 to 60 chars; names 1 to 20 characters, any language, rendered as text never as markup; max 8 players.
- The unlock link is stored only in `~/.krillion-party/config.json` (mode 0600, override dir with env `KRILLION_PARTY_HOME`), never returned by any API, never logged.
- Host-only endpoints answer 403 unless the request comes from loopback with a loopback or absent `Origin`.
- Decorative motion must not depend on `prefers-reduced-motion` (the owner's PC has Windows animations off).
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- No `.github/workflows` files (the owner's GitHub token lacks the workflow scope).

## Review Focus

1. Names in Arabic, emoji, HTML (`<img onerror>`), 40 chars, duplicates: stored (max 20 chars), shown literally, duplicates refused with a clear message. (Tasks 2, 6)
2. Phone sends empty, huge, repeated, late or rapid-fire answers, or malformed JSON: friendly message, no crash, no extra Krillion submission. (Tasks 2, 5)
3. One player's Krillion session fails to open or dies mid-game: that player is marked, everyone else keeps playing. (Task 4)
4. Another device on the Wi-Fi calls host endpoints or reads settings: 403, and the unlock link never appears in any response. (Task 5)
5. A faster typist's Krillion result arrives later than a slower one's: the race winner is still the earliest typist. (Tasks 2, 4)

---

### Task 1: Skeleton, fake Krillion, DOM contract

**Files:**
- Create: `package.json`, `.gitignore` (`node_modules`, `*.log`, `debug/`), `LICENSE` (MIT), `docs/krillion-dom.md`, `test/browser.js`, `test/fake-krillion.js`, `test/fake-krillion.test.js`
- Run `git init` in the project folder first.

**Interfaces:**
- Produces: `startFake(opts?: {prompts?: string[7]; accepted?: Record<string,{tier:string;points:number;flavor?:string}>; timerSeconds?: number /*25*/; unlockToken?: string /*'cs_test'*/; broken?: boolean}) => Promise<{url:string; close():Promise<void>}>`. Default `accepted` includes `ramen → PLANKTON 10`, `pho → RARE 60`, `champon → ONE IN A KRILLION 100`; any other answer is rejected.
- Produces: `testBrowser(): Promise<Browser>` in `test/browser.js` (headless, chrome then msedge channel).
- Fake serves `/unlimited/classic?game=N` with the real selectors and flow: BEGIN DESCENT, 7 prompts, accepted card or `NOTHING LANDED` on timeout, last button `SURFACE ▲` then a summary. Game N>1 shows `UNLOCK UNLIMITED · $5` and no `.ds-begin-btn` until unlocked. `/restore?pack=classic` has an input (placeholder `https://krillion.io/unlock?session_id=cs_...`) and a `RE-ARM WITH LINK` button; a link containing `session_id=<unlockToken>` sets `localStorage.unlocked=1`, anything else shows `that link didn't work`. `broken:true` renders no answer input.

- [ ] **Step 1: Write `test/fake-krillion.test.js`** (Playwright against the fake): `plays a dive with the real selectors` (BEGIN DESCENT, `.prompt` equals prompts[0], answer `ramen` gives `.tname`=`PLANKTON`, `.tpts b`=`+10 PTS`, `.ds-next-btn` visible); `rejects unknown answers without ending the prompt` (text matches `no echo. try again`, `input.ds-input` still visible); `times out` (`timerSeconds:1` shows `NOTHING LANDED`); `locks game 2 until re-armed` (no `.ds-begin-btn`; after restore with the right link it appears; with a wrong link `that link didn't work`).
- [ ] **Step 2: Run** `node --test test/` and expect FAIL (`startFake` missing).
- [ ] **Step 3: Implement** `package.json` (scripts `test`: `node --test test/`, `start`: `node src/index.js`, `smoke`: `node scripts/smoke.js`; `bin`: `{"krillion-party":"src/index.js"}`; `engines.node`: `>=18`), the fake, `testBrowser`, and `docs/krillion-dom.md` (the selector table and behaviours from the Global Constraints plus the facts in the spec's Constraints section). Run `npm install playwright-core qrcode`.
- [ ] **Step 4: Run** `npm test` and expect PASS.
- [ ] **Step 5: Commit** `feat: project skeleton and fake Krillion server`.

### Task 2: Game state machine

**Files:** Create `src/game.js`, `test/game.test.js`

**Interfaces:**
- Produces:
  - `class GameError extends Error` (message is friendly, shown to players).
  - `createGame(opts?: {now?: () => number; maxPlayers?: number /*8*/; maxAttempts?: number /*5*/}) => Game`.
  - `Game.join(name: string) => {id:string; token:string}` (lobby only); `Game.playerByToken(token) => Player|null`; `Game.removePlayer(id)`.
  - `Game.begin()` (lobby or finished to `'starting'`; throws without players); `Game.openPrompt({index:number; total:number; text:string})` (to `'prompt'`).
  - `Game.recordAttempt(playerId, answer) => {ok:true; receivedAt:number} | {ok:false; reason:'closed'|'busy'|'resolved'|'too-many'|'invalid'|'repeat'}`.
  - `Game.recordResult(playerId, result)` where `result` is `{status:'rejected'} | {status:'accepted'; tier; answer; points; flavor?} | {status:'timeout'} | {status:'error'; message}`; only `rejected` leaves the player open for a retry.
  - `Game.allResolved() => boolean`; `Game.closePrompt() => {winnerId:string|null; entries:{playerId; status; answer?; tier?; points?}[]}` (to `'reveal'`, adds points, `raceWins++` for the winner); `Game.finish()`; `Game.reset()` (to `'lobby'`, keeps players, zeroes scores).
  - `Game.snapshot(viewerId?: string) => {phase; prompt; players:{id,name,score,raceWins,locked,errored}[]; reveal; you}`. Other players' answers appear only in `reveal`.
- Phases: `'lobby'|'starting'|'prompt'|'reveal'|'finished'`.

- [ ] **Step 1: Write `test/game.test.js`** with an injected clock: `trims names and keeps Arabic and emoji`; `refuses duplicate names case-insensitively` (message names the clash); `truncates a 40 char name to 20`; `keeps <img onerror> as literal text`; `refuses joins after begin and past maxPlayers` (friendly messages); `recordAttempt reasons` (`invalid` for empty and 61 chars, `busy` while a result is pending, `repeat` for the same answer, `too-many` on the 6th, `resolved` after accepted, `closed` outside `'prompt'`); `winner is the earliest receivedAt even if its result is recorded last`; `no winner when nobody is accepted`; `equal receivedAt resolves to the earlier joiner`; `closePrompt adds points and raceWins`; `snapshot hides answers until reveal`; `reset keeps players and zeroes scores`.
- [ ] **Step 2: Run** `node --test test/game.test.js` and expect FAIL.
- [ ] **Step 3: Implement** `src/game.js`. Name length is counted in code points (`Array.from`). Player ids and tokens come from `crypto.randomUUID()`.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat: game state machine with race winner`.

### Task 3: Krillion driver and live smoke check

**Files:** Create `src/krillion.js`, `test/krillion.test.js`, `scripts/smoke.js`

**Interfaces:**
- Consumes: `startFake`, `testBrowser` (Task 1).
- Produces:
  - `class KrillionError extends Error {code: 'NO_BROWSER'|'LOCKED'|'UNLOCK_FAILED'|'SITE_CHANGED'|'ERROR'}` with plain-English messages.
  - `launchBrowser(opts?: {headless?: boolean /*true*/}) => Promise<Browser>` (chrome channel, then msedge; else `NO_BROWSER`).
  - `openSession(browser, opts: {baseUrl?: string /*'https://krillion.io'*/; gameNumber?: number /*1*/; unlockLink?: string; stepTimeoutMs?: number /*20000*/; debugDir?: string}) => Promise<KrillionSession>`. Opens a new isolated context; if `unlockLink` is set it first re-arms via `/restore?pack=classic`; goes to `/unlimited/classic?game=N`; force-clicks BEGIN DESCENT; waits for the first prompt. Returns `LOCKED` if the unlock notice shows instead of BEGIN, `UNLOCK_FAILED` if re-arm fails, `SITE_CHANGED` (plus a screenshot in `debugDir`) if expected selectors never appear.
  - `KrillionSession`: `prompt: {index:number; total:number; text:string}`; `submit(answer) => Promise<Result>` (`{status:'rejected'}` or the final Result); `waitForResult() => Promise<{status:'accepted'; tier; answer; points; flavor}|{status:'timeout'}>` (settles when the result card shows, whoever caused it; matches a rejection by the quoted answer so a stale message is ignored); `readTimer() => Promise<number|null>`; `next() => Promise<{done:false; prompt}|{done:true}>`; `close()`.

- [ ] **Step 1: Write `test/krillion.test.js`** against the fake: `opens game 1 and reads the prompt`; `submit accepted returns tier and points`; `submit rejected leaves the prompt open and a retry works`; `waitForResult resolves timeout when the clock runs out`; `readTimer returns a number`; `next walks all 7 prompts then done`; `game 2 without a link rejects LOCKED`; `game 2 with the right link opens`; `wrong link rejects UNLOCK_FAILED`; `two sessions do not share storage` (one unlocked, the other still LOCKED); `broken page rejects SITE_CHANGED within stepTimeoutMs and saves a screenshot`.
- [ ] **Step 2: Run** `node --test test/krillion.test.js` and expect FAIL.
- [ ] **Step 3: Implement** `src/krillion.js`. Re-arm: fill the input whose placeholder contains `unlock?session_id`, click `RE-ARM WITH LINK`, wait for navigation away from `/restore` or the failure text. The link value must never be put into an error message or log.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Write `scripts/smoke.js`** (live, guest, game 1, one session): open, print prompt text, submit gibberish and expect `rejected`, print `readTimer()`, close. Exit 1 with a clear line if any expectation fails. Run `npm run smoke` and expect all three lines OK. This is the only test that touches the real site; run it once.
- [ ] **Step 6: Commit** `feat: Krillion browser driver and live smoke check`.

### Task 4: Session pool and party conductor

**Files:** Create `src/pool.js`, `src/party.js`, `test/party.test.js`

**Interfaces:**
- Consumes: `openSession`, `KrillionSession` (Task 3); `createGame` (Task 2).
- Produces:
  - `createPool({browser, config: {gameNumber, unlockLink}, open?: typeof openSession}) => Pool`. `Pool.openAll(players:{id,name}[]) => Promise<{failed:{id,code,message}[]; mismatch:boolean}>` (parallel; failed players are left out; `mismatch` when live sessions show different prompts); `Pool.referencePrompt()`; `Pool.submit(id, answer) => Promise<Result>` and `Pool.waitForResult(id) => Promise<Result>` (never reject: errors become `{status:'error', message}`); `Pool.readTimer() => Promise<number|null>` (first live session); `Pool.advance() => Promise<{done:boolean; prompt?; failed:{id,message}[]}>`; `Pool.closeAll()`; `Pool.check() => Promise<{ok:boolean; lines:string[]}>` (opens 2 sessions, confirms same prompt, closes them, friendly lines).
  - `createParty({game, getPool: () => Promise<Pool>, emit: () => void, pollMs?: number /*500*/}) => Party`: `join(name) => {id; token}` (wraps `game.join`, then emits), `playerByToken(token) => {id}|null`, `start()`, `answer(playerId, text) => Promise<{ok:true}|{ok:false; reason}>`, `next()`, `again()`, `stop()`, `snapshot(viewerId?) => game snapshot + {timeLeft:number|null; notice:string|null}`. `emit` fires after every state change. `getPool` is called lazily at `start()` so the server runs without Chrome.

- [ ] **Step 1: Write `test/party.test.js`** with real pool + fake Krillion (`timerSeconds:3`, 3 players) and stub pools for timing: `full prompt: two answer, one times out, prompt closes, winner is the earliest accepted, scores added`; `race winner is earliest typist even when its result arrives later` (stub pool delays the earlier typist's result); `a rejected answer lets the player retry and does not count`; `a player whose session fails to open is marked errored and the rest play on`; `a session that errors mid-prompt resolves as error without stalling the prompt`; `prompt mismatch sets a notice`; `next walks to the finished phase after 7 prompts`; `again returns to lobby with players kept and sessions closed`; `timeLeft follows the page countdown`.
- [ ] **Step 2: Run** `node --test test/party.test.js` and expect FAIL.
- [ ] **Step 3: Implement** both files. Each prompt: for every live player start `pool.waitForResult(id)` once, feeding `game.recordResult`; when `game.allResolved()` call `game.closePrompt()` and emit. Poll `pool.readTimer()` every `pollMs` only during `'prompt'`. Wrap every async path so an exception becomes a `notice`, never an unhandled rejection.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat: session pool and party conductor`.

### Task 5: Config, network and HTTP server

**Files:** Create `src/config.js`, `src/net.js`, `src/server.js`, `test/server.test.js`

**Interfaces:**
- Produces:
  - `loadConfig() => {gameNumber:number; unlockLink:string; port:number; maxPlayers:number}`; `saveConfig(patch) => Config` (validates `gameNumber` integer 1 to 99999 and `unlockLink` either `''` or starting `https://krillion.io/unlock?session_id=`; throws a friendly `Error`; writes mode 0600); `publicConfig(cfg) => {gameNumber; port; hasUnlockLink:boolean}`.
  - `lanAddresses() => string[]` (private IPv4s first); `isLocalRequest(req) => boolean`.
  - `createServer({party, getConfig, saveConfig, runCheck, lan:string, publicDir}) => {listen(port):Promise<number>; close():Promise<void>}`.
  - Routes: `GET /` (host page if local, else redirect to `/play`); `GET /play`; static files from `publicDir`; `GET /qr.svg` (QR of `http://<lan>:<port>/play`); `GET /api/events?token=` (SSE, a full per-viewer snapshot at connect and after every `emit`); `POST /api/join {name}` returns `{token}`; `POST /api/answer {token, answer}` returns `{ok}` or `{ok:false, message}`; host-only: `POST /api/host/start|next|again`, `GET|POST /api/host/settings`, `POST /api/host/check`. JSON bodies capped at 1 KB (413).

- [ ] **Step 1: Write `test/server.test.js`** with a stub party: `isLocalRequest accepts 127.0.0.1, ::1 and ::ffff:127.0.0.1, refuses LAN addresses and a foreign Origin`; `host routes answer 403 when requested through the LAN address` (skip with a message if no LAN IP); `settings never contain the unlock link, even right after saving it` (search the whole body); `saveConfig refuses a bad link or game number with a friendly message`; `join and answer validate input` (invalid JSON 400, over 1 KB 413, unknown token 401, empty name, friendly game errors surface as `{message}`); `GET / from the LAN redirects to /play`; `/qr.svg is an SVG`; `SSE sends a snapshot at connect and after emit`; `config file is mode 0600 on non-Windows`.
- [ ] **Step 2: Run** `node --test test/server.test.js` and expect FAIL.
- [ ] **Step 3: Implement** with `node:http` only. Config lives in `homeDir()` (`KRILLION_PARTY_HOME` or `~/.krillion-party`). Serve HTML with `charset=utf-8`. QR via `qrcode` `toString({type:'svg'})`. Never log request bodies.
- [ ] **Step 4: Run** and expect PASS.
- [ ] **Step 5: Commit** `feat: config, LAN detection and HTTP server with host guard`.

### Task 6: Phone page

**Files:** Create `public/play.html`, `public/play.js`, `public/style.css`, `test/phone.test.js`

**Interfaces:**
- Consumes: server routes and snapshot shape (Tasks 2, 5). Token kept in `localStorage.kpToken`.
- Produces: `style.css` base variables and classes (`.btn`, `.card`, `.chip`, `.tier`) reused by Task 7.

- [ ] **Step 1: Write `test/phone.test.js`** (Playwright, 390x844, real server + party + fake Krillion, host actions via local `fetch`): `joins with an Arabic name and waits`; `renders <b>x</b> literally`; `refuses a duplicate name with a message`; `sees the prompt after start`; `unknown answer shows "not recognised, try again" and can retry`; `accepted answer shows locked in`; `reveal shows your answer, tier and points`; `reload mid-game rejoins with the saved token`; `joining after start shows "game already started"`.
- [ ] **Step 2: Run** `node --test test/phone.test.js` and expect FAIL.
- [ ] **Step 3: Implement** the phone page. One screen at a time: join, waiting, prompt (huge text, countdown, input with `enterkeyhint="send"`, `autocomplete="off"`, big Send button), reveal, finished. Names set with `textContent` and `dir="auto"`. Dark ocean theme, 48px touch targets, `aria-live` status line.
- [ ] **Step 4: Run** and expect PASS. Save a phone screenshot of each screen to `docs/screens/`.
- [ ] **Step 5: Commit** `feat: phone page`.

### Task 7: Host/TV page and full-game test

**Files:** Create `public/index.html`, `public/host.js`, `test/e2e.test.js`

**Interfaces:**
- Consumes: Task 5 routes and snapshot; `style.css` (Task 6).

- [ ] **Step 1: Write `test/e2e.test.js`**: host page (1280x720) plus three phone contexts against the fake (`timerSeconds:4`), a full 7-prompt game: `lobby shows the QR and each joined player`; `START opens sessions then shows the prompt and countdown`; `host sees who has locked in without seeing answers`; `reveal marks the race winner and shows tiers and points`; `leaderboard totals equal the sum of points`; `finished shows the podium and Play again returns to the lobby with players kept`; `Test setup shows friendly check lines, and for a locked game says to add the unlock link`; `Settings saves the game number and shows "unlock link saved" without ever displaying it`; `Space or Enter presses START and NEXT`.
- [ ] **Step 2: Run** `node --test test/e2e.test.js` and expect FAIL.
- [ ] **Step 3: Implement** the host page: lobby (QR, URL text, player chips, Settings drawer, Test setup, big START), starting (per-player progress), prompt (prompt text at 4rem or larger, countdown, chips with a tick when locked), reveal (table, race winner badge, NEXT), finished (podium, Play again), a banner for `notice`. Everything reachable by keyboard.
- [ ] **Step 4: Run** `npm test` and expect all PASS. Save host screenshots (lobby, prompt, reveal, finished) to `docs/screens/`.
- [ ] **Step 5: Commit** `feat: host/TV page and end-to-end test`.

### Task 8: Entry point, launchers and README

**Files:** Create `src/index.js`, `Start Krillion Party.command`, `Start Krillion Party.bat`, `README.md`, `test/start.test.js`

**Interfaces:**
- Consumes: everything above. `src/index.js` wires `loadConfig`, `createGame`, a lazy `getPool` (launches Chrome and builds the pool on first `start()`), `createParty`, `createServer`; picks the first free port from `config.port` up to +10; prints the phone URL; opens the host page in the default browser (`open` on macOS, `start` on Windows, `xdg-open` elsewhere); closes sessions on SIGINT/SIGTERM.

- [ ] **Step 1: Write `test/start.test.js`**: `starts, serves /api/events, and exits cleanly on SIGINT`; `falls back to the next port when the first is busy`; `the .command file has a shebang and LF line endings`; `package.json bin points at an existing file`.
- [ ] **Step 2: Run** `node --test test/start.test.js` and expect FAIL.
- [ ] **Step 3: Implement** `src/index.js` (first line `#!/usr/bin/env node`) and the launchers: each checks `node -v` for 18+, otherwise opens https://nodejs.org and prints a one-sentence explanation; runs `npm install --omit=dev` when `node_modules` is missing; then starts the app. Set the executable bit with `git update-index --chmod=+x "Start Krillion Party.command"` and `src/index.js`.
- [ ] **Step 4: Write `README.md`** in plain language: what it is; what you need (a Mac or PC, Google Chrome, the free Node.js installer, everyone on the same Wi-Fi); three steps (Get it, Start it by double-clicking the launcher or pasting `npx github:<owner>/krillion-party`, Play by scanning the QR); the game rules (race and own score); how to unlock other game numbers; troubleshooting (firewall "Allow", guest Wi-Fi isolation, Chrome not found, "this game is locked", ZIP downloads losing the Mac launcher's permission so use the one-line command); screenshots from `docs/screens/`; "unofficial, not affiliated with Krillion, please buy the game"; MIT licence.
- [ ] **Step 5: Run** `npm test` and expect all PASS, then run `npm start` manually once and confirm the page opens.
- [ ] **Step 6: Commit** `feat: entry point, launchers and README`.

### Task 9: Publish to GitHub and verify from a clean clone

**Files:** none new.

- [ ] **Step 1:** Run `gh auth status`. If not logged in, ask the user to run `! gh auth login`.
- [ ] **Step 2:** Create the public repo and push: `gh repo create krillion-party --public --source . --push --description "Family trivia night for Krillion: scan a QR, race to answer, play together"`. Set topics `trivia`, `krillion`, `party-game`.
- [ ] **Step 3: Verify:** `git clone` the new repo into an empty temp folder, `npm install`, `npm test` passes, `git ls-files -s` shows mode 100755 for `Start Krillion Party.command`, and `npx github:<owner>/krillion-party` starts the server (stop it after the first log line).
- [ ] **Step 4:** Save a project memory entry (repo URL, how to run, what is unverified: unlock link and Mac run) and add it to `MEMORY.md`.
- [ ] **Step 5:** Give the user the repo URL and the three Mac steps.
