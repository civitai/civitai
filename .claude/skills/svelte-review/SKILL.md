---
name: svelte-review
description: Run the three SvelteKit review agents (correctness, Svelte 5 idiom + UI conventions, abstraction) over a feature segment in apps/moderator, apps/auth or apps/creator-studio, and consolidate their findings. Use before calling a segment done, or when asked to review Svelte app work.
---

# SvelteKit segment review

The standard pre-completion review for the SvelteKit apps. **A segment is not done until this has run
and its findings are resolved.**

The conventions being enforced are [`docs/svelte-app-standard.md`](../../../docs/svelte-app-standard.md)
plus the reviewed app's own `CLAUDE.md`.

**These three lanes are pre-authorised. They do not count against a standing instruction not to spawn
subagents unasked** — running them needs no separate permission, and neither does chasing a lane that
goes idle. That covers the review lanes only; everything else about spawning is unchanged.

## 1. Scope the segment

Work out exactly what is under review and say so before spawning anything:

```bash
git diff --stat main...HEAD -- apps/<app>
git status --short
```

A "segment" is one slice of work — a page, a panel group, a service and its route. If the diff spans
several unrelated slices, review them one at a time; findings from a mixed diff are hard to act on.
Include uncommitted changes: the review exists to run *before* the commit.

**Name the app.** All three agents take the app directory as their scope, and the UI half of the idiom
review differs per app — `apps/auth` uses neither `@civitai/ui` nor `text-dark-2` yet.

## 2. Fan out

| Agent | Reviews |
| --- | --- |
| `svelte-correctness-review` | Logic, data shape, auth scope, failure paths |
| `svelte-idiom-review` | Svelte 5 idiom + the shared UI/styling conventions |
| `svelte-abstraction-review` | Duplication, missing components, placement |

Give each the same scope: the app directory, the file list, and any context it can't recover from the
code — what the segment is meant to do, and what was deliberately left out.

Running them **serially** is the safe default. Three at once is heavy, and on one occasion coincided
with the session dying mid-review; serial has been reliable. Spawn them together only when the segment
is small.

The three overlap at the edges by design; deduplicate at step 4.

## 3. If the segment was PORTED, add a fourth pass

The three above compare the code to itself and to the standard. **None of them opens the source**, so
all three pass cleanly over a faithful implementation of the wrong thing.

If this segment was ported from Retool or from the main Next.js app, run one more agent whose only
question is: *walk the source item by item — is each behaviour present, and does it match?* Give it the
source of truth and the built files. For Retool that is
`docs/moderator-app/retool-exports/<app>.md`, which carries each query's SQL — it lands with the Retool
migration branch, so it may not exist yet on `main`.

This is not optional pedantry: on one page the three code reviews returned 14 findings and missed four
absent capabilities that the fidelity pass found in a single run.

## 4. Consolidate

Merge into one ranked list. Do not relay three reports.

- **Drop what you can disprove.** Read the code for anything that sounds wrong; agents produce
  plausible-but-false findings, and a fix applied to a non-bug is a new bug.
- Deduplicate across agents — the same defect often surfaces as correctness *and* idiom.
- Rank by consequence: an operator shown false information, or an action that doesn't do what the screen
  says, outranks everything. Style findings go last.
- Separate **fix now** from **note and move on**, and put the second group somewhere durable rather than
  in chat where it evaporates.

Present the list and ask before applying fixes, unless the invoking request already said to fix them.

## 5. Close out

```bash
pnpm --filter ./apps/<app> run typecheck   # svelte-check alone; read WARNING lines too
```

Use `check` **only** if the route tree changed (added/removed/renamed a `+page`/`+server`/`+layout`),
which is the only time the generated `$types` go stale. Never run `build` as a check.

Then **look at the page** in a browser. Typecheck passes on plenty of pages that render blank — several
of the worst bugs in these apps were invisible to it.

Do not commit unless asked.
