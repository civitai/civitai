# `pnpm typecheck` is structurally blind to every file under `src/**/__tests__/`

**Status: proposal. Nothing here is a mass fix.** Measured 2026-08-12 against `main` at
`f19574a9cb`, on Node 22.22.2 / TypeScript 5.9.2.

---

## 1. The gap, stated precisely

`tsconfig.json` carries one entry in `exclude`:

```
"src/**/__tests__/**"
```

`include` still lists `src`, so the *app* tree is checked normally — but no file under a
`__tests__/` directory ever enters the program. `pnpm typecheck` therefore does not report
type errors in those files leniently; it cannot see them at all. A deliberate type error
planted in such a file is reported as **0 errors, exit 0** (demonstrated in §6).

This is not a hypothetical. It has produced two distinct failures on one pull request:
nineteen real type errors accumulated unnoticed in a single new test file, and a first
attempt to measure the problem produced a false all-clear.

Two things it does *not* cover, worth stating so the scope is honest:

- **`tests/` and `test/` (top-level) are already checked.** They are in `include` and are not
  excluded. This is only about `src/**/__tests__/`.
- **242 test files under `src/` are already checked**, because they are `*.test.ts` files that
  do not live in a `__tests__/` directory. The exclusion is keyed on the *directory*, not on
  the filename.
- **`packages/*/src/**/__tests__/` is already checked too** — 68 such files are in the program
  today, because the exclude pattern is anchored at the repo-root `src/`, not applied
  everywhere.

So the repo currently has three populations of test file with two opposite guarantees, and
nothing tells an author which one a new file lands in. Whether your test is typechecked depends
on which directory you happened to put it in.

---

## 2. Why the exclusion exists

It is neither a performance decision nor an accident. It was a migration shortcut, and the
history is unambiguous.

The `exclude` entry has been touched exactly **once** in the repository's history:

```
1a7f89df98  2026-02-26  "fix broken automatic metadata parsing"
```

That commit's diff on `tsconfig.json` is the single added line. The same commit also adds
`src/utils/metadata/__tests__/exif-parser.test.ts` — **the first file the repository ever put
in a `src/**/__tests__/` directory.** The exclusion and the convention were born together, in
a commit whose subject is about neither.

So the reading is: an author adding the first test under a new directory convention hit
typecheck noise from it, silenced it in the config, and shipped the feature the commit was
actually about. There is no comment, no linked discussion, and no perf rationale anywhere in
the file. Nobody decided that test files should not be typechecked; the decision was never
framed as a decision at all.

That matters for the recommendation: there is no constituency to argue with, and nothing was
traded away for it. But it also means nothing has ever held the line, which is exactly what
§3 measures.

### The performance cost of removing it

Measured on this machine, `pnpm typecheck` (which sets `--max-old-space-size=8192` via
`scripts/typecheck.mjs`; a bare `tsc --noEmit` at the default heap aborts and prints **zero**
diagnostics, which reads as clean):

| program | cold (no `.tsbuildinfo`) | warm |
|---|---|---|
| `tsconfig.json` (today) | 112 s | 34 s |
| `tsconfig.tests.json` (tests included) | 176 s | 39 s |
| **cost of including tests** | **+64 s (+57%)** | **+5 s (+15%)** |

**Read these as an order of magnitude, not a constant.** All four were run back-to-back on one
developer machine (8 cores) that had other work on it; an earlier, differently-scheduled pair
put the cold base run at 334 s. That spread is contention, not the compiler. What survives it
is the shape: including ~1,300 more files costs tens of seconds on a cold run and a handful on
a warm one, on a check that already takes minutes. **Nothing in the history suggests the
exclusion was ever motivated by this cost, and nothing in these numbers would justify it.**
Re-measure on the CI runner before quoting a figure.

The program grows from 11,629 to 12,964 files, of which 938 are under a `__tests__/` directory.
`tsc --listFilesOnly` over the tests program takes 21 s — cheap enough to use as a standing
positive control (§5).

---

## 3. The real number, and its shape

The measurement config is `tsconfig.tests.json`: it `extends` the real `tsconfig.json` and
overrides `exclude` with the identical list **minus** the one test entry. Everything else —
`include`, `paths`, `compilerOptions` — is inherited.

