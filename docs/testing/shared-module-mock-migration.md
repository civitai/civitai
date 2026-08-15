# Migrating a test file onto the canonical shared mocks

The mechanism and the design are in [shared-module-mocks.md](./shared-module-mocks.md). This
is the recipe: what to run, what to do by hand, and how to know you are done.

Scope: `~/server/db/client`, `~/server/redis/client`, `~/server/logging/client`.

## 1. Run the codemod

```bash
node scripts/test-perf/codemod-shared-mocks.mjs --dry --report .test-perf/codemod-report.json
node scripts/test-perf/codemod-shared-mocks.mjs --write <file>...
node scripts/test-perf/codemod-shared-mocks.mjs --write --list <file-of-paths>   # Windows: avoids the 8191-char command line
```

🔴 **Always `--write` through a `--list` of files you own.** A bare `--write` converts every
convertible file in the repo, which is how one agent silently rewrote 53 files belonging to
another's slice. `--dry` is safe repo-wide; it only reads.

It converts only shapes it can prove equivalent, and a file is either fully converted for a
specifier or untouched — never partly, because a leftover `vi.mock` on a canonical specifier
re-poisons the whole worker. Every refusal is reported with a reason.

What it handles today:

- `vi.mock('…', () => ({ dbRead: { model: { findMany: localSpy } } }))`
- the `importOriginal` spread, in both the concise and block-body spellings
- `const { a, b } = vi.hoisted(() => ({ a: vi.fn(), b: vi.fn() }))` — removes just the entries
  it converts and leaves the rest of the hoisted object for other mocks
- a whole client built as an object literal of spies, `mockDbRead: { $queryRaw: vi.fn(),
  collection: { findFirstOrThrow: vi.fn() } }`, collapsed to `const mockDbRead =
  dbMock.dbRead` — binding the root makes every leaf vivify at the path the literal named
- `vi.hoisted` with a BLOCK body whose returned property names a local, resolving the
  identifier to its literal; the local is removed too, but only when the block reads it
  exactly once, so a `make()` helper shared by two clients is left alone
- hand-written `REDIS_KEYS` / `REDIS_SYS_KEYS`, deep-compared against the real tables
- inline spies that restate the canonical default (`findUnique: vi.fn(async () => null)`)
- pure passthrough wrappers (`findMany: (...args) => localFn(...args)`), which exist only so a
  factory can reach a hoisted local and have no purpose once the factory is gone

A leaf carrying real behaviour is always refused rather than dropped. That is the line the
codemod holds everywhere: it converts what it can prove equivalent, and reports the rest.

## 2. Work through the refusals

Ordered by how often they occur.

### `factory declares an export the canonical mock does not own: REDIS_KEYS`

The factory hand-writes a subset of a real constant next to the client:

```ts
vi.mock('~/server/redis/client', () => ({
  redis: { packed: { get: vi.fn() } },
  REDIS_KEYS: { CACHES: { PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response' } },
}));
```

The canonical registration spreads the original, so deleting the hand-written copy gives the
test the REAL constant. The codemod does this comparison for you: it static-parses
`REDIS_KEYS_UNPREFIXED` / `REDIS_SYS_KEYS` out of `packages/civitai-redis/src/client.ts`,
drops the literal when every leaf matches, and refuses when one does not — printing the
divergence under `CONSTANTS THAT DRIFTED FROM THE REAL VALUE`.

42 files diverge, across 73 leaves. Some are placeholders (`"rl"`, `"kill"`); others read as
real and are wrong — `CACHE_LOCKS` as `"caches:lock"` against a real `"cache-lock"`,
`TRPC.LIMIT.BASE` as `"trpc:rate-limit"` against `"packed:trpc:limit"`, a
`system:`-prefixed sys key written without the prefix. None are live bugs, because a test
asserting against its own copy uses the same wrong string on both sides — which is exactly
why nothing in the repo would ever surface them.

🔴 **Expect redness when the real constant is swapped in, and do not "fix" it by restoring
the hand-written copy.** A test that goes red was hardcoding an expectation string against
its own fixture instead of asserting behaviour. That redness is the finding.

