# Per-app content survey — 2026-08-16, RE-MEASURED 2026-08-29

🔴 **The filename keeps its 2026-08-16 date on purpose** — four files reference this path
(`SKILL.md`, `shelf-life-and-what-not-to-shoot.md`, two `claudedocs/` records), and renaming
it would break them and rewrite historical records that were true when written. **The table
below is the 2026-08-29 measurement; the filename is the survey's origin, not its currency.**

Measured by driving each app in the live DOM, not inferred. The 2026-08-29 pass drove all
seven through the host page (`civitai.com/apps/run/<slug>`, frame-scoped), asserting a **boot
control before every content reading** — a testid census plus a loaded-image count
(`naturalWidth > 32`), so an unbooted frame reports itself instead of yielding a false zero.
🔴 **The point of this file: the ceiling on store screenshots is CONTENT, not tooling.**
The capture path works. Re-measure before acting — content grows, and **four of the seven
rows moved in 13 days**.

| app | what actually renders (2026-08-29) | verdict | vs 2026-08-16 |
|---|---|---|---|
| **model-benchmarking** | **4×4 grid — 16 cells, 16 REAL loaded images** (`image.civitai.com`), 4 column + 4 row headers, **0 runnable/empty cells**; 2 combinations, 4 prompts | ✅ **SHOT** — but the attached 3 are STALE (they show the 2×2 state, and the Buzz chip that no longer renders) | 📈 **grew** from 2×2 / 2 images |
| **playable-collections** | 24 `collection-card` **plus a new `popular-rail` (5 cards)**; 27 `cover-gate` + 27 `maturity-badge`, 11 images actually loaded behind them | ❌ **still nothing shootable** — the gates are the blocker and they have not moved. 🔴 **AND it renders `buzz-balance`** (see the Buzz-leak note) | ➕ popular rail is new |
| **sensei** | still an **empty chat** ("No sessions yet. Start a new conversation."), but now with a visible `settings-bar`: `model-selector` (3 models), `temperature-slider`, `max-tokens-slider`, `open-research` | ⚠️ unchanged for the chat shot — **but the settings bar is a NEW spend-free candidate** that shows the product without an answered question | ➕ settings UI is new |
| **gen-matrix** | **CONFIGURE state only** — 4 config pickers, `gm-generate` ("Generate Matrix · 2 cells"), **0 images** | ❌ **unchanged** — still nothing worth shooting without a Buzz spend | ✅ re-measured, same |
| **app-requests** | **3 IDEAS — 3 `request-row`s** with titles, a `sort-control` (Top/Newest) and per-row vote buttons (all at ▲0) | ⚠️ **VERDICT FLIPPED** — the "No requests yet" empty state is gone. Shootable now, though every vote reads 0 | 📈 **0 → 3 requests** |
| **custom-generators** | **5 `published-card`s** in Discover, each with cost, votes, fork and share | ⚠️ **VERDICT IMPROVED** — 1 → 5 generators. 🔴 But `intro-panel` is **still open on this profile**, which is exactly what spoiled the existing shot | 📈 **1 → 5 generators** |
| **panorama-360** | **CONFIGURE state only** — 6 scene presets, 4 model modes, empty viewer reading "Your 360° panorama will appear here". **0 images** | ❌ **nothing worth shooting** without a spend. 🔴 **AND it renders a Buzz WALLET BREAKDOWN** (see below) | 🆕 **row did not exist** |

🔴 **`panorama-360` was missing from this table entirely** — the survey covered 6 of the 7
shipped recipes. Its row above is a first measurement, not a re-measurement.

## 🔴 TWO apps still leak the operator's Buzz into any screenshot

`shelf-life-and-what-not-to-shoot.md` calls the operator Buzz chip "the one people miss", and
it is still live in two of the seven — measured 2026-08-29, presence only, values deliberately
not recorded here:

- **playable-collections** renders a `buzz-balance` chip in its header.
- **panorama-360** is worse: it renders the **wallet composition** (blue / green / yellow and a
  total), not just one number.

**model-benchmarking is the fixed precedent, not the general state.** Its chip was removed
app-side in `ZacxDev/civitai-app-model-benchmarking#16` (shipped 0.3.3), which is why a *new*
model-benchmarking shot cannot leak it — verified 2026-08-29 across all three of its views at
three viewports, with a body-wide `/[\d,]+\s*Buzz/i` sweep and a positive control on the regex.
🔴 **Do not generalise that fix to the other apps: it was one app's own header, not a platform
change.** For these two, either crop the chip out or treat them as unshootable until they do
the same — and re-check rather than trusting this line, since it is exactly the kind of claim
a later app fix invalidates silently.

