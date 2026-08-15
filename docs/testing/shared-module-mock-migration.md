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

### Some env tests cannot be migrated, and that is a property of the flag not a gap in the mock

A boolean that tests set **both ways** at module scope — `IS_BUILD`, `IS_DATAPACKET` — cannot
be varied per file under `isolate: false` by any mechanism. The module reading it is
evaluated once per worker, so only the first file's value is ever visible. That is not a
shortcoming of the canonical env mock; a per-file `vi.mock` factory has the identical
problem, and so would any future one.

Those tests exist precisely to exercise build-vs-runtime and datapacket-vs-not behaviour, so
the options are to stop testing it through `env` — mock the consuming module's exported
result instead — or to leave those files isolated. **Treat them as a permanent exclusion, not
as remaining work**, and do not let an unmigrated count that includes them read as progress
still to be made.

### The env codemod, and the one thing it gets wrong

`node scripts/test-perf/codemod-env-mock.mjs --dry|--write` is the env transform. It sorts each
site into **drop** (every declared key already equals the canonical default), **setEnv**
(non-default values, none read at module scope) or **refuse**, and it decides "module scope" with
the TypeScript parser rather than by counting braces — two hand-rolled depth heuristics answered
that question on the same tree with 73 keys and 127, differing only in where the "is this brace a
function body" regex was anchored, and nothing in either output says which is lying.

🔴 **Its module-scope answer is unsound in BOTH directions, and only a run tells you which.** The
walk asks whether a read is *lexically inside a function*. The question that decides the migration
is whether the read is *reachable from module-scope execution*, and they differ by one hop:

```ts
// src/server/cloudflare/client.ts
const getClient = () => { if (!env.CF_API_TOKEN) return null; … };  // call-time by scope
const client = getClient();                                         // …called at module scope
```

Two files converted on that basis failed a control-vs-candidate pair on real assertions. So do not
treat a `setEnv` nomination as proof, and do not treat a refusal as proof of hardness either.

### Write a proven-unsafe file back into the tool, or it un-learns it

Those two files were reverted — and the next `--dry` nominated them again, because the analysis
had not changed. Static analysis proposes, the run disproves, a human reverts, and the analysis
proposes the identical thing tomorrow to somebody who does everything right.

`KNOWN_UNSAFE` in the codemod is the fix: refuse by name, with the mechanism in a comment so the
entry can be *retired* when the analysis improves rather than becoming permanent by default. It is
bookkeeping, not analysis.

The general rule, because this is not specific to env: **the allowlist ratchets against a growing
set of direct mocks; nothing was catching a shrinking set of proven-unsafe conversions.** Any
refusal a run teaches you has to be written back into the tool, or the tool's memory stays shorter
than the project's.

### Check the canonical default itself, not just the copies

`LOGGING`'s default was `''` while `server-schema` declares it `commaDelimitedStringArray()` — so
production hands consumers a `string[]`. The wrong type never threw, because the only consumer
does `env.LOGGING.includes(name)` and `String.prototype.includes` answers that correctly by
accident. Ten test files had each hand-set `LOGGING: []` to get the real shape and eight more
copied the wrong one, and nobody could see the disagreement because each file only ever saw its
own copy. Fixing the default is what made those hand-written declarations removable.

Same shape as the `REDIS_KEYS` drift: when a value is hand-copied per file, the copies diverge and
the divergence is invisible precisely because the copy is what the test compares against.

### Where `~/env/server` stands, and what is left

73 of 106 sites converted; `bySpecifier['~/env/server']` in the allowlist is the live number.
The codemod is **exhausted** — it nominates nothing further, so every remaining file needs a
person. The three labels matter more than the counts, because they need different work and
different amounts of nerve:

| n | class | kind | what it needs |
|---|---|---|---|
| 20 | key read at module scope in production | **correct-but-inapplicable**, mostly | read the file: is the key one *this test's assertions* depend on? |
| ~~13~~ 0 | the env table is mutated at runtime | **done** | see below — the method is worth more than the result |
| 5 | no keys the scan can find | **hand** | read it; the shape is not one the extractor knows |
| 4 | env table local is not a self-contained literal | **hand** | the table references something; inline it or leave it |
| 2 | a run proved it unsafe (`KNOWN_UNSAFE`) | **tool-fixable** | retire the entry when one-hop reachability lands |
| 2 | value not statically evaluable | **hand** | the value is computed |

