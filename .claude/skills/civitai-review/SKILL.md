---
name: civitai-review
description: Run the Civitai review agents (reuse, reduction, safety, performance, tests, intent; plus comments when recording) over a feature segment in the main Next.js app (src/), record each lane in HQ so the hosted review imports it instead of re-running it, consolidate their findings, and drive the fix loop to ship. Use before calling a segment done, or when asked to review main-app work.
---

# Civitai segment review — main app (`src/`)

The standard pre-completion review for the main Next.js app. **A segment is not done until this has run
and its findings are resolved.**

The conventions being enforced are the root [`CLAUDE.md`](../../../CLAUDE.md) and the docs it points at.
For work in `apps/moderator`, `apps/auth`, `apps/creator-studio` or `apps/training-studio`, use
`svelte-review` instead — these agents do not cover SvelteKit and will produce noise there.

**These lanes (the six below, and `comment-review` when recording) are pre-authorised. They do not
count against a standing instruction not to spawn subagents unasked** — running them needs no separate permission, and neither does chasing a lane that
goes idle. That covers the review lanes only; everything else about spawning is unchanged. The
pre-authorisation lives here so it travels with the skill rather than through a relay: an agent cannot
tell a real global ruling from a mistaken one by reading someone's summary of it, so twice on 2026-08-19
agents correctly declined a relayed "he already said yes" and raised it instead.

This complements the built-in `/code-review`, which already handles generic correctness. What these lanes
add is Civitai-specific: *which* service, *which* component, *which* trap.

## 0. Recording, the PR and its base — before the review worktree

**Recording is on whenever your `hq` token can record.** Nothing needs configuring, and nothing
asks: when step 0's stop list passes, it rebases and pushes a draft (or a branch with no PR) and
opens the draft PR without confirmation. That is deliberate, so a local review leaves an HQ record
with no extra step. Check once:

```bash
hq --json whoami | jq -e '.token.scopes | any(. == "ack" or . == "bot" or . == "admin")'
# true (exit 0): record every lane you run (step 3a)
```

- `hq` not on PATH, a non-zero `whoami` exit (4: no token), or `false` (exit 1): review without
  recording, and **say so**. `whoami` alone also succeeds for a `recordings` or `read` token, and
  `record` needs `ack` or higher.
- Only the HQ MCP tools, no CLI: the same. `hq pr-review record` has no MCP equivalent; it reads the
  lane files from the local clone.
- The write grant on the record collections shows only at `record start` (a `403`), which needs a PR
  number. With no PR yet, step 0 opens the draft first; if `start` then refuses, say that the draft
  was opened for recording and nothing was recorded.

Without recording, step 0 skips the writes that exist only for recording: it opens no draft and
pushes no branch that has no PR. A draft's stale-base rebase and push still happen (they keep the
review on a current base, recorded or not).

A recorded lane is imported by the hosted review instead of being run again there (correctness always
re-runs hosted). An unrecorded local review means every lane runs twice on the shared usage, or HQ
has no record of the review at all.

🔴 **Step 0's writes (rebase, push, opening a draft) are the implementer's only:** run them only when
this session wrote the branch's work. A findings-only reviewer (step 5) skips them, even under the
author's `gh` identity: it reviews `headRefOid` as is, records there if the PR exists, and asks the
implementer to rebase if the base is stale.

Then, in the **implementer's tree** (the branch under review, not the review worktree), read the state.
Nothing here writes yet:

```bash
git fetch origin
gh pr view --json number,state,baseRefName,headRefName,headRefOid,isDraft,author   # none: no PR yet
git branch --show-current
git status --porcelain
```

`gh pr view` also finds a merged or closed PR for the branch. Only `state` `OPEN` is a usable PR.

**What step 0 would write**, decided before anything runs. `<base>` is `baseRefName`, or the branch
you will open the draft against; `<branch>` is `headRefName`, or the current branch with no PR:

- Ready PR (`isDraft` false): nothing.
- Draft: a rebase when `git rev-list --count HEAD..origin/<base>` is not 0, then a push when `HEAD`
  differs from `headRefOid`.