🔴 **One measurement trap this pass hit, worth reusing.** A naive "empty state?" text sweep
(`/no results|nothing yet|empty/i`) returned TRUE on model-benchmarking's fully-populated
16/16 grid — it had matched the explanatory copy *"Run an empty cell to contribute its outputs
to the shared grid."* A word an app uses to EXPLAIN itself is not a state marker. Count
structural nodes (populated cells, loaded images) and treat a text match as a lead to confirm,
never as the verdict. The same pass also saw `/apps/run/sensei` return a **real 404 that was
transient** — it loaded normally minutes later on the same account, while all seven
`<slug>.civit.ai` origins returned 200 throughout. **Re-check a 404 before recording a
delisting**; the documented access trap (mod-gating) predicts *all* apps failing, not one.

## 🔴 Two traps this survey walked into — read before running another discovery

**1. A browser-agent will read the JS BUNDLE and report it as UI states.** The first
gen-matrix pass returned a dozen states with confident `data-testid` names harvested from
`/assets/index-*.js`. Live, the app renders **one** state. Source tells you what *can*
render, never what *does*. Say "report ONLY what you OBSERVE RENDERED IN THE LIVE DOM"
in the prompt — with that instruction the same app returned one honest state in 7 steps
instead of twelve fictional ones in 16.

**2. `/apps/run/<slug>` 404s for an account without App Blocks access**, and the failure
looks exactly like a dead route. All 7 apps 404 anonymously while every
`<slug>.civit.ai` returns 200 — consistent with mod-gating, not an outage. This cost a
whole discovery round when the browser was signed into a different account: the tell is
the header chip (`ZA` / 2M Buzz vs another user), not the 404 itself. **Check the chip
before blaming the platform.**

**3. Do not run browser agents in PARALLEL.** Four concurrent agent tabs in one instance
killed two of them mid-session (`owned_tab_gone`); the survivors were the runs with fewer
tabs live. Sequential runs all succeeded.


## 🔴 playable-collections: the "gate-free onboarding" was pursued and FAILED — twice over