⚠️ **And expect most of them NOT to go red, which is the worse case.** In one slice, nine
invented constants were replaced and none produced a failure — no affected test named them
outside its own factory, so both sides of any comparison were the fixture's invention. A
drifted constant nothing asserts on is invisible in both directions: it cannot fail, and it
cannot be reviewed. Six of those nine were `new-order` keys whose fixture name was a
*plausible* variant of the real one (`new-order:sanity-check-failures` against a real
`new-order:sanity-failures`), which is precisely how they survive a reading. The only thing
that surfaces them is swapping the real value in — so log what the codemod reports as
drifted, even when the suite stays green.

### `local "mockDb" aliases dbMock.dbRead and dbMock.dbWrite`

One spy served both clients, so a `dbWrite` call satisfied a `dbRead` assertion. Split it and
name the client the code actually exercises. Expect some of these to go red — that is the
collision surfacing, not a regression. Do not alias them back.

### `hoisted entry is not a bare vi.fn()` / `no module-scope declaration found`

A hand-built client factory, usually with a `make()` helper:

```ts
const { mockRead, mockWrite } = vi.hoisted(() => {
  const make = () => ({ appListing: { findUnique: vi.fn(async () => null) }, … });
  return { mockRead: make(), mockWrite: make() };
});
vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
```

By hand: delete the `vi.hoisted` and the `vi.mock`, then

```ts
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;
```

The rest of the file needs no edits. Read the old `make()` and keep only the behaviours that
are NOT canonical defaults — `create: async (args) => args.data`, `updateMany: async () => ({
count: 1 })` and the like — as explicit `mockImplementation` calls in the file's `beforeEach`.
`findUnique → null`, `findMany → []`, `count → 0` are already the defaults; restating them is
noise.

### `inline behaviour at …`

A behaviour the canonical default does not cover. Keep it, as a `mockResolvedValue` /
`mockImplementation` on the canonical node in `beforeEach`.

## 2b. `~/env/server` has a second bucket the others do not

🔴 **A per-file override cannot affect a value read at MODULE scope.** With `isolate: false`
the module under test is evaluated once per worker, so only the file that happened to trigger
that evaluation had its overrides visible. Everyone after it reads whatever was in place then.

This is **not** a shortcoming of the canonical mock. A per-file `vi.mock('~/env/server')`
factory has the identical problem, because it also runs once per worker. Do not try to "fix"
it by going back to per-file mocks.

So env splits in two:

| when the value is read | where it goes |
|---|---|
| at module scope (`const host = new URL(env.S3_UPLOAD_ENDPOINT)`, `pLimit(env.X)`) | `TEST_ENV_DEFAULTS` in `env.mock.ts` — worker-level, set before anything imports |
| at call time (inside a function the test invokes) | `setEnv({ … })` in the test file — per-file, reset between files |

Worked example: the three `clickhouse/__tests__/tracker.*.test.ts` files each carried an
identical `vi.mock('~/env/server')` supplying `CLICKHOUSE_TRACKER_URL`, which
`clickhouse/client.ts` reads at module scope. Moving that one string into the defaults and
deleting all three per-file mocks cleared 11 failures.

⚠️ Tests reach for `Object.defineProperty(env, 'FLAG', …)` to flip a single variable. A proxy
whose reported descriptor disagrees with what `defineProperty` then writes throws
`TypeError: Cannot redefine property` on the **second** call — surfacing as a dozen unrelated
failures in one file, with a symptom that points nowhere near the cause. The canonical env
implements `defineProperty` / `set` / `deleteProperty` / `getOwnPropertyDescriptor`
consistently; keep it that way if you extend it.

## 3. Fix the two assertion shapes that stop working

**Absence assertions.** A test may prove a code path by the fixture LACKING a method:

```ts
expect((db.dbRead.appBlockPublishRequest as Record<string, unknown>).findFirst).toBeUndefined();
```

