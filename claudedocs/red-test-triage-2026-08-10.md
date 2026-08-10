# Triage: the "16 pre-existing test failures on main"

**Measured 2026-08-10.** Baseline commit `a43e49a4ba` (`origin/main`, "5.0.2262"), plus a
second baseline at `2a2fe66428` — the tip of `main` on 2026-08-08, the day the ticket was
filed. Every run below was made in a clean throwaway worktree off the remote tip, with a
fresh `pnpm install --frozen-lockfile` and the `event-engine-common` submodule initialised
unless stated otherwise.

## Headline

**The 16 failures do not exist on `main`, and did not exist on `main` on the day they were
reported.** The full `unit` project is green at both commits, under three different Node
versions, and so are the `packages` and `apps` projects. All five suites the ticket names
by name pass, each collecting a non-zero number of tests.

The failures were real observations of a real problem — but the problem was in the
*environment the suite was run in*, not in the tests. A fresh `git worktree` does not check
out submodules and does not carry the repo's gitignored `.envrc`, and each of those omissions
produces a distinct block of false reds. That trap has been documented in prose in `CLAUDE.md`
since #3567 (2026-08-04) and was walked into anyway, four days later, by three agents in a row.

## Phase 1 — the measured baseline

Three numbers, not one, because the failure mode at issue moves between them.

| Run | Commit | Node | Failed FILES | Failed TESTS | Passed TESTS | Skipped | exit |
|---|---|---|---|---|---|---|---|
| unit, submodule **absent** | `a43e49a4ba` | 22.22.2 (flake) | **73** / 891 | **0** | 12,782 | 4 | 1 |
| unit, submodule present | `a43e49a4ba` | 22.22.2 (flake) | 0 / 891 | 0 | 13,753 | 1 | 0 |
| unit, submodule present | `a43e49a4ba` | 24.18.1 (`.nvmrc`/CI) | 0 / 891 | 0 | 13,753 | 1 | 1 † |
| unit, submodule present | `a43e49a4ba` | 26.5.0 (ambient) | 1 / 891 | **7** | 13,746 | 1 | 1 |
| unit, submodule present | `2a2fe66428` (2026-08-08) | 22.22.2 (flake) | 0 / 889 | 0 | 13,713 | 1 | 0 |
| `packages` | `a43e49a4ba` | 22.22.2 | 0 / 73 (2 skipped) | 0 | 1,002 | 4 | 0 |
| `apps` | `a43e49a4ba` | 22.22.2 | 0 / 53 | 0 | 507 | 0 | 0 |

† 0 failed tests but a non-zero exit — see "Finding 3".

The `component` (browser-mode) project was **not** run; it needs a Chromium whose revision
matches the repo's Playwright pin, which this host does not currently have. That is stated
as unmeasured, not as green.

### Collected-tests-per-failing-file, for the one red run

Of the 73 failing files in the submodule-absent run, **72 collected ZERO tests**. The 73rd
(`prisma-inconsistent-orphan-relations.test.ts`) collected 6 and skipped 3, and failed via an
unhandled rejection rather than an assertion.

That is the whole shape of the trap: 72 files that *fail* without *failing a test*. The run
reports **0 failed tests** and 12,782 passed. The green run reports 13,753 passed. So the
broken run silently removed **971 tests** while its failed-test count read zero. A reader
comparing failed-test counts sees "0 either way"; a reader comparing passed-test totals to a
remembered number sees a drop with nothing to attribute it to.

Root cause of all 73: `Cannot find module '../../../event-engine-common/...'` — the submodule
is not checked out by `git worktree add`. 58 of the 73 name it directly in their error; the
remainder are `vi.mock` factory errors cascading from the same unresolved import.

## Phase 2 — classification

Every suite the ticket names is **green and non-vacuous**. Each was mutation-tested: the thing
it guards was broken on purpose, and the guard was watched to go red **with its own specific
error message**, on an input no earlier check short-circuits.