The slideshow onboarding (`[data-testid='onboarding-coach']`, "How to play" / "Switch
between Slideshow, Ticker, and Wall") looked like the one view showing the product without
exposing gated imagery. Two things killed it, and both generalise:

**1. It is NOT a modal, so it covers nothing.** It is an INLINE card between the header and
`[data-testid='player']`; the player renders below it with the collection's first image
**unblurred and un-gated** (only a PG-13 badge). A screenshot of this view therefore DOES
show collection imagery, and *which* image is non-deterministic — whatever item 0 of the
first card happens to be. The "gate-free" premise was simply wrong.

**2. The onboarding is ONE-SHOT, and the DISCOVERY RUN CONSUMED IT.** The exploring agent
clicked through it (its own evidence lists "Got it"), and the capture that followed timed
out waiting for text that no longer renders — dismissal persists, exactly like
model-benchmarking's how-to. 🔴 **Discovery and capture interact: an agent sent to explore
a one-shot state destroys it for the capture that follows.** Map one-shot states from a
profile you are willing to burn, or capture them in the same pass that discovers them.

🔴 **CORRECTED 2026-08-28 — a recipe IS shipped for this app**, landed by `9ab91cc05`
(2026-08-24) with the states `discover` and `mine`. This paragraph used to read *"No recipe
is shipped for this app: its only candidate state cannot be reached, and a recipe whose sole
state always fails is a permanently-red gate"* — true of the **onboarding** state, and wrong
as a claim about the app, which has other states. The two findings above are untouched and
are exactly what the shipped recipe is built to avoid: it never goes near
`onboarding-coach`. 🔴 **A shipped recipe is not a content verdict** — the table above says
what a Discover shot would look like, and that question is settled by re-measuring the live
app, never by the existence of a recipe that frames it cleanly.

---

## Boot anchors for the three apps that had no recipe (measured 2026-08-19)

🔴 **CORRECTED 2026-08-28 — all three SHIP a recipe now, and every anchor below was adopted
verbatim.** `9ab91cc05` (2026-08-24) landed `gen-matrix`, `playable-collections` and
`app-requests`, each verified by a live run. The `ready.testid` of each shipped recipe is the
exact recommendation in the table below — `gm-generate`, `tab-discover`, `submit-btn` — and
each carries this section's reject-list in its own `ready._comment`. **So the two are a pair:
a rejection that turns out to be wrong is wrong in both, and both must be fixed in the same
change.** This paragraph used to read *"These three ship no recipe … the recipes directory
holds exactly four files; a recipe for these slugs has never existed on any ref"*, written
before that commit and left standing for four days.

🔴 **Do not restore a count here.** A number in prose rots the moment an eighth recipe lands;
the asserted ledger is gate **P18**, which reads
`.claude/skills/app-capture/scripts/recipes/` itself.

It was never an audit, and still is not. It is the read-only boot discovery an author needs
BEFORE writing a recipe, taken live with `document.visibilityState === "visible"` and
re-verified in a second independent pass. Zero clicks, zero Buzz, no `capture.sh` run (there
was nothing to run at the time).

🔴 **`#root` is disqualified for all three.** `curl https://$SLUG.civit.ai/` returns
gen-matrix 465 B, playable-collections 1408 B, app-requests 573 B — every body is exactly
`<div id="root"></div>` with **0 testids**. Anything in the shell exists BEFORE boot and in a
deadlocked frame, so a gate on it passes early and hands a spinner to the actions. Every
`data-testid` below is JS-rendered post-boot, which is what makes a testid a real boot signal.

| app | recommended anchor | why |
|---|---|---|
| `gen-matrix` | `gm-generate` (alt: selector `#gm-prompt`) | structural; the central control. `#gm-prompt` is the exact analogue of panorama's accepted `pn-prompt` |
| `playable-collections` | `tab-discover` | the tab strip — structural analogue of model-benchmarking's `view-switch`, which serves every state |
| `app-requests` | `submit-btn` (alt: `title-input`, `body-input`, `sort-control`) | the always-present suggest form. `sort-control` was measured present with ZERO requests, so it is demonstrably not data-conditional |

**Boot-present testids, measured:**
- `gen-matrix` (body 9612 B, 6): `gm-browse-checkpoint`, `gm-pick-checkpoint`, `gm-browse-lora`, `gm-pick-lora`, `gm-generate`, `gm-generate-reason`; ids `div#root`, `textarea#gm-prompt`, `p#gm-generate-reason`.
- `playable-collections` (body 53520 B, 14 unique / 106 occurrences): `buzz-balance`, `collection-card`(24), `collection-grid`, `cover-gate`(12), `cover-reveal`(12), `grid-sentinel`, `maturity-badge`(12), `search-input`, `search-submit`, `sort-hint`, `sort-newest`, `sort-popular`, `tab-discover`, `tab-mine`.
- `app-requests` (body 5448 B, 6): `body-input`, `empty-state`, `empty-suggest`, `sort-control`, `submit-btn`, `title-input`.

### 🔴 Rejected candidates, and why — this is the load-bearing half

- **`gm-generate-reason`** — its live text is *"Enter a prompt to generate."*, a validation
  message that exists only while Generate is blocked. Sensei's `start-chat-button` failure
  mode exactly. It is also the only other singleton in that app, so it is the one an author
  would most plausibly reach for.
- **`empty-state` / `empty-suggest`** (app-requests) — measured innerText *"No requests yet /
  Be the first to suggest an app or feature…"*. They vanish the moment anyone files a
  request. **Two of only six testids — a third of that app's inventory is the empty-only trap.**
- **`cover-placeholder`** (playable-collections) — present x12 in the first read, **absent in
  the second**. Transient image-loading art. Only a two-read protocol surfaces this; one read
  would have shipped it.
- **`collection-grid`** — the tempting singleton, but confirmable only in the POPULATED state
  (24 cards). Whether it survives an empty result set (Mine with no collections, a no-hit
  search) is unverified, which is the reject-able shape.
- **`input#ci-input-_r_0_`, `textarea#ci-textarea-_r_1_`** — `_r_N_` is React `useId()`,
  allocated by render order. Unstable across versions and mount-order changes. Never usable.

### Scope bounds, stated rather than glossed
All three were measured in ONE state only — gen-matrix CONFIGURE, app-requests at zero
requests, playable-collections populated. "Survives populated" (or "survives empty", for
app-requests) is a structural **inference**, not a measurement; the other side sits behind the
Buzz path or needs real user data.

🔴 **`onboarding-coach` reads 0 on playable-collections — the one-shot was already consumed
(burned 2026-08-16) and did not return.** Any state or `waitForText` built on "How to play"
would be permanently red. This confirms the warning above from the other direction: the
damage outlives the session that did it.