The canonical mock vivifies every method, so absence is no longer observable. Rewrite as the
behavioural claim:

```ts
expect(dbMock.dbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
```

Stronger, not weaker: it still fails if the read is routed to the replica, including after
another file has populated that method. Worked example in
`src/server/jobs/__tests__/purge-review-snapshots.test.ts`.

**Redundant `mockReset()` in `beforeEach`.** Harmless, but the global setup already reset
every node before the file was imported. Delete it when you are in the file anyway; note that
`mockReset()` also clears the canonical DEFAULT, so a test relying on `findMany → []` after
its own reset must set the value itself.

## 4. Verify — a count, never a colour

Under `--no-isolate` a file whose module scope throws collects ZERO tests. The failure count
does not rise and the run can read as green while the tests simply are not there. So:

```bash
node scripts/test-perf/run-pilot.mjs --label mine-iso-4   --workers 4  --list <list>
node scripts/test-perf/run-pilot.mjs --label mine-noiso-4 --workers 4  --no-isolate --list <list>
node scripts/test-perf/compare-runs.mjs mine-iso-4 mine-noiso-4
```

`compare-runs.mjs` diffs per-file collected counts and prints count regressions before
failures; it exits non-zero if any file collected fewer tests, even with zero failures.

Two more rules, both learned the hard way on this box:

- **Verify at two worker counts.** The failing set is order-dependent — 1574 failures at 8
  workers against 1161 at 31, same code, same flag. A green run at one width is not evidence.
- **Never read a suite result through `| tail` or `| grep`.** You get the pipe's exit code.
  Redirect to a file, then read the file.

Before declaring a set migrated, confirm nothing in it still mocks a canonical specifier:

```bash
node scripts/test-perf/residual-mocks.mjs <list>
```

A single hold-out freezes its mock shape into every consumer module in its worker, so a
partially-migrated set measures the hold-outs rather than the system. Measured: the same 174
files went from 404 failures to 290 with 83 of them migrated, and the fully-clean 83 alone
came in at 11.

## 5. Update the allowlist

```bash
node scripts/test-perf/gen-mock-allowlist.mjs
```

🔴 **The allowlist is derived state. Regenerate it after any merge that touches a test
file.** Resolving a conflict by taking both sides is usually right, but if one side deleted a
direct mock the file is now migrated and its allowlist entry is stale — which fails the
guard's second direction. That has already happened once, on an integration branch, and the
guard was the only failure in a 16,806-test run.

Writes `src/__tests__/mocks/direct-mock-allowlist.json`, and REFUSES to grow — a run that
would add entries exits non-zero and names them, because a growing list means a new direct
mock was added, which is what the guard exists to stop.
`src/server/services/__tests__/no-direct-shared-module-mock.test.ts` also fails on entries
that no longer mock anything, so the list cannot be padded. Its length is the migration's
remaining work.

## The flip gate — a whole-suite collected-count diff, immediately before flipping

🔴 **Blocking prerequisite, not a recommendation.** `isolate: false` does not ship until this
passes on the exact tree that ships.

```bash
# same window, back to back
<whole unit suite, migration branch>   --label flip-candidate
<whole unit suite, main control>       --label flip-control
node scripts/test-perf/compare-runs.mjs flip-control flip-candidate
```

Pass conditions, all of them:

- **zero files collected fewer tests** than the control;
- **every file the branch ADDS collects at least one test**;
- **the total matches exactly** — not "no new failures", not "no regressions", an equal count;
- run **whole-suite**, not per slice;
- run **immediately before the flip**, not once during the migration.

**The added-file condition exists because the first one has a hole**, and the hole was found by
running the gate rather than by reasoning about it. A file the branch adds has nothing on the
control to lose against, so it can collect **zero** tests and diff perfectly clean. That is how
this project's own migration guard shipped inert: it threw during collection in every
full-suite run, contributed no tests, and passed whenever it was invoked as a named file —
which is how it was checked all day.

The last two conditions are the point, and each has a reason.

