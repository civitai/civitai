# Shared-module mocks: running the unit suite without per-file isolation

**Status:** design + pilot. The system described here exists; the migration does not.

The unit suite spends ~81% of its worker-time importing modules. `vitest --no-isolate`
collapses that (2266 worker-seconds to 229 at 8 workers) because each worker builds the
module graph once instead of once per test file. It also breaks ~1,500 tests. This
document is how to get the first without the second.

## The mechanism, precisely

The one-line version — "`vi.mock` is per file, module instances are per worker" — is
right but under-specified, and the missing detail decides the design. Measured with a
two-file probe (`--no-isolate --max-workers=1`):

**A test file that does not mock a module still gets the real module.** The poisoning is
not direct. A file with no `vi.mock('./target')` imports the genuine `./target`, even
after another file in the same worker mocked it.

**The damage travels through shared NON-test modules.** Any ordinary source module that
imports a mocked module — `~/server/redis/fail-open-log` importing `safeError` from
`~/server/logging/client`, say — is itself cached per worker. It captures its import
bindings once, at its first evaluation, in whatever mock context that first evaluation
happened to occur. Every later file reuses that cached module, still pointing at the
first file's mock object.

The probe reproduces the exact error from the real suite:

```
Error: [vitest] No "beta" export is defined on the "./target" mock.
 ❯ useBeta consumer.ts:11:17
 ❯ 2-victim.test.ts:11:12
```

`2-victim.test.ts` contains no `vi.mock` at all. It failed because `consumer.ts` was
first evaluated while `1-poisoner.test.ts`'s partial mock was installed.

Three consequences follow, and they are the whole specification:

1. **The mocked shape must be complete**, because a consumer may reach any export.
2. **Function identities must be stable for the worker's lifetime**, because consumers
   captured those bindings and will never re-read them. Behaviour has to be swapped by
   mutating a function, never by replacing it.
3. **Per-file state must be reset between files**, because the object outlives the file.
   This includes spy call counts, which is the `expected "X" to be called 2 times`
   failure class.

**The damage has a silent form.** When the poisoned import is reached at module scope rather
than inside a test, the file throws while being imported and collects ZERO tests. The failure
count does not rise, the summary line does not mention it, and the run reads as green while
those tests simply did not happen — measured at nine files and 152 tests on the 90-file
yardstick subset. So the success criterion for any run under `--no-isolate` is a per-file
collected COUNT diffed against an isolated control, never a colour. Same shape as the repo's
existing trap where a missing `event-engine-common` submodule makes
`blocks.router.workflow.test.ts` collect 0 and the run still passes.

`setupFiles` re-run per test file under `--no-isolate` — verified in the same probe
(`setup run #1`, `setup run #2`, same pid, same shared-module instance). That is the
reset hook, and it is why this is tractable at all.

## The shape

One canonical mock module per shared specifier. It is imported by the global setup file,
which registers it for every test file and resets it between them. A test file never
mocks these specifiers itself; it only declares behaviour.

```
src/__tests__/mocks/
  hybrid.ts        the auto-vivifying callable-proxy primitive
  db.mock.ts       ~/server/db/client
  redis.mock.ts    ~/server/redis/client
  logging.mock.ts  ~/server/logging/client
  index.ts         resetSharedMocks()
```

`src/__tests__/setup.ts` gains:

```ts
import { dbMock } from './mocks/db.mock';
import { resetSharedMocks } from './mocks';

vi.mock('~/server/db/client', () => dbMock);
resetSharedMocks();
```

### 🔴 Spread the package, never `importOriginal` of a shim

`~/server/db/client` and `~/server/redis/client` are shims: they re-export their package
wholesale *and* construct real clients at module scope. Registering them with an
`importOriginal` spread evaluates the shim, which forces real Prisma/Redis construction into
**every** test file — where before, only files without their own db mock paid it.

That failed in the worst available shape. A file whose own `@prisma/client` mock omitted
`PrismaClient` died during module evaluation, so it collected **zero tests**: the failure
count stayed at 0 and the run read as green.

The package re-exports are all the spread was ever protecting, so spread the package:

```ts
vi.mock('~/server/db/client', async () => ({
  ...(await import('@civitai/db/client')),
  dbRead: dbMock.dbRead,
  dbWrite: dbMock.dbWrite,
}));
```

Same exports, nothing constructed. This removes the precondition rather than enumerating the
files that trip it — a file no longer needs its own db mock to be protected. Pinned by a test
asserting neither shim's `globalThis` client cache is populated, since an absent global is
direct evidence the module body never ran.

### The primitive: a hybrid callable proxy

Prisma's surface is roughly 60 models times 15 methods; Redis has a few hundred commands.
Hand-listing either is how the current mocks got partial in the first place. Instead one
primitive covers all three modules: a node that is simultaneously a `vi.fn()` and a proxy
that vivifies child nodes on property access.

