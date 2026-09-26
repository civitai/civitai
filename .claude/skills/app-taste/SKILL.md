---
name: app-taste
description: Take a first-party Civitai App Block from functional to considered — the repeatable measure→brand→restructure→animate→socialise→moderate→test→re-shoot→submit pass, applied one app at a time. Use when the user says an app's UI/theme is boring or default, asks to redesign or polish an App Block, asks to apply "the taste pass" / app-taste to an app, wants a hero image or brand skin for a block, or wants the core flow of a block simplified. Authoring store icons/covers is the sibling `listing-media` skill; screenshotting a running block is `app-capture`.
argument-hint: "[<slug> | audit | rubric]"
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# app-taste — functional → considered, one app at a time

A block that works is not a block anyone wants to use. This is the pass that
closes that gap, in a fixed order, so the result is comparable across apps
instead of being whatever the session felt like.

🔴 **Phase 0 is not optional and not a formality.** Every failed run of this pass
so far failed there: a stale clone, a pinned SDK missing the method the design
needed, or a platform limit discovered *after* the UI was built around it.

## 🔴 Read before designing anything

`.claude/skills/app-taste/reference/platform-constraints.md` — the measured
shared-storage / identity / moderation surface, with the version each method
landed in. **Four separate asks have been killed outright by a constraint in
that file.** Do not design against the SDK you remember; the surface moves, and
the app's *pinned* version is what compiles.

The gradeable checklist, and how to grow the taste: `.claude/skills/app-taste/reference/rubric.md`

---

## Phase 0 — sync and measure

🔴 **Do NOT `civitai app pull` to get a working clone.** It clones the forgejo
**deploy mirror**, which carries the right slug, the right manifest version and a
clean `main` — and does **not** contain the source commit the app was built from,
so there is nothing to branch off and no PR target. Development is on GitHub, and
the repo name is not derivable from the slug. Constraints §12 has the full trap.

```bash
SLUG=app-requests
civitai app status "$SLUG"            # per-app; see §13 — it reports the newest SUBMISSION
git -C "${APP:?set APP to your clone of the app repo}" show origin/main:block.manifest.json \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["repository"])'
```

Then answer all five in writing before touching a file:

1. **Is the clone current, and is it the DEV repo?** The check that settles both
   is `git cat-file -t <live source sha>` against the clone — a mirror fails it
   while every other signal looks right. Comparing the manifest `version` alone
   passes on the mirror and proves nothing. A stale clone silently reverts
   shipped work.
2. **What does the PINNED SDK actually expose?** Read the installed `.d.ts`, not
   the monorepo source — they diverge by several minor versions.
3. **How big is the live dataset?** A cap that never binds is not a constraint; a
   cap that already binds is the design.
4. **What does the current app already handle honestly?** Reuse the disclosure,
   don't rediscover it.
5. **Which recipe drives it?** `.claude/skills/app-capture/scripts/recipes/`

Anything phase 0 finds that the platform cannot do becomes a **fork for the
operator**, not an assumption. Present it with a recommendation before building.

## Phase 1 — brand

The hue and mark come from the brand system, never invented here — read the live
values as `listing-media` instructs, and treat any hue table you find in prose as
a snapshot.

**Decide brand DEPTH explicitly and record it** (`taste.json` → `brandDepth`):

| depth | surfaces | who owns light/dark |
|---|---|---|
| `accent` | host `--civitai-*` tokens | the platform |
| `skin` | app-owned palette | **you** |

🔴 **`skin` transfers light/dark correctness to you, and that debt is invisible
until someone opens the other theme.** Under `skin` the rubric's dual-theme
check is mandatory, not advisory: every surface, border and text pair must be
asserted in both themes, because the host token that used to flip for you no
longer does.

**Hero image** — generate from the app's own mark and hue, never a stock prompt.
🔴 **`civitai generate` spends real Buzz and cannot be undone.** Always
`--dry-run` first and report the estimate to the operator before spending.
Record the prompt and seed in `taste.json` so the hero is reproducible; commit
the rendered asset, not the intent to render one.

🔴 **`--aspect-ratio` is not honoured — generate wide-ish, then CROP.** The
dry-run echoes your requested ratio back, which is not acceptance, and the
realized file can be nothing like it (constraints §11). Measure the output with
`file` and record the real dimensions beside the seed. Generate a small batch and
pick; a single render is a coin flip you will pay to re-roll anyway.

## Phase 2 — information architecture