- No PR yet, recording: a rebase when that count is not 0, then a push and a draft PR.
- No PR yet, not recording: nothing. Say how many commits behind `<base>` the branch is (a rebase
  without the push would leave a pushed branch diverged from its remote).

🔴 **Stop and ask, changing nothing, when any of these holds.** This list gates EVERY write in step 0
(the rebase, the push, opening the draft), so check all of it first:

- **The PR is merged or closed:** `state` is `MERGED` or `CLOSED`. Never push or record onto it.
- **Step 0 would rebase or push, and `git status --porcelain` prints anything.** Checked before any
  rebase, so `rebase.autoStash` never stashes: the stash is shared by every worktree of the clone.
  When step 0 writes nothing, a dirty tree is no stop: the review may include uncommitted changes
  (step 1). No commit holds them, so a review that includes them cannot be recorded: review without
  recording, and say so.
- `HEAD` is detached: `git branch --show-current` prints nothing.
- **A PR exists and it is not yours:** the current branch is not `headRefName`, or `author.login` is
  not `gh api user -q .login`.
- **No PR yet, and the branch is shared:** it is the default branch
  (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`), `<base>`, `main` or `master`.
- **A branch step 0 would rebase or push is the base of an open PR**, draft or not:
  `gh pr list --base <branch> --json number -q length` is not 0. Rewriting it moves every child PR.
- **No PR yet, and the branch is not provably yours.** A pushed branch can be a teammate's, so it is
  yours only when nobody else has a copy (`origin/<branch>` does not exist) or every commit on it is
  yours: `git log --format=%ae origin/<base>..HEAD | grep -cvxF "$(git config user.email)"` prints 0.
- **The remote branch has commits `HEAD` lacks:** `git rev-list --count HEAD..origin/<branch>` is not 0
  (skip this when `origin/<branch>` does not exist yet, and on a ready PR, which step 0 never pushes).
  A teammate's push, or a reviewer's GitHub "Commit suggestion" click, lands there, and a rebase plus
  force-push would silently drop it.

**Stale base.** The count above is what the head lacks.

- **Ready PR: no rebase and no push.** Say how many commits behind its base it is, and review it as
  is. The head under review is `headRefOid`; if your local `HEAD` differs, say that the unpushed
  commits are not in this review.
- **Draft, or no PR yet and recording:** when the count is not 0, rebase:

  ```bash
  git rebase origin/<base>     # conflict: `git rebase --abort`, then stop and ask
  ```

**Push once (a draft, or no PR yet and recording), naming the branch.** Skip it when an existing
draft's `headRefOid` already equals `git rev-parse HEAD`. Pin the lease to the value you checked,
never a bare `--force-with-lease`: after `git fetch` that compares against the ref the fetch just
moved, so it always passes.

```bash
# Draft PR: the lease is the PR's own head
git push --force-with-lease=<headRefName>:<headRefOid> origin HEAD:<headRefName>
# No PR yet: the lease is origin/<branch> as checked above, or empty when it does not exist yet
git push -u --force-with-lease=<branch>:<oid or empty> origin HEAD:<branch>
```

A rejected push (`stale info`, or any non-zero exit) means the branch moved after you checked it:
stop and ask. Never retry with a bare `--force-with-lease` or with `--force`.

**No PR yet, and recording: then open a draft**, so the lanes record against its number. Base it per
`CLAUDE.md` (the integration branch, `main` or `feat/…`, never another PR's branch). This repo is
public: the title and body hold no infra details and no internal notes, as for any PR body here.

```bash
gh pr create --draft --head <branch> --base <base> --title "<title>" --body "<what it does>"
```

**Recording must start before a hosted round can.** The hosted review skips drafts, and can import
only runs that have started.

- Ready PR: the hosted review starts a round about 2 minutes after each push to a ready PR, so
  `headRefOid` has usually been reviewed already, and a record at it will usually not be imported. It
  is still HQ's record of this review: record it, and say that. For a fix-loop push, start the record
  BEFORE the push (step 3a).
- Draft: `record start` comes BEFORE the PR is marked ready. This skill never marks it ready: the
  draft stays a draft until the user says so (`gh pr ready <n>`).

Step 0's writes are those three, all to your own branch, before the review worktree exists. The
skill's other writes are the `hq pr-review` calls (step 1's `why set`, step 3a's `record`) and step 5.
Go straight on to 0a and step 3a's `start`.

## 0a. Set up the review worktree

Review runs in its own throwaway worktree, detached at the head under review, and **nothing is written
to it** — the implementer owns the tree the code was authored in. On a ready PR that head is
`headRefOid` exactly, never the local branch; otherwise it is `HEAD` after step 0. Every command
below names the review worktree by its absolute path, so none of them can act on whatever directory
the shell is in:

```bash
git -C <review worktree> checkout --detach <head under review>
WT=$(git -C <review worktree> rev-parse --show-toplevel)    # absolute
```

🔴 **If that head is based on an integration branch rather than `main`, this skill and its agents
do not exist in the tree.** They are tracked in the repo, so a worktree at a commit predating their
merge contains neither `.claude/skills/civitai-review/` nor `.claude/agents/civitai-*.md`: the skill is
not found and the `subagent_type` names do not resolve. Work stacked on a `feat/…` integration branch is
the normal case here, not the exception, so expect this rather than treating it as a broken install. The
failure is upstream of anything this file can say — by the time you could read a workaround here, you
would already have found the file.

**When recording, always bring the lane definitions in from `main`, and note the commit:**

```bash
AGENTS_REF=$(git -C "$WT" rev-parse origin/main)
git -C "$WT" checkout "$AGENTS_REF" -- .claude/agents
```

Only `.claude/agents`: the lanes read the rest of the head's own `.claude/**` (rules, hooks, skills),
which is what a PR that edits them changed. The lanes run under the default-branch definitions, which
is the version the hosted review matches on, and a PR that edits a lane cannot review itself under its
own edit. `record start` refuses a lane whose file in the tree differs from its bytes at `$AGENTS_REF`.

**The head predates the skill** (`git -C "$WT" cat-file -e HEAD:.claude/skills/civitai-review/SKILL.md`
fails): bring in all of `.claude` instead, recording or not, with `AGENTS_REF` set as above:
`git -C "$WT" checkout "$AGENTS_REF" -- .claude`. **Not recording, and the head has the skill:** skip
the checkout. The agents are already in the tree.

The tree is detached and throwaway, so a dirty `.claude` in it costs nothing and can never reach a PR.
Do not install the agents into `~/.claude/` instead: that is a second copy free to drift from the
repo's, and the repo's is the authoritative one.

⚠️ **That checkout STAGES the files, so the next `git checkout --detach` aborts** with local changes that
would be overwritten — which is how you find out, halfway through moving the tree to the next review.
Put `.claude` back to the head's own files first. This restores a lane file the checkout overwrote,
such as `comment-review.md`, and deletes the ones it added, only under `$WT`:

```bash
git -C "$WT" reset -q
git -C "$WT" checkout -- .claude
git -C "$WT" ls-files -z --others --exclude-standard -- .claude | xargs -0 -r -I{} rm -f -- "$WT/{}"
git -C "$WT" checkout --detach <next-sha>
# then this section's checkout again, for the new head
```

The third line is `git clean -f -- .claude` written so that a guard that blocks `git clean` lets it
through. 🔴 Never drop `"$WT/"` from it: `ls-files` prints paths relative to `$WT`, and a bare `rm`
resolves them against the shell's directory, which deletes another checkout's files.

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
uncommitted changes: the review exists to run *before* the commit. Such a review is not recorded (step 0).

Also locate the **intent doc** now, so the intent reviewer isn't the one to discover it's missing:
`<INTENT_DIR>/<feature>.md`, where `INTENT_DIR` comes from your own instructions or the primary
checkout's `CLAUDE.local.md` (see `civitai-intent-review`). If none is set, pass the intent reviewer the
PR body and linked ticket instead.

**When recording, make sure HQ has the PR's intent before any lane finishes:**

```bash
hq pr-review why civitai/civitai#<n>     # exit 3: nothing recorded
```

No `why <id> intent` line (exit 3, or only `response` lines): record it now with
`hq pr-review why set civitai/civitai#<n> --intent "…"`, plus `--tradeoffs` and the rest where they
apply. The `pr-review` skill's step 1 says what goes in it. Take it from the intent lane's source: the
intent doc, else the request, the PR body and the ticket. HQ keeps it internal. It never goes into the
PR body.

## 2. Fan out — the lanes this diff needs, at once, in one message

**Size the review to the diff before spawning anything.** Five lanes over a one-line change spend a
large share of a usage window and find nothing a careful read wouldn't.

- **Tiny diff — no agents.** About 30 changed lines or fewer, touching no server code, auth, money, PII
  or NSFW/browsing-level gating: read the diff yourself, or run `/code-review low`. Say that is what you
  did. No lane ran, so nothing is recorded: say that too. The hosted review runs those lanes.
- **Otherwise, launch each lane whose findings the diff can contain** (the skip rule below), and launch
  all six (seven when recording) for a feature-sized segment.
- **Once per segment, not once per fix iteration.** After fixes, re-run only the lanes whose findings
  you fixed.

**Each lane's model is set in its definition** — `opus` for correctness, where a missed auth or money
defect costs the most, and `sonnet` for the rest, which match the diff against known patterns. Don't pass a
`model` override when spawning; it would replace that choice.

🔴 **Launch every lane you run in a single message with multiple tool uses.** They are independent and
share no state.

A numbered list of steps reads as an instruction to run them one after another, so this is stated
rather than left to inference: **do not spawn them sequentially.** A six-lane review that takes six
times as long is the thing that makes people stop running it, and a review nobody runs finds nothing.

| Agent | Reviews |
| --- | --- |
| `civitai-reuse-review` | Components/services/hooks rebuilt when they exist; pre-existing duplicate services |
| `civitai-reduction-review` | Code that need not exist or could be much smaller; shims no release needs; dead code nearby |
| `civitai-correctness-review` | Auth scoping, money paths, PII, NSFW gating, failure paths |
| `civitai-perf-review` | N+1s, unindexed queries, feed-path cost, cache stampedes, bundle weight |
| `civitai-test-review` | Tests that pass regardless of the code under them |
| `civitai-intent-review` | Did the PR do what was actually asked |
| `comment-review` | **When recording only.** Comments that are false, or should not exist |

`comment-review` is a hosted lane too. Running it here leaves only correctness for the hosted run.
Its findings join section B at step 3.

The first five are the **code lanes** — same input, five questions, launched together.
`civitai-intent-review` launches alongside them but is **different in kind**: it reads the request
rather than the code, and its findings stay a separate section at step 3.

Give each the same scope: the file list, what the segment is meant to do, and anything it can't recover
from the code — what was deliberately left out, what a reviewer already accepted.

Give `civitai-intent-review` the intent doc path and any mid-project scope changes from the
conversation. It is the only one whose input is not in the repo, so it is the only one you can starve
by accident.

**Solo mode is deliberately not offered.** Running one adversarial reviewer over everything was
considered and rejected in favour of parallel lanes — the lanes hold different concrete knowledge
(which service, which trap, which measurement) and one agent carrying all of it dilutes each. This is a
decision, not an omission; do not helpfully collapse them.

Skip a lane only when the diff genuinely cannot contain its findings — no server code at all is a
reason to skip perf. "No tests changed" is *a finding for the test lane*, not a reason to skip it. Say
which you skipped and why. A skipped lane is not recorded, so the hosted review runs it. Typical shapes:

| Lane | The diff can contain its findings when it… |
| --- | --- |
| correctness | touches server code, tRPC procedures, auth, money, PII or NSFW gating |
| perf | touches queries (Prisma, `$queryRaw`), feed paths, caches, or adds client dependencies / page imports |
| test | changes logic — whether or not any test changed |
| reuse | adds new components, services, hooks or helpers, rather than editing existing ones |
| reduction | adds code — whether or not it deletes any |
| intent | is a feature with an intent doc or a stated request to measure against |
| comments | adds or edits comments |

### When recording, each lane also returns a structured result

The hosted review knows each lane by a name, which is what `record` takes:

| lane | agent |
| --- | --- |
| `correctness` | `civitai-correctness-review` |
| `intent` | `civitai-intent-review` |
| `perf` | `civitai-perf-review` |
| `reuse` | `civitai-reuse-review` |
| `tests` | `civitai-test-review` |
| `comments` | `comment-review` |

`civitai-reduction-review` has no hosted lane yet, so it is never recorded: run it locally and keep its
findings in section B.

A recorded lane is identified by **its definition file as it is at `$AGENTS_REF`** (step 0a): the
version comes from that file's raw bytes, and the model is its `model:` value as written. Spawn the
lanes as usual, with the usual inputs and no model override. A lane run under any other copy of its
definition, or another model, cannot claim that version or model, and a result recorded under a
version or model it did not run is worse than no record.

Ask each lane to END its report with this block, as the last fenced json in the report:

```json
{"lane": "<lane>", "head_sha": "<40-hex head>", "status": "complete", "checks": {"…": "its checks block, if it has one"},
 "findings": [
  {"file": "src/path.ts", "line": 42,
   "original_line": "<the exact text of that line in the diff, copied verbatim>",
   "severity": "high|medium|low", "category": "<short tag>",
   "finding": "<title>\n<what is wrong>\n<impact> / <reach> / <evidence kind> <ref>",
   "suggestion": "<what to do>", "confidence": 0.8, "scope": "pr|pre-existing"}]}
```

`"findings": []` when it found nothing. `file`, `original_line`, `severity` and `finding` are
required. 🔴 **Only those finding keys:** `record finish` refuses any other. The lane definitions say
`impact`, `reach` and `evidence` become finding fields under a JSON contract. Tell the lane that this
contract has no such fields, and that they go on the last line of `finding`, as above.

So an imported local run does not carry the hosted lanes' `checks` block, or impact, reach and
evidence as fields: the record keeps only the finding keys above, and the facts are text in `finding`.
Step 3's checks of both are the local control.

### Lanes routinely go idle without delivering. Chasing them is YOUR job, and it is the only control.

🔴 **This is normal, not exceptional. Expect it every round.** Measured across one project's four review
rounds: **6 of 13 lanes finished, went idle, and sent nothing.** In the worst round it was 4 of 4. Every
one reported in full when re-pinged — re-pinging worked **8 times out of 8**.

🔴 **Account for every lane by name before you consolidate, and chase every silent one.** Not "should".
A lane that goes idle without reporting has *failed*, and it is indistinguishable from a lane that found
nothing — which is the one failure this skill's own format actively hides, since step 3 asks you to say
plainly when a lane found nothing. The consolidated report then reads as complete while missing a fifth
of the review. On the run that discovered this, the vanished lane held the sharpest finding of the round.

Tell each lane in its prompt how its findings get back to you — final message text, or an explicit send
for an agent whose own transcript reaches nobody. **Treat that as a hint that reduces the rate, not as a
control that removes your obligation.**

⚠️ **The agent-definition version of this rule was tried and did not work.** #4011 wrote the same
obligation into the lane agent definitions, where it would not depend on the invoker remembering.
Measured before and after: **2 of 4 lanes silent before, 4 of 4 after.** The text is still in the agent
files and is kept, because it costs a paragraph and may help at the margin — but it does not solve this,
and the numbers are recorded here so nobody re-derives that fix and believes it worked.

Stated plainly because the mechanism is the problem, not the wording: **prose in a definition cannot make
delivery happen.** Do not spend effort making it work harder. A structural enforcement — something in the
harness that requires a report before an agent can finish — would be the real fix, and it is not
something a markdown file can do. **That is the open problem; this manual chase is the control until it
is solved.** A known-manual control beats a fixed-looking automatic one.

⚠️ And do not read "I caught the silent lanes" as evidence the system works. A run where someone already
knew about this failure and watched for it proves nothing about the run where nobody does — which is
every run after the one that discovered it.

## 3. Consolidate

**Do not relay the lane reports.** Produce **three sections**, in this order:

**A. Does it deliver the request** — `civitai-intent-review`'s output, on its own.

Intent findings are **not ranked in with code defects**; they are not comparable and mixing them makes
both harder to act on. "This doesn't do what was asked" and "this query is an N+1" call for different
decisions from different people, and a merged list buries the first under the second. Carry the intent
lane's confidence note with it — whether the doc was reviewer-authored or postdates the code changes
what the whole section is worth.

**B. Code findings** — the five code lanes, and `comment-review` when it ran, merged into one ranked list.

- **Drop what you can disprove.** Read the code for anything that sounds wrong; agents produce
  plausible-but-false findings, and a fix applied to a non-bug is a new bug.
- Deduplicate — the same defect commonly surfaces as reuse *and* perf (a rewritten query that the
  cached-by-id-array helper already answers), or safety *and* test (an unguarded path with a vacuous
  test over it).
- **Severity comes from each finding's facts, not the lane's word.** Every lane reports `impact`,
  `reach` and `evidence` per finding (defined in each lane's Report section); its own severity is
  advisory. A finding missing a fact goes back to its lane like a missing `checks` block. Intent findings carry the facts too, for
  the hosted gate; section A keeps them unranked and computes no severity for them. Compute:
  - `money`, `access`, `data-loss` or `privacy`: `normal-use` is **high** when the evidence is
    `traced` or `reproduced` and **medium** when only `inferred`; `unusual-state` is **medium**;
    `theoretical` is **low**.
  - `wrong-for-user`: `normal-use` is **medium**, otherwise **low**.
  - `internal` and `maintainability`: **low**, except a reduction finding, which keeps its lane's
    severity (medium or low, never high): a meaningful cut is the point of that lane.
  - Floor: `money` or `access` in a file whose path names auth, session, permission, Buzz, payment,
    Stripe, Paddle, billing, purchase, payout, withdraw, subscription, email, PII, NSFW, browsing level
    or moderation is at least **medium**.
- Rank by consequence: money moving wrongly and content crossing a gate first, then production cost,
  then false confidence from a bad test, then reuse and reduction.
- **Read each lane's `checks` block.** The test, reuse, reduction and correctness lanes end every report with one
  (`assertions`; `searches`; `searches`; `writes` and `siblings`; the shape is in each definition's Report section).
  A missing block, or a missing key, means the lane skipped its method: re-ping it as you would a silent
  lane. A `"none"` clear or a `passes`/`hangs` assertion with neither a finding nor a `reason` is the
  same gap. The block lists sibling paths but cannot show which were checked: read that from the lane's
  prose and each entry's `reason`, and treat a sibling neither one accounts for as the same gap.

**C. Map contribution, not for this PR** — `civitai-reuse-review`'s "Pre-existing service duplication".

It is a map contribution, not a change request; nobody is expected to fix it here. Mixing it into the
fix list is how the whole list gets ignored.

Across all three sections:

🔴 **Security findings stay out of the repo.** Do not paste an open safety finding into a PR body, a
commit message, or a file under `docs/`, `claudedocs/` or `.claude/` — this repo is public and
permanent. They live in the conversation, and in HQ when recording (step 3a), until they are fixed.

## 3a. Record the review (when step 0 turned recording on)

Write the record ONLY with `hq pr-review record`. It derives the keys the hosted review matches on.
Point it at the review worktree (`--repo-dir "$WT"`), where the lane files are.

1. **Before spawning the lanes**, one call for every lane you will spawn:

   ```bash
   hq pr-review record start --repo civitai/civitai --pr <n> --head "$(git -C "$WT" rev-parse HEAD)" \
     --lanes <lane,lane,…> --agents-ref "$AGENTS_REF" --repo-dir "$WT"
   ```

   It prints one `run <id> running <lane> …` line per lane: keep each lane's run id. A non-zero exit
   recorded nothing. Say why (the error names the lane and the reason; a `403` means no grant yet, see
   the `pr-review` skill's "What you need"), review without recording, and don't work around it.
2. **When each lane has delivered** (after the step 2 chase), save its result block, byte for byte, to
   a file outside the review tree (`mktemp`), and run:

   ```bash
   hq pr-review record finish <run id> --findings <file>
   ```

   If `finish` exits 1 on an invalid finding, it wrote nothing: ask THE LANE to re-emit its block, then
   run `finish` again. Never edit a finding yourself. A lane still silent after the chase, or one that
   failed: `hq pr-review record fail <run id>`, never complete with no findings.

The record is only worth anything if it is exact: same head, same prompt version and model, every
finding as the lane wrote it, including ones you drop at step 3. Consolidation is a separate
judgement. A push after the review is a new head, and nothing recorded at the old head covers it:
each fix-loop or re-targeted re-run is a new `start` at the new head, with `$AGENTS_REF` taken again
after step 0's fetch.

🔴 **A fix-loop push to a ready PR: `start` BEFORE the push.** The hosted review starts a round about
2 minutes after each push to a ready PR, so a record started after the push will usually not be
imported, and every lane runs twice. In this order:

1. The implementer commits the fix and does not push yet.
2. With every lane idle, move the review worktree to that new local commit: step 0a's reset lines
   with `<next-sha>` = `<new sha>`, then 0a's checkout again, with `$AGENTS_REF` taken after a fresh
   `git fetch origin`.
3. `record start` at `<new sha>`, for the lanes you will re-run.
4. Only then does the implementer push, and it must be exactly `<new sha>`: a record at any other
   head matches nothing.
5. Run those lanes, and `finish` each as above.

On a draft the order does not matter, as long as `start` comes before the PR is marked ready.

When the user marks the draft ready, the hosted round imports the recorded lanes, if their head is
still the PR's head.

The correctness lane is also re-run independently by a hosted reviewer, whatever you record. Record it
anyway: the overlap between the two is what the record measures.

Step 3's rule covers the record too: never copy an open safety finding from HQ into a PR body, commit
message or file in this repo.

## 4. The fix loop

**These agents report; they never patch.** The loop is explicit:

1. Reviewer reports findings.
2. **The implementer fixes them** — a different agent or a human, not the reviewer.
3. Back to the reviewer, **against the updated diff only** — not a fresh read of the whole segment.
   Re-reviewing everything each round is slow and re-litigates settled findings. Re-run only the lanes
   whose findings were touched, and launch those together in one message as in step 2. When
   recording on a ready PR, that re-run's `record start` comes before the implementer pushes (step 3a).
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
either accepts the reason or escalates to the user. 🔴 **Silent non-fixes are the failure mode here** — a
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

**Move the tree only when every lane is idle**, and account for every lane by name first, per step 2 — an
idle lane that never reported is still holding a read you are about to invalidate. That is the safe
moment and the only one. Reset `.claude` and move it as in step 0a, then re-apply 0a's checkout:

```bash
git -C "$WT" checkout --detach origin/<branch>     # after 0a's three reset lines
git -C "$WT" checkout "$AGENTS_REF" -- .claude/agents   # whichever checkout 0a calls for
```

Without that second line the agents disappear again mid-review (or, when recording, `record start`
refuses the lanes), and the next fan-out fails to resolve them.

## 5. Close out — the implementer's step, not the reviewer's

🔴 **If you ran this skill as a findings-only reviewer, stop at step 4.** Everything below writes
to the tree:
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

⚠️ `pnpm run typecheck` is blind to every test file, so a green typecheck does not clear the test
changes: run `pnpm run typecheck:tests` (`.claude/rules/testing.md`). ⚠️ If a queued unit run returns suspiciously fast or empty, check the dev-server daemon is
alive before believing it.

Then **look at the page** in a browser. Typecheck passes on plenty of pages that render blank.

Do not commit unless asked.