**The mutation class is finished, and what it taught is below.** The shape was always:

```ts
const mockEnv = { DATABASE_IS_PROD: true, … };
vi.mock('~/env/server', () => ({ env: mockEnv }));
…
it('…when the database is not prod', () => { mockEnv.DATABASE_IS_PROD = false; …
```

The canonical `env` proxy implements `set`, so `setEnv({ DATABASE_IS_PROD: false })` inside
that one case is the conversion. The codemod declines it because lifting the *initial* values
and deleting the `vi.mock` leaves the local alive but disconnected — a rewrite, not a lift.

🔴 **Do not batch these on a green run alone.** Of four mutation-affected files in one batch,
the pair caught two; the other two went green because nothing downstream of the mutated key
was asserted, and they would have shipped as tests that no longer test their own names.

### What the mutation class taught, which is not specific to env

**A per-file override does not reset between TESTS.** `resetSharedMocks()` runs once per
file, so anything a case varies survives into the next case in that file. Every converted
file therefore needs its table re-stated in a `beforeEach`, never once at module scope. This
is not a deduction: removing the mask from `upload-backend`'s `beforeEach` produced
`expected 'b2' to be 'default'` — the endpoint set by the *previous* test reached the case
that asserts the key is unset.

**Write the branch table before touching a file with more than one or two mutations.** For
each case: which keys it sets, and which branch the test's *name* claims. The collected count
and the failure count are both blind to a case silently running the other branch, and the
table is the only artefact that catches it. It also catches you: on `dev-tunnel.service` the
table said token-set/zone-unset was a disabled state, and the file disproved it — the
Cloudflare gate is the **API token alone**, while the zone id only selects lookup-versus-direct.
A wrong prediction written down is a correction; a wrong prediction held in your head is a
conversion that ships.

**Prefer a case that discriminates over one that merely passes.** `workflow-completed`'s
fail-closed test set `JOB_TOKEN` to `undefined` and sent an *empty* token header — which 401s
whether the secret is unset or merely wrong. That was survivable until `JOB_TOKEN` gained a
canonical default equal to the value the file uses, at which point a fall-through would have
left the server configured and the test green. Sending the token the server *would* have
accepted makes the case fail when the override does not take effect (`expected 200 to be 401`).
**When a canonical default exists for a key a test clears, the clearing is load-bearing and
the test must be able to see it.**

**`''` and `undefined` are both present overrides.** Reads take `overrides.has(prop)` as the
discriminator, not the value, so a stored `undefined` masks a default rather than falling
through to it, and `''` stays a distinct falsy value. Note where this is *observable*: only on
keys that have a canonical default to fall through to. The `git-push` rotation suite passes
under either semantics and would not have told us if the proxy were wrong.

**The shielding rule, in the form that predicts rather than explains.** A per-file `vi.mock`
on **anything in a module's import graph** forces that module to be re-instantiated for that
file — which incidentally re-binds *all* of its other imports to that file's mocks. So a file
partial across two axes can be green because the axis you have not fixed is being shielded by
the one you are about to remove. Both `storage-resolver` files held a direct
`~/server/logging/client` mock that only broke once their env mock was correctly removed:
`deregisterBatch` loaded the module first and passed 8/8, `deregister` failed 4 of 5, every
one `Number of calls: 0`. **The danger point is a file whose env mock is its only mock** — and
the fix is the canonical mock for the other axis, never restoring the shield.

🔴 **Contention is at MODULE granularity, not SPECIFIER granularity, and this is the part that
decides how you build a verification set.** A file is only at risk from another file that
imports the **same consuming module** — not from one that merely mocks the same specifier. Two
files can both `vi.mock('~/env/server')` all day and never interfere if nothing imports a module
in common.

Established by a wrong prediction, which is the only reason it is legible: `apps-pipeline.reviewBuild`
failed 4 of 11 under `--no-isolate` in a 13-file set that contained **another importer of
`apps-pipeline.service`**. The same class of file, `apps-pipeline.triggerBuild`, was then put in a
10-file set with **eight** other `~/env/server` mockers, none of which imported that service — and
came back green 3/3. The prediction of a repair was wrong because the condition written down was
"other files that mock the specifier" when it should have been "other files that import the same
consumer".

Two consequences, both load-bearing:

- **A `--no-isolate` green over any set proves nothing about a file unless the set contains
  another importer of that file's consuming module.** Otherwise you have measured a file that had
  nothing to contend with.
