---
name: moderator-review
description: Run the three moderator-app review agents (correctness, Svelte 5 + UI conventions, abstraction) over a feature segment and consolidate their findings. Use before calling any apps/moderator migration segment done, or when asked to review moderator-app work.
---

# Moderator app segment review

Runs the standard pre-completion review for `apps/moderator`. **A migration segment is not done until
this has run and its findings are resolved.**

## 1. Scope the segment

Work out exactly what is under review and say so before spawning anything:

```bash
git diff --stat main...HEAD -- apps/moderator
git status --short
```

A "segment" is one slice of work — a page, a panel group, a service and its route. If the diff spans
several unrelated slices, review them one at a time; findings from a mixed diff are hard to act on.
Include uncommitted changes: the review exists to run *before* the commit.

## 2. Fan out

Spawn all three **in one message so they run concurrently**:

| Agent | Reviews |
| --- | --- |
| `moderator-correctness-review` | Logic, data shape, auth scope, failure paths |
| `moderator-svelte-review` | Svelte 5 idiom + shadcn/`text-dark-2`/panel conventions |
| `moderator-abstraction-review` | Duplication, missing components, placement |

Give each the same scope: the file list, the branch/diff command, and any context it can't recover
from the code — what the segment is meant to do, what was deliberately left out, and for a Retool
migration, the inventory path (`docs/moderator-app/retool-exports/<app>.md`).

The three overlap at the edges by design; deduplicate at step 3 rather than narrowing their briefs.

## 3. Consolidate

Merge into one ranked list. Do not relay three reports.

- **Drop what you can disprove.** Read the code for anything that sounds wrong; agents produce
  plausible-but-false findings, and a fix applied to a non-bug is a new bug.
- Deduplicate across agents — the same defect often surfaces as correctness *and* idiom.
- Rank by consequence: a moderator shown false information, or an action that doesn't do what the
  screen says, outranks everything. Style findings go last.
- Separate **fix now** from **note and move on**, and put the second group somewhere durable (the
  tracker, or the slice's "not ported" notes) rather than in chat where it evaporates.

Present the list and ask before applying fixes, unless the invoking request already said to fix them.

## 4. Close out

After the fixes:

```bash
cd apps/moderator && pnpm run check
```

Then **look at the page** in a browser (`/dev-server` skill). Typecheck and build pass on plenty of
pages that render blank — several of this app's worst bugs were invisible to both.

Update the relevant tracker — [`MIGRATIONS.md`](../retool-migration/MIGRATIONS.md) for Retool work,
[`page-migration-checklist.md`](../../../docs/moderator-app/page-migration-checklist.md) for main-app
pages — and record anything deliberately left unfixed with the reason.

Do not commit unless asked.
