# Krillion Party: design

Status: approved by Malek on 2026-11-22, then revised the same day after more testing (see "Revisions"). Public GitHub repo, so anyone can use it.

## Intent
Family trivia night on Krillion. A laptop is plugged into the TV. Everyone joins a small server on the laptop by scanning a QR code on their phone, types answers at the same time, and the laptop enters them into the real krillion.io. Nobody waits for one typist. Anyone, not just developers, should be able to download it and play.

## Goals
1. **Race:** for each prompt, the first player to submit an answer Krillion accepts wins that prompt.
2. **Own score:** each player also gets their own real Krillion run (tier and points), so there's a per-person total.
3. **Phones:** scan QR, type a name, see the prompt, type answer, send. Nothing to install. Names may be any language (Arabic, emoji).
4. **TV/laptop screen:** QR + player list while waiting, then the prompt, countdown, who has locked in, the reveal (answers, tiers, points, race winner) and a leaderboard. A big START and NEXT button, a Settings drawer and a "Test setup" button, so no one edits files.
5. **Easy start:** double-click launcher (Mac and Windows) or one pasted Terminal line. Friendly README.
6. Runs on home Wi-Fi, no internet hosting, no accounts, no database.

## Non-goals
Scoring rules beyond the two above (Malek: "we'll think of scoring later"), the Daily Dive, Krillion's other modes, internet play, a native app.

## Anti-goals
- Leaking the unlock link (a purchase token): it is entered in the app's Settings by the host, stored only in the host's home folder (`~/.krillion-party/config.json`, owner-only), never returned by any API, never logged, never in the repo.
- Letting a guest phone control the game or read settings.
- Claiming to be official: the README says it is an unofficial helper and points people to buy the game.

## Constraints (found in the spike, 2026-11-22)
- Krillion has no API, so we drive the real site with `playwright-core` and the machine's installed Chrome (fallback Edge).
- Selectors (details in `docs/krillion-dom.md`): `input.ds-input`, `.prompt`, `.ds-prompt-count`, `.ds-time-digits`, `.ds-score-num`, BEGIN DESCENT = `.ds-begin-btn`, result card `.tname .tans .tpts b .tsub`, next = `.ds-next-btn` ("DESCEND ▼", last one "SURFACE ▲"). Buttons are animated so clicks need `force: true`. A rejected answer shows `“answer”: no echo. try again` and does not use up the prompt. A timeout shows "NOTHING LANDED".
- 7 prompts per dive. Timer is about 25 s but Krillion says its length is deliberately random, so never hardcode it: read `.ds-time-digits`.
- **Fixed prompts:** `https://krillion.io/unlimited/classic?game=N` serves the same 7 prompts to every fresh session (verified with two parallel sessions on `game=1`). A guest can play game 1 free; other game numbers presumably need the $5 unlock.
- The unlock page `/restore?pack=classic` has a "RE-ARM WITH LINK" box taking `krillion.io/unlock?session_id=…`. **Unverified:** nobody has tried it from automation yet, and whether it works in several sessions at once.
- Each player = one isolated browser context (own cookies/storage), all in one Chrome process.
- No bot challenge was seen in headless Chrome.

## Approaches considered
1. One shared session, race only. Simplest, but one score for everyone.
2. One session per player, no race. Per-person scores, no drama.
3. **One session per player + race decided by server timestamps (chosen; Malek asked for both).** One engine does both.

## Decisions (mine, correct me)
- Race winner = earliest server-received answer that Krillion accepts, decided when the prompt closes (so a slow Krillion response can't beat an earlier typist). A rejected answer doesn't count and the player can retry (max 5 tries per prompt).
- A prompt closes when every player's session has resolved (answered or timed out). The host presses NEXT to move on.
- Leaderboard shows Krillion points and race wins side by side; no bonus points yet.
- Late joiners during a game wait for the next game. A phone that reloads rejoins with its saved token.
- Node 20+ (playwright-core refuses to load on older versions; corrected after the final review), ESM, no framework, plain HTML pages. Dependencies: `playwright-core`, `qrcode`.
- Fake Krillion server in the tests so everything is verifiable offline; one live smoke check against the real site.

## Revisions after approval
- Fixed prompts come from Unlimited `?game=N`, not Archive (Archive is paywalled and unseen; this is verified and simpler). The unlock link is optional, only needed beyond game 1.
- The unlock link is typed into the app's Settings, not a file.

## Left to the builder
Exact CSS, copy text, ports, tie-breaks, reconnect details.
