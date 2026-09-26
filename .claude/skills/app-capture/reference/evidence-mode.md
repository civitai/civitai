# `capture --evidence` — machine-analysable capture

A screenshot cannot be analysed. `--evidence` records, per state a recipe already
defines, a JSON artifact a later pass can grep, diff and act on. It is additive:
without the flag the store-shoot path is byte-for-byte what it was, and gate E8
asserts that.

## What lands in `--out`, per state

| file | what |
|---|---|
| `<state>.png` | the screenshot, as before |
| `<state>.dom.json` | the app frame's raw `outerHTML`, **uncapped** (bridge envelope) |
| `<state>.dom.html` | the same DOM pretty-printed — stable whitespace, for reading and diffing |
| `<state>.probe.json` | the drained observer probe (console + network + hook status) |
| `<state>.evidence.json` | **the artifact** — console, failed requests, a11y, testids |

## The artifact

```
{ "schema": "app-capture/evidence@1", "state", "slug", "frameHost",
  "dom":      { "bytes", "elements", "sha256" },
  "console":  { "capture": {installed, selfTest, hooks, sentinelSeen, dropped},
                "counts": {error,warn,log,info,debug}, "total", "messages":[{level,text}] },
  "network":  { "capture": {hooks, dropped},
                "counts": {observed, ok, failed, unknown},
                "failures": [{url, status, via, error?, initiator?}] },
  "a11y":     { "checks", "counts", "total",
                "violations": [{check, tag, why, path, testid, snippet}] },
  "testids":  { "count", "unique", "ids":[...], "byId":{id: n} },
  "emptyState": { "verdict": "empty|populated|no-collection", "defect": bool, "why",
                  "primary": {tag, testid, path, items, descendants},
                  "markers": [...],
                  "nextAction": {present, scope, controls:[{tag,testid,name}], elsewhere},
                  "missing":   {kind: "input|data|null", inputs:[{tag,testid,name,placeholder}]} },
  "notes":    [ ... ],
  "meta":     { ... } }
```

**Everything non-deterministic lives under `meta`, and `diff` ignores `meta`.**
That is the whole reason two runs are comparable: one timestamp in the body and
every diff is non-empty, which makes the tool useless on its second day.

```bash
SK=.claude/skills/app-capture/scripts
$SK/capture.sh $SK/recipes/custom-generators.json --evidence --no-frame --out /tmp/before
# …ship a fix, redeploy the app…
$SK/capture.sh $SK/recipes/custom-generators.json --evidence --no-frame --out /tmp/after
python3 $SK/evidence.py diff /tmp/before/discover.evidence.json /tmp/after/discover.evidence.json
```

`diff` exits 0 when nothing compared changed, 1 when something did, and reports
`fixed` / `regressed` counts plus the exact messages, failures, violations and
testids that appeared or disappeared.

🔴 **`domChanged` is reported but does NOT set `changed`, and that is measured.**
Two independent real captures of `custom-generators`/`discover`, minutes apart in
different tabs, agreed **exactly** on console, network, a11y and all 15 testids —
and differed on the DOM hash (35,556 vs 35,676 bytes), because the app's content
is live. Folding the hash into the verdict would make `diff` exit 1 on every
honest re-run, and a signal that is always red is one everyone learns to skip.
So `changed` answers the question worth asking: *did a defect appear or
disappear?*

## 🔴 Per-id OCCURRENCE deltas — what the set diff could not see

`diff` compared **unique testid SETS**. Measured on the first live run: a grid
going **24 → 39 testid OCCURRENCES** reported `unchanged: 15` and nothing else,
because every id was already present in both runs. That is exactly the shape of
*"the primary state stopped being empty"* — one of this mode's own
definition-of-done criteria — so the diff was structurally unable to grade its
own gate.

`diff` now also reports:

```
"testidCounts": { "changed": [{"id":"published-card","before":1,"after":3,"delta":2}, …],
                  "totalBefore": 15, "totalAfter": 31, "delta": 16 },
"occurrencesChanged": true
```

and `report` prints a `repeated:` line (ids with a count above 1, most frequent
first). **Neither sets `changed`** — for the same measured reason as
`domChanged`: a live app moves its item counts between two honest runs, and a
verdict that is always red is one everyone learns to skip. `changed` stays the
answer to *did a defect appear or disappear?*