- Property access that resolves to a real `vi.fn` member (`mockResolvedValue`, `mock`,
  `mockReset`, …) hits the function.
- Any other string property returns a **cached** child node — same object every time, so
  `dbMock.dbRead.image.findMany` is one stable identity forever.
- `then`, `catch`, `finally` and unknown symbols return `undefined`, so a node is never
  mistaken for a thenable and `await`ing one cannot hang.

This gives `dbRead.image.findMany(...)`, `dbRead.$queryRaw(...)` and
`redis.packed.get(...)` without enumerating anything.

**Known collision:** a model or command literally named after a `vi.fn` member
(`name`, `call`, `bind`, `length`, `mock*`) resolves to the function's own member instead
of a child node. None of the current Prisma models or Redis wrappers hit this. The escape
hatch is `mockNode('dbRead.call.findMany')`, which addresses a node by path and bypasses
property lookup.

### Reset

`resetSharedMocks()` calls `mockReset()` on every vivified node, then re-applies that
node's registered default. It runs once per test file, from the setup file, before the
test module is imported. Defaults exist so that an unmigrated code path reaching an
undeclared method gets a plausible empty answer rather than `undefined.map is not a
function`:

| path shape | default |
|---|---|
| `findMany`, `findManyAndCount` | `[]` |
| `findUnique`, `findFirst` | `null` |
| `count` | `0` |
| `$queryRaw`, `$queryRawUnsafe` | `[]` |
| `$executeRaw`, `$executeRawUnsafe` | `0` |
| `$transaction` | runs the callback with the client it was reached through (`dbRead.$transaction` → `dbRead`), or `Promise.all` for an array |
| everything else | `undefined` |

Defaults are deliberately conservative. A test that cares about a return value must say
so; the defaults only stop an unrelated code path from throwing.

## What a call site looks like

**Before** (`src/__tests__/pages/api/download/vault-blocklist.test.ts`):

```ts
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockVaultItemFindUnique = vi.hoisted(() => vi.fn());

vi.mock('~/server/db/client', () => ({
  dbRead: {
    keyValue: { findUnique: mockFindUnique },
    vaultItem: { findUnique: mockVaultItemFindUnique },
    modelVersion: { findUnique: mockModelVersionFindUnique },
  },
  dbWrite: { keyValue: { findUnique: mockFindUnique } },
}));

beforeEach(() => {
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue({ value: ['1'] });
});
```

**After**:

```ts
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockFindUnique = dbMock.dbRead.keyValue.findUnique;
const mockVaultItemFindUnique = dbMock.dbRead.vaultItem.findUnique;

beforeEach(() => {
  mockFindUnique.mockResolvedValue({ value: ['1'] });
});
```

The `vi.mock` call and the `vi.hoisted` wrappers both go away. The local `const`s stay,
so the body of the test file needs no edits at all — which is what makes the migration
mechanical. The `mockReset()` in `beforeEach` also goes away, because the setup file
already reset everything before this file was imported.

One real change of meaning: `dbRead` and `dbWrite` were often aliased to the *same* mock
object, so a `dbWrite` call satisfied a `dbRead` assertion. They are now distinct. A file
that relied on the aliasing has to name the client it actually exercises — that is a
fixture collision being corrected, not a regression.

## Migration is all-or-nothing per specifier

A single unmigrated file that still calls `vi.mock('~/server/db/client', …)` re-poisons
every consumer module in its worker, and which files it takes down depends on sharding.
So a specifier is only fixed when its last call site is converted — 441 files for
`~/server/db/client`, 200 for logging, 198 for redis.

That is enforced, not remembered: `no-direct-shared-module-mock` fails when a test file
mocks a canonical specifier, carrying an explicit allowlist of the files not yet
converted. The allowlist only ever shrinks, and its length is the migration's progress
bar.

**A green pilot run therefore proves the mechanism, not the suite.** Converted files are
run together, without unconverted ones, at two worker counts. Mixing them measures the
residual, which is a different question — measured: the same 174 files went from 404
failures to 290 with 83 of them migrated, and the fully-migrated 83 alone came in at 11.

## Measured result

83 files, migrated for all three specifiers, against the same files isolated at 4 workers:

| run | files | tests | failed | zero-test files | wall |
|---|---|---|---|---|---|
| isolated, 4 workers (control) | 83 | 856 | 0 | 0 | 62.6s |
| `--no-isolate`, 4 workers | 83 | 846 | 11 | 1 | 22.9s |
| `--no-isolate`, 12 workers | 83 | 853 | 1 | 1 | 18.8s |