That one-line-delta shape is deliberate and load-bearing. A hand-rolled narrowed program that
picks its own `include` silently drops `src/types/global.d.ts`; ambient names such as
`FileMetadata` then resolve to `TS2304: Cannot find name`, generics constrained by them
collapse, and the affected files report **fewer** errors than they really have. A measurement
tool whose failure mode is "the file you care about reports clean" is worse than no tool.

**Instrument validation.** Three checks, all of which passed:

1. `pnpm typecheck` on unmodified `main`: **0 errors, exit 0** — so the base program is clean
   and every error below is attributable to adding the test files, not to the config.
2. `TS2304` count in the tests run: **0**. The `global.d.ts` collapse described above is
   absent.
3. Of 801 diagnostics, **0** land outside a `__tests__/` directory. Adding the test files
   perturbs nothing in the app graph — the tests program is a strict superset of a clean
   program, so there is no artifact residue to subtract.

### The count

**801 type errors**, in **141 files**, out of **870** `.ts`/`.tsx` files under
`src/**/__tests__/`. Reproduced identically on three independent runs (two cold, one warm).

**729 of 870 test files — 83.8% — are already clean.**

### By error code

| code | count | what it is |
|---|---|---|
| TS2345 | 147 | argument not assignable — mostly hand-built fixtures/mocks narrower than the real parameter |
| TS2493 | 126 | tuple `[]` has no element at index 0 — reading `mock.calls[0]` off a mock typed with no args |
| TS2322 | 126 | type not assignable — literal fixtures missing fields of the type they are cast to |
| TS2352 | 102 | unsafe `as` conversion, usually from `undefined` |
| TS2339 | 58 | property does not exist — e.g. `.mock` on a union of `Mock \| (() => void)` |
| TS2556 | 50 | spread argument is not a tuple |
| TS2737 | 41 | **BigInt literals require target ≥ ES2020** — see the caveat below |
| TS18048 | 34 | possibly `undefined` |
| others | 117 | 20 further codes, none above 27 |

**Caveat on TS2737 (41 errors, 5.1%, across 15 files).** These are an artifact of the app
config's `"target": "ES2018"`, inherited by the measurement config. The test files run under
Vitest on Node 22, where `1n` is fine. They are *real* errors under the target the repository
declares, and the fix is a one-character change (`BigInt(1)`), but they are not test-logic
defects. Overriding `target` in `tsconfig.tests.json` would remove them — and would also
destroy the one-line-delta property that makes the measurement trustworthy, since changing
`target` changes `lib` and therefore the semantics of the whole program including app files.
**Recommendation: keep the one-line delta and treat these 41 as ordinary debt.** Read the
headline number as "801, of which ~41 are the ES2018 target".

### One error is a genuine runtime bug the exclusion is hiding

```
src/server/db/__tests__/kysely-prisma-parity.test.ts(5,29):
  error TS2307: Cannot find module 'kysely' or its corresponding type declarations.
```

`kysely` is not a dependency of this repository (only `prisma-kysely` is) and is not installed.
That import cannot resolve at runtime either, so this suite contributes zero tests — the exact
failure class already documented in the repo's own notes about suites that fail to *collect*
and therefore report "no tests" rather than a failure. The typecheck would have named it on the
day it landed.

### By area

| area | errors | dirty files |
|---|---|---|
| `src/server/services/` | 329 | 66 |
| `src/server/routers/` | 231 | 19 |
| `src/server/__tests__/` | 56 | 8 |
| `src/env/__tests__/` | 39 | 1 |
| `src/server/jobs/` | 30 | 7 |
| `src/server/rewards/` | 20 | 2 |
| remainder (10 areas) | 96 | 38 |

### Concentration — this is what decides whether a ratchet is viable

| | errors | share of 801 |
|---|---|---|
| top 1 file | 77 | 9.6% |
| top 5 files | 266 | 33.2% |
| top 10 files | 388 | 48.4% |
| top 20 files | 493 | 61.5% |
| top 50 files | 658 | 82.1% |

Heavily concentrated. The long tail is thin: 52 files have exactly one error, 89 have three or
fewer. **Fifty files carry four fifths of the debt**, and they are identifiable by name.

### 🔴 The finding that should change the decision: this debt is NOT legacy

Grouping the 141 dirty files by the date they were **first added**:

| month first added | dirty files | errors they contain |
|---|---|---|
| 2026-02 | 1 | 2 |
| 2026-03 | 1 | 1 |
| 2026-05 | 1 | 4 |
| **2026-06** | **39** | **316** |
| **2026-07** | **59** | **248** |
| **2026-08** (12 days) | **40** | **230** |

**138 of 141 dirty files, and 794 of 801 errors, are less than three months old.** For context,
the whole convention is new — 857 of the ~905 test files ever added under `src/**/__tests__/`
arrived in the same three months, and roughly 16% of them arrive dirty.

Twelve days into August the tree has taken on **40 new dirty files and 230 new errors**. This
is not a legacy sediment layer to be ratcheted down over time. It is an **active inflow of
roughly 19 errors and 3 dirty files per working day**, and it is accelerating with the test
corpus.

That reframes the problem. The value of a gate here is almost entirely in stopping the inflow;
the "legacy" it would grandfather is three months old and 82%-concentrated in fifty files.

---

## 4. Options, with the trade-offs stated

### A. A separate, non-blocking `pnpm typecheck:tests`

*What it is:* add the script, tell people to run it, report it in CI as a warning.

*Against:* this is, functionally, the status quo plus a script. The 801 errors accrued under a
regime where anyone could have run `tsc -p` with a modified exclude at any time. A report that
nobody must act on does not change an inflow of 19 errors/day. It costs the same compute as a
blocking gate and buys none of the enforcement.

*Verdict:* worth having as a local-development affordance, but it is not a fix. This proposal
deliberately does **not** add it: `pnpm typecheck -p tsconfig.tests.json` already works today
(the wrapper forwards its arguments to `tsc`), so the convenience alias can be one line of
`package.json` whenever someone wants it, and this pull request stays purely additive.

### B. Delete the exclusion and require green

*Against:* permanently red for as long as 801 errors take to fix. **A permanently-red gate is
worse than no gate: it trains everyone to click through, and it takes the credibility of the
other checks with it.**

*Verdict:* no. Not as a first move.

### C. Gate only the test files changed in the pull request

*Against:* two problems. First, it saves nothing: `tsc` is a whole-program checker, so the
entire program is built regardless and restricting the *report* to changed files does not
reduce the cost. Second, it is blind in the direction that matters most — a change to *app*
code that breaks an *unchanged* test file passes, which is precisely the coupling a typecheck
exists to catch.

*Verdict:* no.

### D. Fix the debt outright

*For:* 141 files, and fifty of them carry 82%. This is a real option, not a fantasy — it is
days of work, not months, and the concentration means it can be attacked in ranked order with
visible progress.

*Against:* on its own it does not hold. The measured inflow (~230 errors in the last twelve
days) would restore the debt in roughly five weeks. Fixing without gating buys five weeks.

*Verdict:* do it — **second**, behind a gate, and use §3's ranked file list to sequence it.

### E. ✅ Recommended: a per-file ratchet, then burn the top 50 down

A committed baseline of per-file error counts. The gate re-measures and blocks **only a
regression this change introduces**:

- a file with errors that is **not** in the baseline → **BLOCK**
- a baselined file whose count went **up** → **BLOCK**
- a baselined file whose count went **down**, is now clean, or is deleted → **pass**, and the
  run says so

Lowering a baseline entry is never required to merge. Raising one is possible only by editing a
committed JSON file inside the pull request, where a reviewer sees it in the diff.

This is the shape this repository already runs for schema drift
(`packages/civitai-db-schema/src/schema-drift/gate.ts`), for the same stated reason: the
detector reports what exists, the gate answers the narrower question of whether this change
made it worse. Reusing that shape means no new concept for reviewers to learn.

**Why a *per-file* count rather than a single total.** A repo-wide total lets a pull request
that fixes ten errors in an old file introduce ten new ones in a new file and pass. Per-file
counts make the two independent, which is the whole point given §3's finding that the inflow —
not the stock — is the problem.

**Stated trade-off — the honest cost.** Per-file counts are sensitive in a way a coarser gate
is not: tightening a type in app code can raise the error count in a legacy test file that the
pull request never opened, and the gate will block. The escape is to fix that file or re-run
`--write-baseline` in the same PR, both visible in review. This is a real friction cost, paid
in exchange for the gate being unable to absorb a new violation silently. Given that the top 50
files are the ones most likely to move this way, burning them down (option D) also buys the
friction down.

