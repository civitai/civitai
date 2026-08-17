---
name: civitai-review
description: Run the five Civitai review agents (reuse, safety, performance, tests, intent) over a feature segment in the main Next.js app (src/), consolidate their findings, and drive the fix loop to ship. Use before calling a segment done, or when asked to review main-app work.
---

# Civitai segment review — main app (`src/`)

The standard pre-completion review for the main Next.js app. **A segment is not done until this has run
and its findings are resolved.**

The conventions being enforced are the root [`CLAUDE.md`](../../../CLAUDE.md) and the docs it points at.
For work in `apps/moderator`, `apps/auth` or `apps/creator-studio`, use `svelte-review` instead — these
agents do not cover SvelteKit and will produce noise there.

This complements the built-in `/code-review`, which already handles generic correctness. What these five
add is Civitai-specific: *which* service, *which* component, *which* trap.

## 1. Scope the segment

Work out what is under review and say so before spawning anything:

```bash
git diff --stat main...HEAD -- src/
git status --short
```

A segment is one slice of work — a page, a router and its service, a feature. If the diff spans several
unrelated slices, review them one at a time; findings from a mixed diff are hard to act on. Include
uncommitted changes: the review exists to run *before* the commit.

Also locate the **intent doc** now, so the intent reviewer isn't the one to discover it's missing:

```
C:\Dev\Repos\work\model-share\_local\docs\plans\<feature>.md
```

Absolute path, from any worktree. 🔴 Never resolve `_local/` relatively — it exists only in the primary
worktree, and a relative write silently creates a second private copy that nobody else reads.

## 2. Fan out

| Agent | Reviews |
| --- | --- |
| `civitai-reuse-review` | Components/services/hooks rebuilt when they exist; pre-existing duplicate services |
| `civitai-correctness-review` | Auth scoping, money paths, PII, NSFW gating, failure paths |
| `civitai-perf-review` | N+1s, unindexed queries, feed-path cost, cache stampedes, bundle weight |
| `civitai-test-review` | Tests that pass regardless of the code under them |
| `civitai-intent-review` | Did the PR do what was actually asked |

Give each the same scope: the file list, what the segment is meant to do, and anything it can't recover
from the code — what was deliberately left out, what a reviewer already accepted.

Give `civitai-intent-review` the intent doc path and any mid-project scope changes from the
conversation. It is the only one whose input is not in the repo, so it is the only one you can starve
by accident.

**Serial is the safe default.** Five at once is heavy. Spawn in parallel only for a small segment, and
prefer pairing the cheap lanes (intent + test) if you do.

Skip a lane when the diff genuinely can't contain its findings — no tests changed and none should have
is a *finding for the test lane*, not a reason to skip it; no server code at all is a reason to skip
perf. Say which you skipped and why.

## 3. Consolidate

Merge into one ranked list. **Do not relay five reports.**

- **Drop what you can disprove.** Read the code for anything that sounds wrong; agents produce
  plausible-but-false findings, and a fix applied to a non-bug is a new bug.
- Deduplicate — the same defect commonly surfaces as reuse *and* perf (a rewritten query that the
  cached-by-id-array helper already answers), or safety *and* test (an unguarded path with a vacuous
  test over it).
- Rank by consequence: money moving wrongly and content crossing a gate first, then a dropped
  requirement, then production cost, then false confidence from a bad test, then reuse.
- Keep `civitai-reuse-review`'s **"Pre-existing service duplication"** section separate and clearly
  marked *not for this PR*. It is a map contribution, not a change request, and mixing it into the fix
  list is how the whole list gets ignored.
- 🔴 **Security findings stay out of the repo.** Do not paste an open safety finding into a PR body, a
  commit message, or a file under `docs/`, `claudedocs/` or `.claude/` — this repo is public and
  permanent. They live in the conversation until they are fixed.

## 4. The fix loop

**These agents report; they never patch.** The loop is explicit:

1. Reviewer reports findings.
2. **The implementer fixes them** — a different agent or a human, not the reviewer.
3. Back to the reviewer, **against the updated diff only** — not a fresh read of the whole segment.
   Re-reviewing everything each round is slow and re-litigates settled findings.
4. Iterate.

**A declined finding is a legitimate outcome, but it must come back with a reason.** The reviewer then
either accepts the reason or escalates to Justin. 🔴 **Silent non-fixes are the failure mode here** — a
finding that quietly doesn't appear in the next round has not been resolved, it has been lost. Track
the list across rounds and account for every item.

**Ship means: no unresolved findings, and every declined finding carrying an accepted reason.** Nothing
weaker.

Present the consolidated list and hand it to the implementer. Ask before applying fixes yourself,
unless the invoking request already said to.

## 5. Close out

Per `CLAUDE.md`'s "Before Committing":

```bash
pnpm run typecheck          # never `npx tsc`; never filter its output
pnpm run lint
pnpm run prettier:write     # uncommitted files only — never a repo-wide glob
pnpm run test:unit:run      # queued on this machine; targeted files are not
```

If `schema.full.prisma` changed: `pnpm run db:check-generated`, and surface that the migration must be
**applied manually** — this repo never runs `prisma migrate deploy`.

⚠️ `pnpm run typecheck` is blind to `__tests__` files, so a green typecheck does not clear the test
changes. ⚠️ If a queued unit run returns suspiciously fast or empty, check the dev-server daemon is
alive before believing it.

Then **look at the page** in a browser. Typecheck passes on plenty of pages that render blank.

Do not commit unless asked.