- **`bySpecifier` and the allowlist cannot predict poisoning**, because both are keyed on the
  specifier. They measure mocks removed, which is a different quantity — see the eligibility note
  below for the other half of the same gap.

Build the set from *who imports the consumer*. Where that contention is already resolved — every
co-importer converted — say so and report the run as a **negative control**: a green there
confirms the prediction was right, which is a different and stronger claim than "no failures
observed".

### The 20 module-scope refusals, assessed file by file

Read, not converted. The question for each is narrower than the label: **does the module-scope
read that triggered the refusal sit in THIS test's import closure, and do THIS test's
assertions depend on that key?** A "yes" to the first and a "no" to the second makes the
refusal correct and inapplicable, and the file converts by deleting its mock.

**Correct-but-inapplicable — 8 files.** The blocked key is read at module scope *somewhere*,
but not by anything this test asserts on, and the canonical default is compatible:

| file | key | why it does not bind |
|---|---|---|
| `nowpayments.currencies.memoize` | `NEXTAUTH_URL` | zero references to the host anywhere in the file; the subject is memoisation |
| `public-endpoint-cache-override` | `NEXTAUTH_URL` | the only origin reference is a comment saying `TRPC_ORIGINS` must be iterable, which `TEST_ENV_DEFAULTS` already supplies |
| `public-endpoint-maxage` | `NEXTAUTH_URL` | same |
| `manifest-schema-endpoint` | `WEBHOOK_TOKEN`, `NEXTAUTH_URL` | asserts a literal `Access-Control-Allow-Origin: '*'`, not a derived origin list |
| `signals.service` | `SIGNALS_ENDPOINT` | **false positive** — every read in `signals.service.ts` is inside a function (`:42`, `:65`) |
| `delete-image-from-s3-logging` | `S3_IMAGE_B2_BUCKET` | **false positive of the one-hop kind, inverted** — `announcement-media-check.ts:177` is `const UPLOADS_BUCKET = () => env.…`, a module-scope const whose *value is a function*, so the read happens on call |
| `adjust-tag-level` | `IS_BUILD` | wants `false`; the key is absent from the defaults and reads `undefined`, which is falsy — same branch |
| `backfill-theme-elements` | `IS_BUILD` | same |

**Convertible by hand, with edits — 5 files.** The key genuinely binds, and the fix is either a
worker-level default or an assertion edit:

- `meilisearch/client` — `SEARCH_HOST`/`SEARCH_API_KEY`/`METRICS_SEARCH_*` are read at module
  scope to build the clients this test is about. Same shape as the `CLICKHOUSE_TRACKER_URL`
  precedent: move them into `TEST_ENV_DEFAULTS`. Note this makes them worker-global.
- `s3-utils` — `S3_UPLOAD_BUCKET` / `S3_UPLOAD_B2_*` bind at module scope and the file imports
  `env` directly to assert against it. Defaults or assertion edits.
- `delivery-worker` — `delivery-worker.ts:4` builds its endpoint string at module scope. Real.
- `createModelFileScanRequest` — binds, and ten references depend on the declared values, so
  this is an assertion-editing job rather than a lift.
- `image-scan-result` — `EMAIL_PORT` is read at module scope by `email/client.ts:8`. Real, and
  a default would fix it.

**Genuinely blocked — 5 files, and 4 of them are the flag the doc already calls a permanent
exclusion.** `id-origin-cache` needs `IS_DATAPACKET: true` while `id-file-download-url` and
`id-overflow-validation` need `false`; `pgDbMock.parity` needs `IS_BUILD: true` to short-circuit
`getClient()` while others want it falsy. Under one worker only the first value is ever visible,
so no mechanism fixes these — see *Some env tests cannot be migrated*. `health.runHealthChecks`
is the fifth: `health.ts:182` builds `envDisabledChecks` at module scope from
`HEALTHCHECK_DISABLED`, and varying it is the point of the file.

**Least sure about the middle group**, specifically `meilisearch/client` and `s3-utils`: both
are fixable by moving values into `TEST_ENV_DEFAULTS`, and both make a per-file value
worker-global, which is a change to every other file in the worker rather than to these two. The
`storage-resolver-null-contract` entry is a reminder to check the *module*, not the key —
`src/utils/storage-resolver.ts` reads these keys at call time while
`src/server/services/storage-resolver.ts:6` reads them at module scope, and the two tests import
different ones. The codemod got that pair right; a per-key generalisation would not have.