---

## 5. How it wires in, and what it does when it fires

### Wiring

The authoritative typecheck today is the in-cluster CI pipeline that runs `pnpm run typecheck`
and posts a commit status; the GitHub Actions `typecheck` job covers the two cases that
pipeline deliberately does not (fork pull requests, and pull requests not targeting `main`).

Two ways to wire the gate, in the order I would ship them:

1. **Stage one — add a second, parallel check.** A new CI step running
   `node scripts/ci/typecheck-tests-gate.mjs`, posting its own status alongside the existing
   typecheck. Costs one additional full `tsc` run. Zero risk to the existing check; if the gate
   turns out to be noisy it can be dropped without touching anything that works today.

2. **Stage two — subsume, once stage one is quiet.** The tests program is a strict superset of
   the app program (§3, validation check 3: zero errors outside `__tests__/` today). So one run
   of the gate can serve both checks: diagnostics **outside** `__tests__/` are the existing
   typecheck's verdict and block unconditionally; diagnostics **inside** go through the
   ratchet. Total CI cost then returns to a single `tsc` run — the marginal cost of covering
   test files becomes about +60 s on a cold checkout, not a whole second check.

   The proof-of-concept already separates the two populations and prints the outside-`__tests__`
   set on its own line rather than folding it in, so stage two is a wiring change, not a rewrite.

Either way, `pnpm typecheck` itself is untouched. No developer's existing command changes
behaviour, and `tsconfig.json` is not edited.

### Failure mode when someone adds a new test file

A pull request adding a test file with a type error gets a **blocking** check whose output
names the file, the error count, and how to reproduce:

```
================================================================
  TYPECHECK-TESTS GATE: BLOCKED
================================================================
  1 test file(s) have type errors and are NOT in the baseline:
    src/env/__tests__/server-schema-moderation-timeout.test.ts  (1)

  These are real type errors in test files. `pnpm typecheck` cannot see them
  because the root tsconfig excludes src/**/__tests__/**.

  Reproduce locally:
    pnpm typecheck -p tsconfig.tests.json
================================================================
```

There are exactly two ways past it: fix the error, or add the file to the baseline in the same
pull request — a diff a reviewer sees. There is no flag, no environment variable, and no
"warn-only" mode, because the whole failure this proposal addresses is a check that reported
success while a file went unexamined.

### Instrument validation, built into the gate

The characteristic failure of a gate like this is a confident zero, so the gate refuses to
produce a verdict until two controls pass:

- **Positive control.** `tsc --listFilesOnly` must show at least 400 files under a `__tests__/`
  directory in the program (measured: 938). A mistyped `-p`, a future edit to the
  exclude list, or a rename of the `__tests__` convention would otherwise yield "0 new errors"
  and pass — indistinguishable from a gate wired to nothing. Below the floor the gate exits 3
  ("cannot measure"), never 0.
- **A crash is not a clean run.** The gate runs through `scripts/typecheck.mjs`, which already
  distinguishes a V8 heap abort from a clean run (both emit zero diagnostics). If that wrapper
  reports a crash, the gate exits 3.

Exit codes: `0` pass · `1` regression (blocking) · `2` usage/baseline error · `3` the
environment could not run the check.

---

## 6. Proof of concept — three runs, with counts

Files: `scripts/ci/typecheck-tests-gate.mjs`, `scripts/ci/typecheck-tests-baseline.json`,
`tsconfig.tests.json`.

Counts below are `error TS` **lines counted from a captured log**, never an exit code — a
`tsc` OOM exits 134 with zero diagnostics and a missing binary exits 127, and both score as
"clean" to anything reading `rc == 0`. (Both were hit while producing this document: the first
measurement run of all returned `rc=127` — `corepack: not found` — and would have been recorded
as a clean typecheck by an exit-code reader.)

### (a) PASS on unmodified `main`

```
$ node scripts/ci/typecheck-tests-gate.mjs
typecheck-tests-gate: positive control OK — 938 test file(s) in the program.

typecheck-tests-gate: 801 error(s) across 141 file(s) (baseline: 801 across 141).
typecheck-tests-gate: PASS — no new or worsened test-file type errors.
gate exit=0
```

