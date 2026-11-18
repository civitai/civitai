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
dispatch and on a PR with the `full-ci` label; skipped, it is one check, not six shards). With the
`full-ci` label the `Unit tests` check expands to 6 shard check-runs (`Unit tests (1)` .. `(6)`), so
the PR run has 10 `Lint` check-runs, one of them (`Typecheck`) skipped. Adding the label leaves a
`Start full CI on label` check; the Lint and App suites runs it dispatches are NOT in the PR's
checks list (`gh pr checks` lists pull_request runs only). They are on the head commit's check-runs
and in the Actions tab, and that check's summary links them. Adding any other label leaves only a
skipped `Start full CI on label`. A PR that touches `apps/`, `packages/` or
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
marked ready (`gh pr ready <pr>`). To get a full verdict while it is still a draft, add the `full-ci`
label (`gh pr edit <pr> --add-label full-ci`) — only when the change touches code the unit or
component suites cover and the PR is near merge-ready, not on every PR. Adding it dispatches Lint (`only: all`, every job but
ESLint) and the app suites on the branch head straight away (`.github/workflows/full-ci.yml`;
nothing is dispatched when the PR's own run on that commit already started the unit shards; so a
PR opened WITH the label gets the app suites only if its paths reach them). The label stays on
until the full unit suite has passed once on the PR (on some commit, not necessarily the head):
lint.yml's `full-ci-done` job then removes it,
so later pushes run the normal PR suites (a cancelled or red unit run leaves it on); re-add it to
ask again. Same-repo PRs only; it does not lift the draft
gate on schema drift or tRPC parity. Or dispatch one on the branch, which
runs against the branch head rather than the merge with `main` — only a suite the PR's own run on
that commit did not run (read `gh pr checks <pr>`; with the label on, the full run may be a dispatched one that `gh pr checks` does not list, linked from the `Start full CI on label` check's summary):

```bash
gh workflow run lint.yml -R civitai/civitai --ref <branch> -f only=<job>   # typecheck, unit, packages, component, ...
gh workflow run apps.yml -R civitai/civitai --ref <branch>                 # app suites + app typecheck
```

**The unit suite's verdict for a commit on `main` is a commit status, not a push run.** A push to
`main` runs Lint without the `Unit tests` job. On the schedule in `.github/workflows/unit-batched.yml`
(its cron sets the cadence) a gate dispatches Lint with `only: unit` on `main` unless
`main`'s head already carries a POSTED `Unit tests (main batch)` verdict (`success` or `failure`).
The `Unit verified (main batch)` job posts it: `success` on HEAD when green. On red it re-runs the
failed files at HEAD; a pass there is a flake, posted as `success` on HEAD whose description reads
"Passed on re-run; flaky: <files>", plus a warning annotation. Otherwise it bisects first-parent
from the last green batch-verified commit and posts `failure` on the FIRST BAD commit, naming the
files, and on HEAD pointing at it, or only on HEAD when the bisect cannot isolate one. If that job
crashes or times out, its last step posts `error` on HEAD naming the step; a shard that never
reported, or a suite that did not finish, also posts `error`. The gate does not count `error` as a
verdict, so the next batch run re-verifies.
So read the status on the commit, and expect up to one interval plus a run before HEAD gets
one, and up to one interval plus a run plus the bisect for the status on the first bad commit. On
green only HEAD gets the status; it covers every earlier commit in the batch, which get none. To
verify now, dispatch the gate: `gh workflow run unit-batched.yml -R civitai/civitai` (it skips when
`main`'s head already has a verdict).

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

## CI cost measurements behind the workflow comments

The workflow comments state why each setting exists; the numbers that justified them live here,
dated, because they go stale. All from the GitHub Actions REST API for `civitai/civitai`; "run
wall" is a run's `run_started_at` to `updated_at` (it includes time queued for a runner), and
"job-minutes" sums each job's `started_at` to `completed_at`.

**`full-ci` dispatches that duplicated the PR run** (`.github/workflows/full-ci.yml`). For every
Lint run the label dispatcher started on a day, look up the pull_request Lint runs with the same
head SHA and check whether one has a `Unit tests (<n>)` job that was not skipped:

| day | dispatcher Lint runs | already covered by the PR run | duplicate job-minutes |
|---|---|---|---|
| 2026-11-12 | 122 | 102 (84%), started a median 28 s after it | ~9,100 |
| 2026-11-08 | 111 | 95 (86%) | ~8,300 |

Over 2026-10-30..11-13 the dispatcher started 1,388 Lint runs. A skipped `unit` job is listed as
plain `Unit tests`, and a run one as `Unit tests (<n>)`: no exception among the 1,931 `unit` jobs
(78 of them skipped) of the 552 Lint runs read for those two days.

**Suites a `full-ci` Lint dispatch ran that the PR run had passed** (`skip_passed`, the `passed`
job in lint.yml). The dispatcher's 19 Lint dispatches in the 24 h after the change above
(2026-11-14 04:03 to 11-15 04:03 UTC): 18 had a pull_request Lint run on the same head SHA. On 11
of them that run passed `Typecheck test files`, `Package unit tests` or the component shards
(on 9, all of them), but only one had finished when the dispatch started: the label is usually
added while the PR run is going. Replaying those job lists with a 10-minute wait for unfinished
PR jobs, polled every 30 s: ~219 dispatch job-minutes skipped (~22-24 per dispatch where every
suite passed, ~5 where only the two short ones did), against ~100 minutes the waiting job spends,
so ~119 job-minutes a day net. A non-draft PR run's green shard 1 does not cover geometry, which
is report-only there; the 24 h held one dispatch where geometry was red with the PR's shard green,
so the dispatch still runs geometry.

**Push runs on `main`: cancel vs queue** (`concurrency` in lint.yml, apps.yml, moderator-boot.yml).
Push runs on `main` over 2026-10-30..11-13, and a replay of the same push times with one run in
progress plus one pending (the newest replacing an older pending one), each run taking the
median duration of the window's completed push runs:

| workflow | push runs | cancelled | completed: cancel → queue (replayed) | run wall: actual → replayed |
|---|---|---|---|---|
| Lint | 1,549 | 1,185 (76%) | 364 → 873 | 241h → 248h |
| App suites | 1,502 | 999 (67%) | 503 → 978 | 191h → 205h |
| Moderator boot | 1,106 | 365 (33%) | 741 → 1,013 | 51h → 47h |

**App suites on push to `main`: queued, then filtered** (`paths:` on `push:` in apps.yml). After
the switch to queueing (2026-11-14 04:03 UTC) the push job's cost doubled, and not because the job
got slower. The App suites push runs, 2026-11-07..11-14 04:03 (785 runs) against 11-14 04:03..11-16
02:48 (215 runs), job times from every 4th run: finished runs went from 36 to 73 a day (the rest
cancelled; after the switch, only pending runs that cost nothing), and the median FINISHED job took
12.1 then 12.5 minutes. The p50 over all jobs moved 7.1 → 12.5 minutes only because the earlier
sample held cancelled jobs (median 3.2 minutes). Push now shares the PR filter. Of the pushes to
`main` in those two windows, 41% and 52% matched it. Replaying each window's push times through
the same queue at 12.5 minutes a run: ~71 → ~40 runs a day (~888 → ~497 job-minutes) and ~76 → ~46
(~943 → ~578).
