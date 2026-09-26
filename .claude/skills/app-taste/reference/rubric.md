# The taste rubric, and how to grow it

Two halves: what a pass is graded on, and how the rubric itself improves so the
tenth app is cheaper and better than the first.

## Grading a pass

Each item is **pass / fail / n-a**, and a fail needs either a fix or a `deferred[]`
entry with a closing condition. Score the app *after* the pass, from the built
app — never from the diff.

### Brand

- The hue and mark come from the brand system, not from this session's taste.
- The hero is reproducible: prompt and seed are recorded.
- 🔴 Under `brandDepth: skin`, **every** surface/border/text pair is verified in
  **both** themes. Under `accent`, host tokens are unmodified.
- Nothing hardcodes a colour that a theme is supposed to flip.

### Information architecture

- The app's primary object is the first thing on screen.
- Creation is secondary once content exists.
- No paragraph explains what the adjacent control already shows.
- 🔴 Any ranking or filter narrower than the true dataset **says so in the UI**.

### Interaction

- Transitions are interruptible and under ~200 ms.
- `prefers-reduced-motion` is honoured, and there is a test that proves it.
- Optimistic mutations roll back visibly on failure.
- Menus: `aria-expanded`, roving focus, Escape, focus restored to trigger.
- Height changes notify the host.

### Honesty

- 🔴 No affordance is offered that the platform will reject — signed-out
  mutations, owner powers that do not exist, counts that are actually partial.
- Suppression is described as suppression, not deletion.

### Coverage

- Unit + component + mock-host integration, including **failure injection** and
  the anonymous path.
- 🔴 Every regression test was **watched red** on pre-change code; the pass
  reports "red at `<base>`, green at HEAD".
- The capture recipe is updated and re-shot in the same PR.

### Evidence

- A before/after `--evidence` diff exists. A pass with no evidence is an opinion.

---

## Growing the taste

The rubric is meant to get sharper each app. Five mechanisms, in rough order of
how much they pay:

**1. Rule of three → gate or component.** A finding that recurs in three apps
stops being advice. It becomes either a deterministic check, or a shared
component promoted into the design-system packages. Advice repeated in a
checklist is advice everyone eventually skims past; a gate is not.

**2. Write constraints back the same day.** Anything phase 0 discovers about the
platform goes into `.claude/skills/app-taste/reference/platform-constraints.md`
**in the pass's own PR**, while the measurement is still in hand. A constraint
recalled a week later is a hypothesis.

**3. Evidence diffs as the grading instrument.** `app-capture --evidence` already
records DOM, console, failed requests, a11y and testids per state. Over several
apps that becomes a real baseline — console errors, failed requests and missing
testids should trend to zero, and a pass that raises any of them regressed
something it did not mean to touch.

**4. Cross-app consistency audit.** After every few apps, compare them side by
side and ask which decisions diverged *without a reason recorded in
`taste.json`*. Divergence with a reason is product; divergence without one is
drift, and it is invisible from inside a single app.

**5. Grade the ask, not just the build.** Record which asks were **blocked by the
platform** rather than by effort. That list is the highest-value output of the
whole programme: it is the prioritised, evidence-backed case for what the block
platform should build next, written by its heaviest user.

### Deliberately NOT in the rubric

- **A fixed layout or component vocabulary.** Apps differ; the pass is about
  considered decisions, not a template.
- **Subjective polish scores.** Anything that cannot be graded from the built app
  by someone who was not in the session does not belong here.
- **Performance budgets** — until they are measured per app rather than asserted.
  Add them when phase 0 starts recording a real first-paint number.