Counted: **801** `error TS` lines, **141** files, matching the committed baseline exactly.
The positive control confirms 938 test files were actually in the program — so the pass is a
statement about the test tree, not about an empty one.

### (b) FAIL with one planted type error in a previously-clean test file

The plant, in `src/env/__tests__/server-schema-moderation-timeout.test.ts` — a file with **0**
errors in the baseline:

```ts
const plantedNegativeControl: number = 'not a number';
```

**First, the gap itself, measured on that exact tree.** This is the whole reason the document
exists:

```
$ pnpm typecheck                       # the check that actually gates today
typecheck: OK — 0 type errors in 13s (heap cap 8192 MB).
root exit=0
root 'error TS' lines: 0
root mentions of the planted file: 0
```

`pnpm typecheck` does not merely tolerate the error — it announces **"OK — 0 type errors"**,
exits 0, and never names the file. Counted from the captured log: **0** `error TS` lines, **0**
occurrences of the filename.

**The gate, on the same tree:**

```
$ node scripts/ci/typecheck-tests-gate.mjs
typecheck-tests-gate: positive control OK — 938 test file(s) in the program.

typecheck-tests-gate: 802 error(s) across 142 file(s) (baseline: 801 across 141).

================================================================
  TYPECHECK-TESTS GATE: BLOCKED
================================================================
  1 test file(s) have type errors and are NOT in the baseline:
    src/env/__tests__/server-schema-moderation-timeout.test.ts  (1)

  These are real type errors in test files. `pnpm typecheck` cannot see them
  because the root tsconfig excludes src/**/__tests__/**.

  Reproduce locally:
    pnpm typecheck -p tsconfig.tests.json
================================================================
gate exit=1
```

Counted: **802** errors across **142** files — exactly one more of each than the baseline — and
the one new file is named. 801 → 802 is the smallest possible regression, and it is caught.

### (c) PASS again once reverted

```
$ git diff --name-only          # (empty — the plant is fully reverted)
$ node scripts/ci/typecheck-tests-gate.mjs
typecheck-tests-gate: positive control OK — 938 test file(s) in the program.

typecheck-tests-gate: 801 error(s) across 141 file(s) (baseline: 801 across 141).
typecheck-tests-gate: PASS — no new or worsened test-file type errors.
gate exit=0
```

Back to **801 / 141**. The gate is not stuck red, and its verdict tracks the tree.

**What the three runs establish, and what they do not.** They establish that the gate can go
red, that it goes red for the right reason (the planted file is named, and the delta is exactly
+1/+1), and that it returns green when the cause is removed — i.e. it is not a check wired to
nothing, and not one that is red regardless. They do **not** establish behaviour on a
*worsened baselined file* or on a baseline that has drifted; those paths are implemented and
readable but were not exercised here, and a unit suite around the pure comparison step is the
obvious follow-up before this is relied on.

---

## 7. What I would do next, in order

1. Merge the gate at stage-one wiring (parallel, blocking) with the baseline as measured.
2. Burn down the top 50 files (82% of the debt) in ranked order; each fix lowers the baseline
   and reduces the per-file-count friction described in §4E.
3. Move to stage-two wiring once the gate has been quiet for a couple of weeks, returning CI
   cost to a single `tsc` run.
4. Only then consider deleting the `exclude` line outright — at which point it is a no-op
   cleanup rather than a change of policy.

## 8. Things that argue against this proposal

Recorded rather than buried:

- **The 41 TS2737 BigInt errors are not test defects** (§3). Anyone reading "801" as 801 test
  bugs is reading it slightly wrong.
- **Per-file counts are noisier than a total** (§4E). This is a deliberate trade, and it will
  occasionally block a pull request that did not touch the file in question.
- **The gate costs a full `tsc` run until stage-two wiring lands.** On the cold-checkout path CI
  actually runs, that is roughly the 176 s measured here in additional wall time per pull
  request — not the +64 s marginal cost, which only arrives at stage two.
- **The three proof-of-concept runs do not cover every branch of the gate** (§6, closing note).
- **None of this covers the 242 `*.test.ts` files outside a `__tests__/` directory** — those are
  already checked, but the two-populations inconsistency in §1 remains. A follow-up worth
  considering is standardising the convention so the answer to "is my test file typechecked"
  does not depend on which directory it landed in.
