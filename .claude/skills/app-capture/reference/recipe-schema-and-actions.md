# Recipe schema, action verbs, and the `clickable` ledger

Demoted from `SKILL.md` 2026-08-24 (size prune). VERBATIM — the core kept only a
routing line and the two-line shape of a recipe. Nothing here had another home:
`click_unledgered`, `clickable_unused`, `KNOWN_ACTIONS`, `clickIfPresent` and
`op_timeout:click` appear in no other reference file, which is why this block was
sliced rather than dropped.

## Recipe schema

```json
{
  "slug": "custom-generators",
  "frameHost": "custom-generators.civit.ai",
  "url": "https://civitai.com/apps/run/custom-generators",
  "crop": { "chromeTop": 182, "footer": 110, "right": 70, "fromAppFrame": true },
  "ready": { "testid": "discover-list", "loadingTestid": "app-loading", "timeoutMs": 45000 },
  "clickable": [ "#tab-discover" ],
  "states": [
    { "name": "discover", "caption": "...",
      "actions": [ { "click": "#tab-discover" }, { "waitForText": "Discover" } ] }
  ]
}
```

🔴 **`clickable` is a LEDGER, and it exists because a mutating control cannot be DETECTED —
only declared.** "A synthetic in-frame click does nothing on a money button" was measured on ONE
button and does NOT generalise — elsewhere (sensei) exactly such a click submitted and spent.
An ordinary authenticated mutation — post,
vote, edit, withdraw — is equally reachable, and this skill's own docs say synthetic clicks
"drive the vast majority of apps". Measured 2026-08-23 on **app-requests**, which now renders
`submit-btn`, `vote-btn`, `edit-btn` and `withdraw-btn`: every one was frame-scoped clickable
and nothing said no, so a plausible "voting" state would have cast a **real vote from the
operator's account** on every run and every state reload. So every selector a recipe may
*activate* — `click`, `clickIfPresent`, and `key`, because Enter submits the form its input
sits in — must be listed once. `plan.py` refuses one that is not (`click_unledgered`), a
recipe that activates anything with no ledger at all (`no_click_ledger`), and an entry no
state uses (`clickable_unused`, the SHRINK half — a ledger that has drifted stops being read
as one). ⚠️ **It buys reviewability, not detection**: `plan.py` is pure and never sees the
app's DOM, and HTML carries no "this mutates" signal — a name scan for `submit|vote|delete`
was rejected as a *spelled* guard (walkable by renaming a testid to `cast`, and a false
positive on `submit-search`). What it changes is that adding a clickable control is a second,
deliberate edit that **grows the ledger in the diff**. A determined author can still list
`vote-btn` and be wrong. Gate **G19**, mutants **M148**–**M152**.

Action verbs: `click`, `clickIfPresent`, `type` (+`selector`), `key` (+`selector`),
`waitForText`, `waitForGone`, `sleep`, `nav`, `trustedKey`. Adding a verb is one branch in
`plan_state()` plus a name in `KNOWN_ACTIONS`; an unknown verb is **refused**, never skipped.

🔴 **A ONE-SHOT BRIDGE OP IS JUDGED ON ITS EXIT STATUS, and `clickIfPresent` is the only way
to say a failure is expected.** A step with no `expect`/`expectAbsent` gets exactly one read,
and `out="$(…)"` used to throw away `$?` — so a `click` the bridge REFUSED ran a step that did
nothing, captured the wrong screen and reported success, and only the identical-box gate could
catch it. Reading one error string is not enough: the bridge `die`s (exit 1) on *every* op
error, so a `click` answered `op_timeout:click` sailed through a check that looked only for
`element_not_found` — measured, one word over. Polling steps are exempt (a wait is *built* to
tolerate a read that is not true yet), and two keep their own sentence: the **screenshot** →
exit 12, a bridge-side capture hang from a stale bridge build; a **foreground-verified** step →
exit 13, the window raise.
`wake` is deliberately *not* exempt — a wake the bridge refused leaves the tab throttled, and
a blank capture is the thing this skill exists to not ship.

Use `clickIfPresent` where a control's presence depends on **profile history** rather than app
state — model-benchmarking's how-to dismissal persists across reloads, so it exists on a fresh
profile and is absent on every profile that has run the app once, and both are correct. It
**narrows, it does not swallow**: absence is tolerated by name, every other failure still
fails, so a rename of `element_not_found` upstream turns an optional step LOUD rather than
silently skipping it. The `waitForGone` after it is **not** redundant: wait-until-absent is
satisfied instantly when the panel is already gone, and on a fresh profile it is the only
thing stopping the next click racing the dismissal.

`crop` overrides the exclusion bands per app — they are viewport-specific, not universal.
`ready` is **mandatory**: exactly one of `testid` or `selector` (an anchor only the booted
app renders), `loadingTestid` defaults to `app-loading`, `timeoutMs` to 45000.