Gate G6 builds the case by duplicating one **real** card twice, then asserts the
set diff is *provably* blind to it (`added`/`removed` empty, `unchanged: 15`)
while the per-id deltas name `published-card ×2`. Mutants M80–M82.

## 🔴 A poor empty state is itself a defect

The operator's note, and the reason it is in this mode rather than in the shoot:
the survey of first-party apps foundered on content, and "this screen is empty"
was recorded as a fact about the *capture* instead of a finding about the *app*.
A user who lands on an empty surface with no next action and no named input is
stuck, and that is reportable.

`emptyState` answers three questions, structurally:

1. **is the primary collection rendering zero items?** The primary surface is the
   visible collection (`<ul>/<ol>/<table>`, `role=list|grid|…`, or a testid ending
   `-list`/`-grid`/`-results`/…) with the most descendants. An **item** is an
   identified, content-bearing *direct child* — one carrying a `data-testid`, or an
   `li`/`tr`/`article`. That rule is not arbitrary: `discover-list` holds its
   search/sort **toolbar** as its first child, so counting every child would report
   an emptied list as "1 item" and it could never read as empty.
2. **does the surface offer a NEXT ACTION?** Named, visible, interactive elements
   inside the collection (`in-collection`), else in the container immediately
   enclosing it (`in-section`), else none — with a count of named controls
   `elsewhere` on the screen, which do **not** make *this* surface actionable.
3. **WHICH input is unfilled?** `input`/`select`/`textarea` on that surface with no
   value / no selected option, named by accessible name, testid and placeholder.
   If there are none, `missing.kind` is `"data"` — nothing the user can type fills
   it.

`defect` is true only for **empty AND no next action**. An empty state with a
clear CTA is a finding, not a defect; calling both a defect is the false-positive
direction that trains people to ignore a section (mutant M73).

Both flow into `diff`: `("empty-state", <where>)` makes an empty→populated
transition read as **fixed**, and `("empty-state-no-next-action", <where>)` makes
the UX defect read as **regressed** (gate G7).

### What it cannot infer — say this rather than re-deriving it

- It reads the **rendered DOM only**, so it cannot tell "no data exists" from "a
  filter matched nothing" from "the fetch failed". The console and network
  sections are what answer that; the empty-state section deliberately does not
  guess.
- It knows nothing about **CSS or layout**: "placeholder-dominated" is a claim
  about item *count* and named controls, never about pixels or visual weight.
- On a screen with **no collection at all** (a chat pane, a controls panel) it
  returns `no-collection` and declines to have an opinion, rather than inventing
  one from text.
- The empty/placeholder **marker** list (`empty`, `skeleton`, `no-results`, …) and
  its small phrase list are *spelled*, so they can be reworded around. They only
  ever ADD a marker — the structural item count is what decides the verdict.
- The corpus contains **no genuinely empty capture**, so the check's silence on
  the real fixtures is not evidence it works. Gate G5 therefore cuts real
  elements out of real captures with `tests/fixtures/app-capture/domsurgery.py`
  (an independent tag-depth scanner that shares no code with the parser under
  test) and drives all three arms: empty-with-CTA, empty-with-nothing-to-do, and
  empty-with-an-unfilled-input.

## How the browser half works, and why it is shaped this way

Five facts, each measured against a live `custom-generators.civit.ai` frame on
2026-08-17. They are encoded as code in `.claude/skills/app-capture/scripts/evidence.py`,
not as advice.

1. **A frame-scoped `js` in a cross-origin App Block frame runs in the page's
   MAIN world.** Measured: an eval set `window.__probeWorld`; an inline
   `<script>` appended to that same document read it back as `"string"` — an
   isolated world would have said `"undefined"`. This is why hooking `console.*`
   works at all. It is also why the probe must be re-installed after every load.
2. **The hook really captures page-side calls.** Measured end-to-end: a page-side
   `console.warn`, a page-side `console.error` and a page-side `throw` all
   arrived in the buffer, the throw as `uncaught: …`.
3. **`performance.getEntriesByType("resource")` does NOT see fetch/XHR in this
   frame.** Measured: three separate `fetch()` calls (one 200, one hard DNS
   failure) produced **zero** new resource-timing entries, while an `<img>` load
   produced one. Resource timing alone would report "no failed requests" for an
   app whose every API call had failed. **So the fetch/XHR monkey-patch is the
   instrument; the `PerformanceObserver` is a supplement for element loads.**
