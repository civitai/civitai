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

## 0. Set up the review worktree

Review runs in its own throwaway worktree, detached at the head under review, and **nothing is written
to it** — the implementer owns the tree the code was authored in.

🔴 **If that head is based on an integration branch rather than `main`, this skill and its five agents
do not exist in the tree.** They are tracked in the repo, so a worktree at a commit predating their
merge contains neither `.claude/skills/civitai-review/` nor `.claude/agents/civitai-*.md`: the skill is
not found and the `subagent_type` names do not resolve. Work stacked on a `feat/…` integration branch is
the normal case here, not the exception, so expect this rather than treating it as a broken install. The
failure is upstream of anything this file can say — by the time you could read a workaround here, you
would already have found the file.

Bring them in from `main` before spawning anything:

```bash
git checkout origin/main -- .claude
```

The tree is detached and throwaway, so a dirty `.claude` in it costs nothing and can never reach a PR.
Do not install the agents into `~/.claude/` instead: that is a second copy free to drift from the
repo's, and the repo's is the authoritative one.

## 1. Scope the segment

**Determine the base first — it is usually not `main`.** Work stacks on a feature integration branch far
more often than it sits directly on `main`, and diffing against `main` drags in every unrelated commit
that landed on the integration branch. Take the base from the invoking request, or read it off the PR:

```bash
gh pr view <n> --json baseRefName -q .baseRefName
```

Then scope against that base, and say what it is before spawning anything:

