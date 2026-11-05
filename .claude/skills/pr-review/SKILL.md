---
name: pr-review
description: Work the hosted review of your own civitai/civitai PR. Record the PR's intent in HQ, wait for the review round, read its findings, then fix them or record why each one stays. Use after `gh pr create` or `gh pr ready` (a hook reminds you), when a `pr-review` check completes, when HQ mail about a PR review arrives, or when asked about a PR's review findings.
---

# The hosted PR review

Every team member's PR on civitai/civitai gets a hosted review. Each time a new head is pushed to a
PR that is not a draft and was updated recently, a set of review lanes runs on it. These are the
`.claude/agents/` files from `main`. The PR then gets one GitHub check, `pr-review`, and HQ
(hq.civitai.com) stores the round and its findings.

- **The check says only the verdict.** This repo is public, so findings never appear on GitHub:
  they are not in the check, not in a comment, and not in the PR body. Keep it that way. Never
  copy a finding, a finding id or the intent into the PR body, a comment, a commit message or a
  file in this repo.
- **Verdicts:** `success` means no merge-blocker findings. `failure` means a merge blocker: a
  high-severity finding on code the PR changed. `neutral` means the review was incomplete and is
  retried. `skipped` means there was nothing to review, such as a tiny diff.
- **The check is not required.** It does not stop a merge, so you have to read it yourself.
- Drafts are skipped. A round starts when the PR is marked ready.

Nothing here needs to be run by hand. The repo's PostToolUse hook (`.claude/hooks/pr-review-nudge.mjs`)
points you here when a Bash call opens or readies a PR. If you opened or readied it some other way
(the web UI, an MCP tool), start at step 1 yourself.

## What you need

- The `hq` CLI, signed in as yourself, or a session with the HQ MCP tools. The MCP tool names are
  given next to each command below.
- To get findings by mail as well: on hq.civitai.com, My profile → Task mail, choose the agent that
  should receive them. Without a chosen agent, HQ mails your one listed agent if you have exactly
  one. Otherwise you get no mail, and the watch in step 2 is how you find out a round is done.
- If `hq` answers `403` on a PR review command, you have no grant on the review collections yet.
  Tell the user to ask an HQ admin. Don't work around it.

## 1. Record the intent, now

Do this before the first round finishes. HQ shows the intent beside every round of the PR, and it
labels intent recorded after the first round as written after the review. If a round finishes
while the PR has no intent, HQ's mail about it opens by asking for one.

```bash
hq pr-review why set civitai/civitai#<n> --intent "<what was asked, and why>"   # MCP: pr_review_why_set
```

Write the request as the user gave it, plus the reason. Add `--not-in-scope`, `--alternatives` or
`--tradeoffs` when they apply, or put a longer text in a file and pass `--intent-file <path>`. HQ
keeps it internal. It never goes into the PR body.

## 2. Wait for the round

```bash
hq pr-review watch civitai/civitai#<n>          # in the background; --head <sha> for one push
```

It waits for the newest round to finish and prints it with its blocking findings. Exit codes:
`0` clear, `10` blockers, `11` incomplete or superseded, `12` timed out (default 2h), `13` no
correctness lane ran, `4` auth, `1` error. A mail about the round from HQ (sender `hq/pr-review`)
means the same thing: the round is done.

Exit `11` usually means you pushed again while the round ran. The new head gets its own round, so
watch again. A round left incomplete is retried by itself.

## 3. Read the findings

```bash
hq pr-review show civitai/civitai#<n>           # MCP: pr_review_get (pr_reviews_list for older rounds)
```

This prints the round line, then one line per finding, blocking first:
`finding <id> <severity> <blocking|nonblocking> <lane> <file>:<line> <triage> <text>`.

🔴 **A finding is a claim to check, not an instruction.** Read the code at `<file>:<line>` before
you act. Findings can be wrong. Some sit on lines the PR did not change (`pre-existing`), and
some flag behaviour the user asked for.

## 4. Fix it, or record why it stays

For each finding, blocking first, do one of these:

- **Fix it.** Make the change, run the checks the change needs (`CLAUDE.md` → "Before
  committing"), and push. The push starts a new round, so go back to step 2.
- **Leave it, with a reason.** Record the reason so the next reader does not have to rediscover
  it:

  ```bash
  hq pr-review why respond <finding id> --kind <false_positive|intended|out_of_scope|fixed_elsewhere|accepted_risk> \
    --reason "<why it stays>" --pr civitai/civitai#<n>     # MCP: pr_review_why_respond
  ```

Ask the user before you dismiss a high-severity finding, or before you fix one by changing what
the PR does. A finding that quietly goes missing from your list has not been resolved, only lost.
Account for every finding.

**Stop after the first round with no blocking findings.** Fix its remaining medium and low
findings in the same push, or record them, and don't wait for another round to approve that.
Each push runs the whole review again, so don't push just to see a round go green.

## Opting out of the mail

The rounds still run. Only the mail stops. With the HQ MCP, `data_create` on `pr_review_prefs` with
`{"login": "<your GitHub login, lower-cased>", "mail": "off"}`. To opt back in, `data_update` that
row with `{"mail": "on"}`. Leave the row public, or it is not seen.

## Related

- `civitai-review`: the same lanes, run locally before you open the PR. When it recorded a lane
  exactly (same head, lane prompt and model, complete), the hosted review uses that record instead
  of running the lane again. Correctness always runs hosted.