4. **A resource-timing `responseStatus` of 0 is not a failure.** Measured 0 on a
   load that really happened, and cross-origin entries without
   `Timing-Allow-Origin` report 0 too. Only fetch/XHR — where the hook itself
   observed the rejection — may read 0 as a hard failure. Everything else at 0 or
   -1 is counted `unknown`, never `failed`.
5. **The app's DOM is 38.7 KB and the bridge's `html` default cap is 32768.** A
   default read truncates it, and a truncated DOM under-reports every testid and
   every a11y violation while looking entirely normal. The plan emits
   `--max-bytes 0`; `analyze` refuses a DOM carrying the truncation marker.

## The probe

`evidence.py probe-js install|drain` prints it — one source of truth, embedded by
`plan.py`, never re-typed. Install hooks `console.{log,info,warn,error,debug}`,
`window.onerror` + `unhandledrejection`, `fetch`, `XMLHttpRequest`, and a
`PerformanceObserver` on `resource`.

🔴 **It observes and must never actuate.** It is the one piece of this skill that
runs our own code inside a live, logged-in, mod-gated app, so the ban is a check
on the source (`PROBE_FORBIDDEN`) evaluated every time a plan would inject it —
`plan.py` refuses with `probe_actuates` rather than trusting a comment.

🔴 **One line, no `//` comments.** `capture.sh` materialises a step's argv with
`mapfile -t`, i.e. **one array element per line**, so a multi-line argument is
split into several and the bridge is handed a fragment of a program. The JS is
authored readably and flattened by `evidence._one_line`; `plan.py` refuses
(`multiline_argv`) any step whose argv holds a newline.

## 🔴 The probe OUTLIVES the capture, and the artifact has to say so

In `--tab` attach mode nothing reloads the page between invocations, so
`window.__APP_CAPTURE__` from an **earlier run** is still installed. The first
live `--evidence` run measured what that did to the artifact:

```
reload-per-state (before):  networkTotal == len(network)  every state  (2/2, 2/2, 4/4)
attach mode      (after):   networkTotal frozen at 6, len(network) 2 -> 0 -> 0
reinstalled: false in all six
```

An artifact asserted *"the network hooks were installed and observed ZERO
requests"* while carrying `networkTotal: 6` accumulated from earlier states. Two
independent causes, both now fixed:

- **The drain emptied the arrays and left the counter counting.** Every field the
  drain hands back describes ONE window, so every one of them must be reset by
  it; `counts.networkTotal` was not. The ledger is `PER_DRAIN_RESETS` in
  `evidence.py`, pinned as literal statements by gate **E14** (which fails if it
  GROWS or SHRINKS). The cumulative figure survives under a name that says what
  it is — `counts.networkSinceInstall`.
- **`reinstalled` was written at install, and only the DRAIN is ever saved.** The
  re-install branch returned `reinstalled:true` to a caller nobody stored, while
  `S.reinstalled` kept its first-install value — so `meta.reinstalled` was
  **structurally always false**. The branch now writes `reinstalled`/`installs`
  onto the surviving object, and the drain stamps `drains` before serialising.

The artifact carries a `probe` block: `reused` / `fresh`, `installs`, `drains`,
and `counts.{networkTotal, networkSinceInstall, observedThisDrain,
droppedThisDrain, agree}`. **Reuse is inferred from four independent tells** —
`reinstalled`, `installs > 1`, `drains > 1`, and the counter disagreeing with the
records it counts — so a drain from a probe predating these fields (the corpus
has one, `cg-discover.probe.json`: counter 4, records 0) is still detected. The
"observed ZERO requests" note is emitted only for a window the probe can vouch
for, and a `PROBE REUSED` note plus a `probe :` line in `report` name the rest.

**The one shape that is corruption rather than lifecycle** is a counter *behind*
the records it counts: cumulative drift can only run ahead. `analyze` refuses it
(`probe_counts_impossible`) rather than building an artifact from a payload that
cannot be the one the probe produced.

## The refusals