```bash
BASE=origin/feat/<integration-branch>   # whatever the PR is actually based on
git diff --stat $BASE...HEAD -- src/
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

## 2. Fan out — all five at once, in one message

🔴 **Launch every lane in a single message with multiple tool uses.** They are independent and share no
state.

A numbered list of steps reads as an instruction to run them one after another, so this is stated
rather than left to inference: **do not spawn them sequentially.** A five-lane review that takes five
times as long is the thing that makes people stop running it, and a review nobody runs finds nothing.

| Agent | Reviews |
| --- | --- |
| `civitai-reuse-review` | Components/services/hooks rebuilt when they exist; pre-existing duplicate services |
| `civitai-correctness-review` | Auth scoping, money paths, PII, NSFW gating, failure paths |
| `civitai-perf-review` | N+1s, unindexed queries, feed-path cost, cache stampedes, bundle weight |
| `civitai-test-review` | Tests that pass regardless of the code under them |
| `civitai-intent-review` | Did the PR do what was actually asked |

The first four are the **code lanes** — same input, four questions, launched together.
`civitai-intent-review` launches alongside them but is **different in kind**: it reads the request
rather than the code, and its findings stay a separate section at step 3.

Give each the same scope: the file list, what the segment is meant to do, and anything it can't recover
from the code — what was deliberately left out, what a reviewer already accepted.

Give `civitai-intent-review` the intent doc path and any mid-project scope changes from the
conversation. It is the only one whose input is not in the repo, so it is the only one you can starve
by accident.

**Solo mode is deliberately not offered.** Running one adversarial reviewer over everything was
considered and rejected in favour of five parallel lanes — the lanes hold different concrete knowledge
(which service, which trap, which measurement) and one agent carrying all of it dilutes each. This is a
decision, not an omission; do not helpfully collapse them.

Skip a lane only when the diff genuinely cannot contain its findings — no server code at all is a
reason to skip perf. "No tests changed" is *a finding for the test lane*, not a reason to skip it. Say
which you skipped and why.

### Tell every lane how to deliver, and never read silence as a clean lane

🔴 **Each lane's prompt must say how its findings get back to you** — that its final message text *is*
the return value, or, for an agent whose own transcript reaches nobody, that it must send the report
explicitly. A lane that finishes with its report only in its transcript has delivered nothing, and it
has no way to know that.

🔴 **A lane that goes idle without reporting has failed. Re-ping it.** Do not record it as a clean lane.
This is the one failure this skill's own format actively hides: step 3 asks you to say plainly when a
lane found nothing, which makes a lost lane and a clean lane read identically — and the consolidated
report then looks complete while missing a fifth of the review. It has happened on a real run, and the
lane that vanished held the sharpest finding of the round. **Account for all five by name before you
consolidate**, and treat "idle" as a question, not an answer.

The same obligation is written into each of the five agent definitions, where it does not depend on the
invoker remembering to pass it. Both are kept: they fail independently, and the redundancy costs a
paragraph. ⚠️ **Do not read "I caught the silent lanes" as evidence the system works.** A run where
someone already knew about this failure and watched for it proves nothing about the run where nobody
does — which is every run after the one that discovered it.

## 3. Consolidate

**Do not relay five reports.** Produce **three sections**, in this order:

**A. Does it deliver the request** — `civitai-intent-review`'s output, on its own.

Intent findings are **not ranked in with code defects**; they are not comparable and mixing them makes
both harder to act on. "This doesn't do what was asked" and "this query is an N+1" call for different
decisions from different people, and a merged list buries the first under the second. Carry the intent
lane's confidence note with it — whether the doc was reviewer-authored or postdates the code changes
what the whole section is worth.

**B. Code findings** — the four code lanes, merged into one ranked list.

- **Drop what you can disprove.** Read the code for anything that sounds wrong; agents produce
  plausible-but-false findings, and a fix applied to a non-bug is a new bug.
- Deduplicate — the same defect commonly surfaces as reuse *and* perf (a rewritten query that the
  cached-by-id-array helper already answers), or safety *and* test (an unguarded path with a vacuous
  test over it).
- Rank by consequence: money moving wrongly and content crossing a gate first, then production cost,
  then false confidence from a bad test, then reuse.

**C. Map contribution, not for this PR** — `civitai-reuse-review`'s "Pre-existing service duplication".

It is a map contribution, not a change request; nobody is expected to fix it here. Mixing it into the
fix list is how the whole list gets ignored.

Across all three sections:

🔴 **Security findings stay out of the repo.** Do not paste an open safety finding into a PR body, a
commit message, or a file under `docs/`, `claudedocs/` or `.claude/` — this repo is public and
permanent. They live in the conversation until they are fixed.

## 4. The fix loop

**These agents report; they never patch.** The loop is explicit:

1. Reviewer reports findings.
2. **The implementer fixes them** — a different agent or a human, not the reviewer.
3. Back to the reviewer, **against the updated diff only** — not a fresh read of the whole segment.
   Re-reviewing everything each round is slow and re-litigates settled findings. Re-run only the lanes
   whose findings were touched, and launch those together in one message as in step 2.
4. Iterate.

🔴 **Narrowing on re-review narrows *which lanes run*, never *what each running lane sees*.** Give every
re-run lane the complete updated diff, not only the hunks matching its own findings.

Deciding a whole lane is irrelevant is cheap to get right — reuse has nothing to say about a one-line
SQL fix. Deciding which *part* of a diff is relevant to a lane is the same guess the lane exists to make
for us, and it is wrong in the case that matters: a fix in one lane's territory changes the code another
lane's findings were about. A test lane shown only its own changed assertions reviews them against a
function that no longer exists in the form it is imagining — new refusals mean new branches, and "is
this test still meaningful" cannot be answered from the assertion alone.

**A declined finding is a legitimate outcome, but it must come back with a reason.** The reviewer then
either accepts the reason or escalates to Justin. 🔴 **Silent non-fixes are the failure mode here** — a
finding that quietly doesn't appear in the next round has not been resolved, it has been lost. Track
the list across rounds and account for every item.

**Ship means: no unresolved findings, and every declined finding carrying an accepted reason.** Nothing
weaker.

Present the consolidated list and hand it to the implementer. Ask before applying fixes yourself,
unless the invoking request already said to.

### When the head moves mid-review

The implementer may push while the lanes are still reading. They are asked to mail the reviewer the new
SHA on every push — but do not depend on it, because a review is detached at a SHA and does not follow
the PR.

🔴 **Never move the worktree while lanes are running.** Checking out a new head swaps files beneath
agents mid-read, and the reports then describe two different commits with nothing marking which is
which. Read the delta out of git instead, which touches no file in the tree:

```bash
git fetch origin <branch>
git diff <old-sha> <new-sha>
git show <new-sha>:<path>
```

Then re-target only the lanes whose subject those files touch — the same rule as the loop above.

**Move the tree only when every lane is idle**, and account for all five by name first, per step 2 — an
idle lane that never reported is still holding a read you are about to invalidate. That is the safe
moment and the only one. After the checkout, re-apply step 0:

```bash
git checkout --detach origin/<branch>
git checkout origin/main -- .claude    # the branch still predates the skill
```

Without that second line the agents disappear again mid-review, and the next fan-out fails to resolve
them.

## 5. Close out — the implementer's step, not the reviewer's

🔴 **If you ran this skill as a findings-only reviewer, stop at step 4.** Everything below writes:
`prettier:write` rewrites files in place, and a review tree is read-only by construction. Hand the
consolidated list to the implementer and let them close out in the tree they own.

The rest of this step belongs to whoever is committing, per `CLAUDE.md`'s "Before Committing":

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