### The remaining 8 refusals, assessed

The other four labels, read the same way. **Five convert by hand, two are blocked, one is
unresolved.** Note the count: 20 + 8 = 28, so there is no separate pool beyond these.

**Convertible by hand — 5.** In every case the refusal is a static-analysis limit, not a
property of the test:

| file | refusal | what it actually is |
|---|---|---|
| `ingest-images-cap` | `IMAGE_SCANNING_MAX_PER_RUN` not statically evaluable | the value is a local `MOCK_CAP` const; the key is read inside the job body (`image-ingestion.ts:107`) |
| `git-push.gate` | `FORGEJO_WEBHOOK_SECRET` not statically evaluable | same shape — a `SECRET` const; read inside `verifyForgejoSignature` |
| `apps-pipeline.triggerBuild` | table not self-contained | references `TRIGGER_SECRET` from the same `vi.hoisted` block — **identical to `apps-pipeline.reviewBuild`**, already converted |
| `review-build-callback` | table not self-contained | `mockEnvStore` from a hoisted block — **identical to `build-callback`**, already converted |
| `publish-request.orchestration` | table not self-contained | `_publishEnvOverrides` is a plain module-scope const; every key it carries (`FORGEJO_*`, `BUNDLE_S3_*`, `DISCORD_WEBHOOK_MOD_ALERTS`) is read inside a function |

**Blocked — 2.** `origin-helpers` builds the allowlist `Set` at module load from `TRPC_ORIGINS`
+ `NEXTAUTH_URL` and its own docblock says so; its values differ from the defaults, and
promoting them is the origins blast-radius problem. `cloudflare/client.purgeCache` needs
`CF_API_TOKEN` present at import (`getClient()` is called at module scope) **and** declares
`LOGGING: 'cloudflare'` — a string — specifically so `createLogger` enables and the failure log
becomes observable. The canonical `LOGGING: []` makes `.includes('cloudflare')` false, so the
thing the test observes disappears; fixing that worker-wide changes logging for every file.

**Unresolved — 1, and the interesting one.** `image-cacher-invalidate-scope`'s `KNOWN_UNSAFE`
entry reads *"the value is captured during module evaluation, before any setEnv"* — but
`IMAGE_CACHER_ADMIN_SECRET` is read at `image.service.ts:359`, **inside a function**. The
file's table supplies it through a **getter** that returns a mutable `envOverrides` box, so the
likely real mechanism is the mutation class — a lift froze the getter into a static value and
lost the per-case variation — not module-scope capture at all. **A run beat a conversion whose
shape is not visible from the entry**, so the entry stands; but retiring it is a fresh-pair
question, and whoever does it should expect the canonical `defineProperty` accessor path
(`__envAccessor` in `env.mock.ts`) to be the tool, not `TEST_ENV_DEFAULTS`.

The general point: **a `KNOWN_UNSAFE` entry records that a run failed, not why.** The reason
text is a hypothesis written at the time, and this one does not survive reading the code.

⚠️ **And "no direct mocks" is not "eligible for `isolate: false`".** A file can be fully
migrated on every canonical axis — allowlist clean, nothing left to convert — and still be
permanently isolated, because what blocks it is a module-scope flag its neighbours disagree
about rather than a mock it owns. `bust-public-model-response-cache` is the worked example:
db, redis and logging are all migrated, and it can never join. So neither the allowlist nor
`bySpecifier` measures the population that can actually flip; they measure the mocks removed.

**Read `bySpecifier`, not `pendingFiles`.** A file blocked on two pending specifiers stays in
`pendingFiles` after you migrate one of them, so the file count can sit still while real sites
move — it stayed at 349 across three migrations in one batch, then moved by 2 for three in the
next. The site count under `bySpecifier` is the instrument; the file count is a lower bound on
work, not a measure of it.

**The `KNOWN_UNSAFE` entries and when they can go.** `cloudflare/__tests__/client.purgeCache`
and `services/__tests__/image-cacher-invalidate-scope` are both the one-hop shape:
`cloudflare/client.ts` reads `env.CF_API_TOKEN` inside `getClient()` and calls `getClient()`
at module scope on the next line. Whoever teaches the scan to follow a module-scope call into
a same-file function should delete both entries and re-run the pair.

### `env.X` and `process.env.X` are different variables here

The canonical mock replaces `~/env/server`. **Code that reads `process.env.X` directly never
sees it**, and several services do. Two consequences:

- A key added to `TEST_ENV_DEFAULTS` will appear to be ignored by those code paths. It is not
  a mock bug.
- A test can declare a key in its env mock that the code under test never reads, which makes
  the declaration inert — and makes a refusal *about that key* correct but irrelevant. Three
  `publish-request.*` files were exactly this: refused on `NEXTAUTH_URL`, which their service
  reads from `process.env`, and they converted by simply dropping it.

### The perf yardstick is not a coverage instrument

`bench.mjs`'s 90-file subset is a **cost** sample, stratified by closure size. Nothing makes
it representative of any behavioural population. Concretely: 17 test files exercise
`allowedOrigins` / `Access-Control-Allow-Origin`, and **2** are in the subset — so verifying a
change to an origin-affecting default against the yardstick alone would cover 15% of the files
that could break, and origin changes flip *behaviourally* with no string literal for a grep to
find. Build the verification set from the change; do not reach for the yardstick because it is
already written down.

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

**`toBeUndefined()` on a node is wrong about the design, while looking like the obvious
check.** An unset property still vivifies to a node, so the assertion fails with
`expected [Function Mock] to be undefined`. When you mean "the previous file's value did not
survive", say that: `expect(node.isReady).not.toBe(false)`. Assigned data properties are
tracked and cleared per file — `sysRedis.isReady = false` is the real case — but "cleared"
means the assignment is gone, not that the property reads as absent.

**Asserting on a key: name the constant, and pin the wire value ONCE.**

```ts
expect(incrKey).toContain(REDIS_SYS_KEYS.BLOCKS.REVIEW_RUN_FOR_REAL_BUZZ_CAP);
expect(REDIS_SYS_KEYS.BLOCKS.REVIEW_RUN_FOR_REAL_BUZZ_CAP)
  .toBe('system:blocks:review-run-for-real-buzz-cap');
```

They guard different failures and neither subsumes the other. Naming the constant in the
behavioural assertion stops the test re-inventing a key — the class that produced fourteen
invented values in one day. The golden value makes a rename loud: a key's wire value
addresses live Redis entries written by deployed code, so changing it orphans whatever sits
under the old name, and that should be a deliberate decision rather than something a test
silently follows.

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
- 🔴 **"Failure counts are tight within a tenancy" has a named exception: a CLIQUE.** Two
  control runs, identical tree, same tenancy, nothing changed between them, over the six test
  files importing `~/server/jobs/image-ingestion`: **8 failures then 12**, with
  `remove-blocked-images-retention` going **0 → 9** on no diff at all. Inside a clique the
  failures reassign between members run to run, so *every* failure-based reading there measures
  reassignment rather than your change. Collected counts held at 171 throughout — they are
  contention-independent, and on this axis they were the only surviving instrument.

  **Two consequences.** A per-file "fixed / worse" story is not attribution: a candidate read
  `8 → 5, one file fixed, one file worse`, and then **reverting the file under test produced the
  identical `8 → 5`** while a full revert produced 12. And **a change inside a clique cannot be
  licensed by a run at all** — not "failed verification", *unmeasurable*. Convert the clique
  together, or leave it. The reading that points the way you want is the one to distrust.
- **Never read a suite result through `| tail` or `| grep`.** You get the pipe's exit code.
  Redirect to a file, then read the file.

Before declaring a set migrated, confirm nothing in it still mocks a canonical specifier:

```bash
node scripts/test-perf/residual-mocks.mjs <list>
```

⚠️ **`residual-mocks.mjs` reports the three infra clients only — it does not scan
`~/env/server`.** A set can come back clean on it while every file still mocks env. Grep for
`vi.mock('~/env/server'` over the same list separately, and say which set you ran each over.

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

### The canonical three do not bound the silent class

A wholesale `vi.mock` of **any** multi-export module causes it. One test mocked
`~/server/utils/server-domain` — 14 exports — with a single-key factory; under
`--no-isolate` that froze the module for the worker, and a later file whose consumer reached
one of the other 13 died at module scope and collected zero tests. It took out a *different*
file at each worker count, which is why it presented as flakiness rather than as one broken
file.

So when a migrated set still has zero-collects, **grep the `--no-isolate` log for
`No "<export>" export is defined on the`** — the message names the poisoned module, and it is
usually not one of the three. A scan for wholesale mocks of multi-export modules across a
migrated set is the cheap preventative.

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