**Whole-suite, because per-slice verification is sound and insufficient at the same time.**
Every slice owner diffing per-file collected counts over their own files is correct practice
and it still leaves a gap: a file nobody owns can collect zero and no owner's control covers
it. That is not hypothetical. The canonical mocks were registered with an `importOriginal`
spread that made one file die at module scope and contribute nothing; the 120-file pilot was
verified by per-file collected counts and could not have caught it, because the affected file
was outside the set. It was found by someone taking a control run on a *different* slice
before converting anything. The failure was not in anyone's work — it was in the gap between
everyone's work.

**Immediately before, because the property is only true of a specific tree.** A clean diff
during the migration says nothing about the tree three hundred conversions later. This is a
gate on what ships, not a milestone.

**It is cheap.** The whole-suite integration run on 2026-08-15 was 1069 files / 16806 tests
with 0 zero-collect files, in about four minutes. The check has already been demonstrated to
work at full size; it is a run, not a project.

### Why a summary line cannot satisfy this

Under `--no-isolate` a file whose module scope throws collects **zero** tests. The failure
count does not rise. The run reads as green. Every instance of this found during the
migration presented that way, and none of them looked like an error:

- a mock factory missing a `default` key under pre-bundling: **7 tests collected instead of
  106**, reported as 1 failure;
- the `importOriginal`-on-a-shim regression: **870 passed, 0 failed**, one file contributing
  nothing;
- a missing `event-engine-common` submodule (pre-existing, documented in CLAUDE.md): a whole
  suite collecting 0 and still reading as a pass.

`compare-runs.mjs` exists because of this. It prints collected-count regressions **before**
failures and exits non-zero on a count regression even at zero failures.

### What the gate does NOT catch

Collected counts and `residual-mocks.mjs` detect **absence** — a file that lost its tests, a
specifier still mocked directly. Neither can see a test that still runs, still passes, and no
longer asserts anything real.

That is not hypothetical either. A codemod shape that dropped a factory's
`withSysReadDeadline` left two fail-open legs of `session-verifier.test.ts` passing while
asserting nothing, because the export the test had replaced with a spy was how it injected
the timeout. Another wrapped a whole client object as a leaf spy: every method vanished, the
calls returned empty instead of throwing, and a test asserting "nothing was deleted" would
have gone **green**. Both files converted with zero refusals, kept every test, and read clean
on residuals.

What caught them was **a control pair at assertion level, on a small set, run by someone who
did not write the tool**. Keep doing that alongside the gate; it is the half the gate cannot
do.

### And the general form, which outlives this migration

The two most valuable findings of the day each came from **someone else running a control on
another person's work** — not from the author's own verification, which was careful and
passed. A third correction went the other way, from the author to the reviewer. Three times
in one day, in both directions.

Authors verify what they changed. What nobody verifies is what changed *around* them. On work
split across several people, budget for at least one independent whole-suite control that
belongs to no slice.

## Open question: browser-mode tests

The guard DETECTS `.test.tsx` — a `.browser.test.tsx` adding a direct canonical mock would
otherwise be a class it structurally cannot observe, which is different from a class that
happens to be empty. The **codemod deliberately stays `.ts`**: converting a browser-mode file
would put it in a regime the canonical mocks have never been proven in, and a glob change
would make that look like a supported path.

Note the shape of what is missing, because it is narrower than "does browser mode work":
there are **zero** `.tsx` files mocking a canonical specifier today, so proving it requires
someone to *write* one, not to migrate one. It is a piece of work, not a verification.

## What this does not cover

`~/env/server` (114 sites), `~/server/services/buzz.service` (98),
`~/server/services/image.service` (88). The infra clients suit one auto-vivifying primitive; a
service module has a hand-written surface, so its canonical mock is a hand-written stub and
that is separate work.

Nor does it cover module-scope state in production code. A test asserting on an import-time
side effect — `eventloop-longtask.ts` registering metrics into a real prom registry — fails
under `--no-isolate` because the module is imported once per worker and the first file to
touch it takes the registration. That belongs with `no-module-scope-cache`, not here.
