# Reading a CI result on a PR

Two traps, both measured on 2026-09-04, both of which produced a **real, correct, still-visible
green attached to the wrong commit**. Neither is a silent negative — there is nothing absent to
notice, which is what makes them worse than the failure modes we already write down.

## 1. `gh pr checks` answers a question you did not ask

On PR #4640 it reported `no checks reported on the branch`. That reads as "CI has not started yet".
What was actually true: **four workflow runs existed and had passed**, against a commit three
pushes behind the branch tip.

`gh pr checks` and the PR's own checks tab are scoped in a way that can leave you with a green you
did not earn. Ask about the SHA instead:

```bash
sha=$(gh pr view <pr> --json headRefOid -q .headRefOid)
gh api repos/<owner>/<repo>/commits/$sha/status     -q '.state'
gh api repos/<owner>/<repo>/commits/$sha/check-runs -q '.total_count'
gh run list --branch <branch> --json headSha,name,conclusion
```

**A healthy internal PR here has 13 check-runs at head and a `success` combined status** carrying
`tekton / typecheck` and `tekton / fixture-bootstrap` (measured across PRs #4641–#4643). A count of
0 is obvious; a count of 4 would not have been, which is why the number is worth knowing.

The two systems are separate and you need both. For an internal PR targeting `main`,
`tekton / typecheck` is the **authoritative** typecheck — the GitHub Actions typecheck job
deliberately skips that case (see the header of `.github/workflows/lint.yml`). So a check set that
contains Actions results but no Tekton status does not cover the thing that gates.

## 2. `gh pr view --json headRefOid` can hand you the previous SHA

Immediately after a force-push it returned the **old** commit. On that single read the push looks
like it failed. Confirm from three sources that agree — local `HEAD`, `origin/<branch>`, and the
PR's `headRefOid` — before reporting either way.

## Unconfirmed: force-push may not re-trigger either CI system

**Hypothesis, not established.** On PR #4640 the only push that ever produced runs was the branch's
**first, non-force** push. Three subsequent `--force-with-lease` pushes and one close/reopen produced
nothing from GitHub Actions *or* Tekton, while three other PRs open at the same time each had a full
13 runs at head. All four workflows are `on: pull_request: branches: [main, release]` with no
`types:`, so the default already includes `synchronize` and `reopened` — the configuration says this
should have fired.

Confirming it needs a second force-pushed PR to compare against, which we did not have.

**If it is true, the consequence is the one worth caring about:** a force-pushed PR can sit
indefinitely at a green belonging to an older commit, while `gh pr checks` reports nothing wrong.
Reviewers see a PR that looks tested and is not.

**Until someone confirms or refutes it: after any force-push, check by SHA that runs exist for the
new commit.** If none appear, push a real commit rather than re-forcing — that is the only shape of
push observed to produce runs here, and this repo squash-merges, so the extra commit never reaches
`main`'s history.

> The workflow file already warns about the general form of this, about a different question:
> *"Both were reasoning from the workflow's CONFIGURATION, which says nothing about whether the job
> RUNS."* Everything above is the same lesson, arrived at from the other direction.