| Suite | Kind | State on `main` | Verdict |
|---|---|---|---|
| `src/server/services/__tests__/no-wholesale-module-mock.test.ts` | quality guard (ESLint RuleTester, 97 tests) | green | **Keep. Not vacuous — proven.** |
| `src/server/middleware/__tests__/block-scope.normalize-endpoint.test.ts` | route-drift guard (27 tests) | green | **Keep. Not vacuous — proven.** |
| `src/server/services/blocks/__tests__/app-spend-tier-privilege.test.ts` | privilege-surface drift guard (9 tests) | green | **Keep. Not vacuous — proven.** |
| `src/server/services/comics/__tests__/orchestrator-chat.wait-unit.test.ts` | ledger drift guard (12 tests) | green | **Keep. Not vacuous — proven.** |
| `scripts/__tests__/typecheck.test.ts` | wrapper-behaviour guard (5 tests) | green | **Keep. Not vacuous — proven.** |

### Mutation evidence

| Guard | Mutation applied | Result |
|---|---|---|
| `no-wholesale-module-mock` | Reintroduced the historical **textual** check in `eslint-local-rules.js` — treat any factory whose source text contains `importOriginal` as safe | 97 → **29 failed / 68 passed**, `AssertionError: Should have 1 error but had 0: []`. The killed cases are exactly the laundering cases (unused `importOriginal` param, a comment mentioning it, the bare string `'importOriginal'` as a value). |
| route drift | Added `src/pages/api/v1/blocks/mutation-probe.ts` exporting `withBlockScope(...)` | 27 → **2 failed**: *"the allowlist is EXACTLY the static segments of the wrapped routes"* and *"pins the current set, so adding a route is a deliberate act"*, both diffing on the literal `"mutation-probe"`. |
| spend-tier privilege | Added `const __probe = { spendTier: 'premium' }` to `src/pages/api/v1/developer/block-manifests.ts` (a publisher-reachable module) | 9 → **3 failed**, incl. `AssertionError: src/pages/api/v1/developer/block-manifests.ts must not reference spendTier in code`. |
| wait-unit ledger | Added `src/server/services/comics/mutation-probe.ts` with `export const probeQuery = { wait: 60000 }` | 12 → **2 failed**: *"no statically-resolvable wait exceeds the seconds envelope"* and *"matches the known ledger of numeric wait sites"*, naming `server/services/comics/mutation-probe.ts:60000`. |
| typecheck wrapper | Moved the one-line crash verdict from stdout to stderr in `scripts/typecheck.mjs` | 5 → **3 failed**, `AssertionError: expected '' to contain 'TYPECHECK CRASHED'`. |

Every mutation was reverted and the five suites re-run together afterwards: **150 tests, all
passing**, tracked tree byte-clean.

### One scope correction to the ticket

The ticket says `block-scope.normalize-endpoint.test.ts` "is exactly the guard that would have
had an opinion about" the new `/api/testing/eventloop-stall` route added in #3752.

It would not have, and this is worth knowing rather than assuming. That guard's walk matches
only files whose default export is wrapped in `withBlockScope(...)`. `eventloop-stall.ts` is
not block-scoped, so the guard is correctly silent about it. It *is* live for the routes it
covers — the mutation above proves that — but it is a **block-scope allowlist** drift guard,
not a general new-route detector. No such general guard exists. If one is wanted, that is a
new piece of work, not a repair.

## Phase 3 — what actually produced the 16

Not reproduced exactly, and I will not claim otherwise. What *is* measured:

**Finding 1 — the submodule (this is the big one).** Detailed above: 73 files fail, 72 collect
zero tests, failed-test count reads 0, 971 tests vanish. An independent agent measuring a
baseline on this same commit on the same day reported **73 failed files / 12,782 passed / 4
skipped**, and 12 `pnpm typecheck` errors all from an un-checked-out `event-engine-common` —
byte-for-byte the same artifact, arrived at independently. Their baseline is not `main`'s state.

**Finding 2 — the missing `.envrc`.** `.envrc` is gitignored, so a fresh worktree silently gets
system Node instead of the flake's pinned version. Measured here: under the ambient **Node
26.5.0**, `hiddenBlocks.test.ts` fails **7** tests with `TypeError: Cannot read properties of
undefined (reading 'clear')` on `window.localStorage` under happy-dom. Under the flake's Node
22 and under Node 24, the same file passes. Running outside the flake also loses the Prisma
engine env: I measured **6** `PrismaClientInitializationError: could not locate the Query Engine
for runtime "linux-nixos"` unhandled rejections.