| code | why |
|---|---|
| `probe_missing` | the probe reports it was never installed — its empty sections would read as a clean bill of health |
| `probe_counts_impossible` | the probe's counter is BEHIND its own records — above |
| `probe_selftest_failed` | the probe's sentinel never came back through its own hook, so "0 console errors" cannot be told from "nothing was listening". `--allow-unverified-probe` downgrades it to a loud note |
| `dom_truncated` | fact 5 |
| `dom_unreadable` | the read returned no markup — usually a stale `--frame` id, which changes on every load |
| `probe_unreadable` | the payload is not the probe's schema — the install and drain halves have drifted |
| `evidence_after_nav` | a `nav` ends the plan (the frame id dies), so the DOM read and the drain would never be emitted and the state would produce **no artifact at all** — which reads exactly like a clean run |
| `probe_actuates` / `multiline_argv` | above |

## Limits — state them, do not discover them again

- **Console capture starts at install, which is after the app boots.** Anything
  the app logged during boot is not captured. Network partly compensates: the
  `PerformanceObserver` uses `buffered:true`, so element loads from boot do
  appear. There is no way to hook earlier through this bridge.
- **The a11y scan is an approximation of the accname algorithm.** It reads
  attributes, text and inline `style` only — no CSS cascade, no shadow DOM, no
  generated content. It is deliberately generous, so a violation it reports is a
  strong claim and its silence is a weak one.
- **`path` is structural and app-version-fragile. `testid` is the anchor.** These
  apps ship no source maps (the `.map` 404s, no `sourceMappingURL`), so a DOM node
  cannot be resolved to app source by tooling — but they carry dense testids
  (25/15/12 occurrences in the three captures here), and a testid is greppable in
  the app repo. Every violation reports the nearest testid at or above it.
- **Failed requests are only those the app frame itself made.** An App Block that
  gets its data through the SDK's postMessage bridge to the parent makes no
  requests of its own: `custom-generators` was measured making **none**, which is
  why the artifact reports `observed` alongside `failed` and notes a zero-request
  state explicitly.
- **`--evidence` never spends.** It adds three reads and no actuation; `plan.py`
  still refuses the `trustedKey` path without `--trusted`.
- 🔴 **A HIDDEN TAB DEADLOCKS THE SDK HANDSHAKE, and the artifact then describes
  the CAPTURE, not the app.** ✅ **Fixed** — the tab is now foregrounded and every
  state opens with an app-ready gate, so this shape aborts the run with
  `APP NEVER BOOTED` instead of shipping an artifact about a spinner
  (`.claude/skills/app-capture/reference/foreground-and-spend.md`). Kept here
  because it is still the **fingerprint** to recognise in an old artifact, and
  because `--no-foreground` can reproduce it deliberately. Measured on the first
  live `--evidence` run of `custom-generators`/`generator`:

  ```
  console : 1 error
      unhandledrejection: IframeTransport: timed out waiting for BLOCK_INIT after
      10000ms. Verify the host frame is sending the init message and that its
      origin is in allowedParentOrigins.
  testids : 1 occurrence — ["app-loading"]
  network : 0 failed of 2 observed
  ```

  Every capture runs in a tab that is **created hidden and throttled**, so the
  host page's init can miss the block SDK's 10 s window. The fingerprint is
  unmistakable and worth knowing before filing a bug: the ONLY testid is
  `app-loading`, the element count collapses (17 vs 81 on a healthy load), and
  **no request failed** — a handshake problem, not a network one. Re-run, or add
  a longer settle, before treating it as an app defect.

  It also happens to be the clearest demonstration of why this mode exists: the
  screenshot of that state is a spinner, and the artifact names the mechanism.

## Tests

`tests/run-tests-app-capture.sh` groups **E** (E1–E12) and **G** (G1–G10),
offline, no browser:
pinned numbers over the real captures, the console sentinel, the network
classifier boundary table, every a11y check from both sides, the testid
inventory cross-checked against an independent regex, every refusal with its
paired positive control, the diff, the plan shape, the `capture*` key ledger
between `plan.py` and `capture.sh`, the actuation ban, the foreground/spend
separation, the app-ready gate, the empty-state check from three arms, the
per-id occurrence deltas, and end-to-end runs of `capture.sh` against
`tests/fixtures/app-capture/fake-bridge.sh`.

Fixtures: `tests/fixtures/app-capture/evidence/` — real captures, with their
provenance and the "do not regenerate these from `evidence.py`" warning in
`tests/fixtures/app-capture/evidence/manifest.json`.