The single highest-yield phase, and the one most often skipped for styling.

- **Put the thing the app is FOR at the top.** Everything else is secondary.
- **Demote the creation CTA to secondary** once a board has content — a primary
  "add" button on an empty-looking list teaches people the list is unimportant.
- **Delete copy that explains what the UI already shows.** Explainer paragraphs
  are a tell that the layout failed.
- 🔴 **A filter or sort the server cannot do is a client-side lie past its
  horizon.** If ranking or search only covers the rows you loaded, say so in the
  UI. An honest partial beats a confident wrong order.

## Phase 3 — interaction

- Transitions are **subtle and interruptible**; nothing blocks input.
- 🔴 **`prefers-reduced-motion` is not optional** — and it is a test, not a
  media query you wrote once.
- **Optimistic mutations roll back on failure**, and hydrate their initial state
  from the server rather than guessing it.
- 🔴 **Overflow menus are an a11y trap.** Real menu semantics: `aria-expanded`,
  roving focus, Escape closes, focus returns to the trigger.
- 🔴 **Any height change must tell the host.** A block that animates or expands
  in place without a resize call clips instead of growing — the defect looks
  like broken CSS and is not.

## Phase 4 — identity

Show who did the thing. Check the constraints file first: identity is the ask
most often blocked by scopes, and the workaround (denormalising at write time)
**cannot retrofit rows already in production** — so decide what legacy rows show
before writing any of it.

Never render the viewer's own name as "you" when a real handle is available;
self-reference should look the same as everyone else.

## Phase 5 — moderation

Two distinct powers, routinely conflated:

- **Escalation** — anyone flags content for *platform* moderators. Server-backed,
  slow, and it hides nothing on its own.
- **Owner control** — the app author suppresses content in their own app.

🔴 **Check whether owner control exists server-side before promising it.** Where
it does not, the honest implementation is a client-side soft-hide honoured by an
owner-authored ledger — and it must be *described* as that, in the code, so
nobody later mistakes it for deletion.

## Phase 6 — tests

Every phase above lands with coverage, in the same PR:

- **Unit** — ranking, filtering, formatting: pure functions, literal expectations.
- **Component** — each new control, including keyboard paths for menus.
- **Integration against the mock host**, including **failure injection** and the
  anonymous-viewer reject path. A happy-path-only suite has not tested a bridge.
- **A11y + reduced-motion** assert behaviour, not the presence of an attribute.
- 🔴 **One regression test per bug fixed, watched RED on pre-change code.** A
  test never seen to fail proves nothing. Report the matrix: red at base, green
  at HEAD.

## Phase 7 — re-shoot

The capture recipe is **coupled to the redesign and gated by nothing.** A pass
that renames states, moves the ready anchor, or adds a control invalidates it
silently.

🔴 **This phase is TWO steps that cannot ship together.** Rewrite the recipe file
from the new testids in the pass's own PR — but the re-shoot needs the new
version **live**, i.e. through moderator review, so it always trails phase 8.
Collapsing them yields a pass that calls itself done while the store still shows
the old app. Once approved:

```bash
SK=.claude/skills/app-capture/scripts
"$SK/capture.sh" "$SK/recipes/$SLUG.json" --evidence --out /tmp/taste-after
```

Keep the **before** run from phase 0 and diff it — that is the taste delta, and
it is the only part of this pass that produces evidence rather than opinion.

## Phase 8 — submit

One submission per pass, not one per phase: every change goes through moderator
review, so batching is materially cheaper. Attaching media opens a **shadow
revision** — the live listing is untouched until approval.

---

## The ledger — `taste.json`

One per app repo, committed. It is what makes the second app cheaper than the
first, and what makes a re-run reproducible:

```
slug · brandDepth · hue · heroPrompt · heroSeed · sdkVersionAtPass
decisions[]  — each fork, the option chosen, and the constraint that forced it
deferred[]   — each ask NOT shipped, with the closing condition that ends it
```

🔴 **`deferred[]` entries must carry a closing condition** — what ends the item
and who or what checks it. An entry that names neither is not a work item; say
so instead of minting one nobody can close.

## Expanding the taste

The rubric is meant to grow. Read
`.claude/skills/app-taste/reference/rubric.md` for the current checklist and the
promotion rules — in short: a finding that recurs in **three** apps stops being
advice and becomes either a deterministic gate or a shared component, and a
constraint discovered mid-pass is written back to the constraints file **in that
same PR**, while the measurement is still in hand.