`CLAUDE.md` already records this exact pair from a previous encounter: *"system Node 26.5.0
against the flake's 22.22.2 produced 7 spurious `window.localStorage is undefined` failures
under happy-dom plus 8 Prisma `linux-nixos` engine errors — every one a false red."* **7 + 8 =
15**, against a reported 16. That is the closest match to the ticket's number that any
mechanism here produces, it is the mechanism the repo had already written down, and the two
halves are independently reproducible.

**Finding 3 — under CI's own Node, the unit suite exits non-zero with zero failing tests.**
At `a43e49a4ba` under Node 24.18.1 (what `.nvmrc` pins and what the CI job uses via
`node-version-file`), the run reports 891/891 files and 13,753 passed, **0 failed** — and then
`Errors 6 errors` and a non-zero exit, from Prisma-engine unhandled rejections. The CI `unit`
job carries `continue-on-error: true`, so this is invisible there today. It will start
mattering the moment that job is flipped to blocking, which its own comment says is the plan.
Flagged, not fixed — the fix is environment-shaped and overlaps PR #3779.

**Finding 4 — `git stash` was in the loop.** The ticket says the set "reproduces on a stashed
clean tree". `git stash` is repo-**global**: `refs/stash` lives in the common git dir and is
shared by every one of this clone's worktrees. Three agents stashing concurrently across a
shared clone are not each producing a clean tree; they are pushing and popping one shared
stack. That is consistent with three agents reporting an *identical* set from three different
branches, and it is a hazard worth retiring independently of this ticket. Stated as mechanism,
not as measurement — I did not reproduce it.

## What was changed

One file added: **`src/__tests__/submodules-checked-out.test.ts`**.

It converts Finding 1 from a silent subtraction into one legible red line. It reads the
submodule paths out of `.gitmodules` rather than hardcoding them, so a submodule added later is
covered without anyone remembering, and it asserts three specific entry points so a *partial*
checkout — which produces the identical vanish-without-failing symptom — is caught too. It
imports nothing from the submodule, because a guard that fails to load for the very reason it
exists to report is not a guard.

Controls run on it, both directions:

- **Green state:** 5 tests collected, 5 passed.
- **Negative control, empty gitlink directory:** 4 failed / 1 passed, `AssertionError:
  submodule "event-engine-common" is present but EMPTY — an uninitialised gitlink. Fix: git
  submodule update --init --recursive`.
- **Negative control, directory absent entirely:** 4 failed / 1 passed, `AssertionError:
  submodule "event-engine-common" is not checked out. …`.
- **Reachability:** in both broken states the file still **collected 5 tests** while 72 other
  files were collecting zero. It is visible precisely when everything else has gone quiet.
- **Vacuity control:** the `it.each` populations are derived, so an unparseable `.gitmodules`
  would generate zero cases and pass green. The first test pins `DECLARED.length > 0` and pins
  that `event-engine-common` is among them.

Nothing was deleted, disabled, skipped, or quarantined.

## Recommendations for the human — no guard deletions proposed

I am not recommending that any guard be deleted. All five are live, specific, and cheap
(150 tests, ~0.9s combined). The ticket's premise for deleting them — that they are red and
therefore inert — does not hold.

Three things are worth a decision, none of which I made:

1. **Close the ticket as "not reproducible on `main`; environment artifact"**, with Findings
   1–2 as the record. The instinct behind it was right; the target was wrong.
2. **Finding 3** — the unit suite exits non-zero on CI's own Node while reporting zero failed
   tests. Needs resolving before that job is flipped to blocking. Overlaps PR #3779; I did not
   touch it.
3. **Finding 4** — `git stash` in a 30-worktree shared clone. Independent of this ticket, and
   the most likely reason three agents agreed on a wrong answer.

## Reproducing any of this

```bash
CIVITAI=/path/to/civitai
WT=/tmp/civitai-baseline
git -C "$CIVITAI" fetch origin main
git -C "$CIVITAI" worktree add --detach "$WT" origin/main
git -C "$WT" submodule update --init --recursive     # ← the step that decides the answer
printf 'use flake\n' > "$WT/.envrc" && direnv allow "$WT"
(cd "$WT" && direnv exec . pnpm install --frozen-lockfile && direnv exec . pnpm run test:unit:run)
```

Read the **content**, not the exit code, and read all three numbers — failed files, failed
tests, passed tests. A run whose failed-test count is 0 is not necessarily a run that passed.