The residual failures are not mock shape. They are production modules holding state at module
scope — `eventloop-longtask.ts` registers its metrics into a real prom registry on import, so
under `--no-isolate` the first file to import it in a worker takes the registration and every
later file sees an empty registry. That belongs with `no-module-scope-cache`. The one
zero-collection file dies on `~/server/services/image.service`, which is out of scope here.

Registering the canonical mocks is inert under isolation: the same files isolated at 4 workers
report 0 failures.

## Measuring

The yardstick is `node scripts/test-perf/bench.mjs --label <name> --workers <n>`, a fixed
90-file subset, with `--no-isolate` passed through. Every claim needs two worker counts
because the failing set is order-dependent — 1574 failures at 8 workers against 1161 at
31, same code, same flag.

Do not read a suite result through `| tail` or `| grep`; that reports the pipe's exit
code. Redirect to a file and read the file.

🔴 **Never run two vitest runs in one worktree — the second one's result is not evidence.**

A targeted run and a full suite sharing a checkout produce assertion failures in the targeted
run that the code does not explain. Measured on one frozen SHA, five files, identical bytes on
disk for every run: **10/10 green** with nothing else in the tree, **1/5 red** with a full suite
running concurrently in the same worktree, and earlier the same day 5/10 and 4/5 red under that
condition. A control rules out load as the cause: 6/6 green under 24 spinning CPU processes with
no rival vitest.

The failure reads as a test bug, which is what makes it expensive. The symptom is that a `dbRead`
lookup the test configured returns the canonical mock's **empty default** instead — so the code
under test resolves nothing, a guard finds no owner, and an assertion that something is refused
fails as "resolved instead of rejecting". It is not a consumed `…Once` queue: it reproduces on
plain `mockResolvedValue` too. The mechanism is unproven; the shared `node_modules/.vite` cache
is the obvious suspect and has not been demonstrated. CI runs one suite at a time, so this is a
local hazard.

Two rules follow. Anyone's flakiness number measured in a shared worktree — including a green one
— says nothing, so re-measure alone before believing it. And before attributing a red run to the
diff, check whether anything else was running in that checkout: this condition sent two separate
diagnoses the wrong way in one afternoon, once at a test file and once at run contention, and a
tree that moves underneath a probe will do the same.

## Not covered here

`~/server/services/buzz.service` (98 sites) and `~/server/services/image.service` (88) lead
the next tier. The infra clients above are uniform enough for one auto-vivifying primitive; a
service module has a hand-written surface where the right canonical mock is a hand-written
stub, so it is a different piece of work. (`~/env/server` has since been done — it needed a
value table rather than a call surface; see the two-bucket rule in the migration doc.)

🔴 **The PENDING list in `guarded-specifiers.ts` is a floor, not an inventory.** It was
assembled from the most-mocked specifiers in a static scan, and specifiers keep arriving from
the other direction — as failures in a `--no-isolate` run of files already residual-clean for
everything listed. `~/server/flipt/client` arrived that way. `~/server/middleware/block-scope.middleware`
(27 files) is a live candidate found the same way, and is deliberately not added without
someone verifying the mechanism first.

So the remaining work is **discovered rather than known**, and any estimate built on the
current count is a lower bound. The method for finding the next one is the same each time:
migrate a set clean for everything listed, run it under `--no-isolate`, and read what still
fails.

**The list was built from repo-wide mock counts, and that is why it misses what it misses.**
Two directories fail for different reasons:

| | routers (27 files) | services (195 files) |
|---|---|---|
| distinct specifiers needed | 33 | 101 |
| not on the PENDING list | 28 | 88 |
| median shared per pair | 10 | 1 |
| pairs sharing nothing | 0 (0%) | 6,149 (32.5%) |

Services is a **fan-in** problem — a few specifiers reached by very many files — and the
PENDING list covers it well: every high-fan-in specifier is on it, and the first undiscovered
one ranks 12th. Routers is a **clique**: its colliding specifiers are locally dense and
repo-wide rare, so a count built from repo-wide frequency cannot see them.

So to find the missing ones, build the **per-pair shared-specifier graph for the directory
you are working on** rather than sorting a repo-wide count. The two directories need
different searches, not more of the same one.

💡 **Untested, and the highest-value idea nobody has tried:** a third of services pairs share
*no* specifier at all. A worker assignment that groups non-overlapping files could make much
of that suite clean under `isolate: false` without canonicalising anything. It is statically
evaluable from the same graph, before anyone writes code.

**The unit of work is the CLUSTER of specifiers a set of files shares, not one specifier.**
Canonicalising `block-scope.middleware` took one pair from 13 failures to 7, and the
remaining 7 were a different class — so that pair shares at least one more poisoning
specifier that nobody has named yet. 13 → 7 is the dangerous shape: it reads as progress and
is not completion. A set is done when its `--no-isolate` failures reach zero, not when the
specifier you were working on stops appearing.
