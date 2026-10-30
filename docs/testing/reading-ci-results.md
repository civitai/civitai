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

**A healthy internal PR here has 5 `Lint` check-runs at head and a `success` combined status**
carrying `tekton / typecheck` and `tekton / fixture-bootstrap`. Two of the five are `skipped` by
design: `Typecheck` (Tekton's covers an internal PR) and `Unit tests` (runs on `main`, on
dispatch and on a PR with the `full-ci` label; skipped, it is one check, not four shards). With the
`full-ci` label the `Unit tests` check expands to 4 shard check-runs (`Unit tests (1)` .. `(4)`), so
the same PR has 8 `Lint` check-runs, one of them (`Typecheck`) skipped. A PR that touches `apps/`, `packages/` or
the root files the app suites read also gets 1 `App suites` check-run (`App unit tests + typecheck`);
any other PR gets none, and that is by design, not a missing run (the list is the `paths:` filter in
`.github/workflows/apps.yml`). Expect `pr-review` on top, plus a check per job of any other workflow
the PR's paths trigger. A count of
0 is obvious; a count of 4 would not have been, which is why the number is worth knowing.

The two systems are separate and you need both. For an internal PR targeting `main`,
`tekton / typecheck` is the **authoritative** typecheck — the GitHub Actions typecheck job
deliberately skips that case (see the header of `.github/workflows/lint.yml`). So a check set that
contains Actions results but no Tekton status does not cover the thing that gates.

**On a draft PR, Lint runs ESLint only.** The same 5 `Lint` check-runs appear, but every one except
`ESLint + Prettier (changed files)` is `skipped`, and the `App suites`, tRPC parity and schema drift
jobs skip too. (The Windows dev-env smoke never runs on PRs; it runs on pushes to `main` and on
dispatch: `gh workflow run windows-dev-env.yml -R civitai/civitai --ref <branch>`.) That is the draft gate, not a broken run: the jobs start when the PR is
marked ready (`gh pr ready <pr>`). To get a verdict while it is still a draft, add the `full-ci`
label (`gh pr edit <pr> --add-label full-ci`): it runs every Lint job, the unit shards included, and
the app suites if the PR's paths reach them, on this and every later push until it is removed. It
does not lift the draft gate on schema drift or tRPC parity. Or dispatch one on the branch, which
runs against the branch head rather than the merge with `main`:

```bash
gh workflow run lint.yml -R civitai/civitai --ref <branch> -f only=<job>   # typecheck, unit, packages, component, ...
gh workflow run apps.yml -R civitai/civitai --ref <branch>                 # app suites + app typecheck
```

## 2. `gh pr view --json headRefOid` can hand you the previous SHA

Immediately after a force-push it returned the **old** commit. On that single read the push looks
like it failed. Confirm from three sources that agree — local `HEAD`, `origin/<branch>`, and the
PR's `headRefOid` — before reporting either way.

## Two systems post here, they fail independently, and one of them stopped

| System | Surfaces as | Latency |
| --- | --- | --- |
| Tekton (in-cluster) | **commit statuses** — `tekton / typecheck`, `tekton / fixture-bootstrap` | ~3.5 min |
| GitHub Actions | **check-runs** — Lint, Schema drift gate, Submodule Pin Guard | ~immediate |

Observed on PR #4640 over an evening, in order: branch created and pushed → 4 Actions runs + 2 Tekton
statuses. Three amend + `--force-with-lease` pushes → **nothing from either**. One close/reopen →
nothing. Two normal pushes → **Tekton only**. One rebase + `--force-with-lease` → **Tekton only**.

**What is established:** GitHub Actions fired once, on the branch's first push, and never again —
through six subsequent pushes of three different shapes. That is a real and unexplained failure, and
it is why `gh pr checks` on this PR can report a pass over jobs that never ran.

**What is NOT established, and what an earlier revision of this file wrongly claimed:** that
force-push is the discriminator. It looked that way after three amend-pushes produced nothing and a
normal push produced Tekton — but a later rebase-and-force-push produced Tekton too. So the shape of
the push does not explain it, and whatever does is still unidentified. **Do not plan around a rule
here; measure the SHA you actually have.**

### The part that will fool you

After that normal push, `gh pr checks` reported:

```
CI Checks Summary:
  [ok] Passed: 2
  [FAIL] Failed: 0
```

**Two passed, zero failed, and 13 checks that never ran.** Nothing in that output is false and
nothing in it is missing-looking. Earlier the same command on the same PR said `no checks reported`
while four passing runs existed against an older commit. It answers about what it found, never about
what should have been there.

### What to do

- **Count, don't skim.** A healthy internal PR here carries **5 `Lint` check-runs plus 2 Tekton statuses**
  at head, and more checks from other workflows (see above). `Passed: 2` is not a pass.
- **Check both mechanisms by SHA**, because one can be present while the other is absent:

```bash
sha=$(gh pr view <pr> --json headRefOid -q .headRefOid)
gh api repos/<owner>/<repo>/commits/$sha/status     -q '.state + " " + ([.statuses[]?.context]|join(","))'
gh api repos/<owner>/<repo>/commits/$sha/check-runs -q '.total_count'
```

- **After a force-push, expect no Tekton status.** Push a real commit instead; this repo
  squash-merges, so it never reaches `main`'s history.
- For an internal PR targeting `main`, `tekton / typecheck` is the **authoritative** typecheck — the
  Actions typecheck job deliberately skips that case (see the header of `.github/workflows/lint.yml`).
  So Tekton present + Actions absent still leaves Lint, the schema drift gate and the submodule pin
  guard unrun.

> The workflow file already warns about the general form of this, about a different question:
> *"Both were reasoning from the workflow's CONFIGURATION, which says nothing about whether the job
> RUNS."* Everything above is the same lesson, arrived at from the other direction.
