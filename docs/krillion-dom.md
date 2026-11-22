# What we rely on in krillion.io

Krillion has no API, so this project drives the real website in a browser. This file lists exactly what the code depends on. If Krillion changes its page and the game stops working, this is the checklist for fixing `src/krillion.js`. Run `npm run smoke` to check the live site.

Observed on 2026-11-22.

## Selectors

| What | Selector or text |
|---|---|
| Start button | `.ds-begin-btn` ("▼ BEGIN DESCENT ▼"). It is animated, so click with `force: true`. |
| Answer box | `input.ds-input` (visible only while a prompt is open) |
| Prompt text | `.prompt` |
| Prompt counter | `.ds-prompt-count` ("PROMPT 2 OF 7"). While a result card is showing it already shows the *next* number. |
| Countdown | `.ds-time-digits` (whole seconds) |
| Score | `.ds-score-num` |
| Accepted card | `.tname` (tier, e.g. PLANKTON), `.tans` (the answer, in curly quotes), `.tpts b` ("+10 PTS"), `.tsub` (flavour text) |
| Timeout card | the same card as an accepted answer, with `.tname` = `NOTHING LANDED` (so check the tier text before treating a card as accepted) |
| Next button | `.ds-next-btn` ("DESCEND ▼", on the last prompt "SURFACE ▲") |
| Rejected answer | a message containing the answer and `no echo. try again`; the prompt stays open |
| Near-miss ("raman") | NOT accepted. The box is rewritten to Krillion's closest answer ("Ramen") and a notice appears: `“raman” → corrects to “Ramen”`, `.ds-correction-hint` = "submit again to confirm · or edit". Submitting again accepts it. The driver reports `{status:'suggestion'}` only when the hint is visible **and** the box differs from what was typed. |
| Locked game | the text `UNLOCK UNLIMITED` and no `.ds-begin-btn` |

## Behaviour

- A dive has 7 prompts. One answer per prompt is accepted. A rejected answer does not use up the prompt.
- The timer is about 25 s but its length is deliberately random (Krillion's FAQ), so always read `.ds-time-digits`.
- `https://krillion.io/unlimited/classic?game=N` serves the same 7 prompts to every fresh session. Game 1 is free for guests. Other numbers presumably need the $5 unlock.
- Unlock: `https://krillion.io/restore?pack=classic` has a box (placeholder contains `unlock?session_id`) and a "RE-ARM WITH LINK" button. The unlock link itself (`https://krillion.io/unlock?session_id=...`) can also be opened directly. Neither path has been verified from automation yet.
- No bot challenge was seen in headless Chrome.
