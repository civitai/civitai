# Services `__tests__` m–z — conversion prediction, recorded before the codemod ran

Slice: `src/server/services/__tests__/`, the 40 allowlist files sorting from
`model.service.vae-append-no-mutation.test.ts` to the end. Base `5ee56c6658`.

This file is written **before** `codemod-shared-mocks.mjs --dry` was run against the slice, so
that a large miss is legible as a classifier bug rather than absorbed silently. The classifier
is `scratchpad/classify.mjs`, written from `docs/testing/shared-module-mock-migration.md` and the
canonical defaults in `src/__tests__/mocks/{db,redis,logging}.mock.ts`, without reading the
codemod source.

## Prediction

**5 of 40 auto-convertible.** Second estimate, **8 of 40**, if josh's report that the codemod
converts drifted `REDIS_KEYS` literals instead of refusing them is right (see below).

| bucket | n | mechanism |
|---|---|---|
| convert | 5 | factory leaves are bare `vi.fn()`, passthrough wrappers, or restatements of a canonical default |
| behaviour | 20 | a leaf carries real behaviour the canonical default does not cover |
| alias | 7 | one local serves both `dbRead` and `dbWrite` |
| extraExport | 7 | factory declares an export the canonical mock does not own |
| importOriginal | 1 | `importOriginal` spread whose override carries behaviour |

Predicted convert set:

```
placement-metrics.service.test.ts
placement.service.test.ts
redeemableCode.service.test.ts
strike.service.test.ts
tag-with-model-count-cache.test.ts
```

## Stopping rule

If the codemod's actual auto-convertible count falls outside **3–10**, stop and diff the two
classifications file by file before converting anything. A miss in either direction is a
classifier bug or a codemod behaviour the recipe does not describe, and neither is visible in a
green run.

## The one place I expect to be wrong, and why I did not adjust for it

josh (services a–l) reports from his own dry run that the codemod **converts** files carrying
`REDIS_KEYS` literals that have drifted from the real table, silently swapping the real constant
in — where the recipe says it refuses on divergence. My classifier follows the recipe and refuses
these three:

```
paid-access.service.test.ts            PAID_ACCESS = 'test:paid-access'
scanner-policies.buffer.test.ts        RUN_CANCEL  = 'scanner-policy:run-cancel'
nowpayments.currencies.memoize.test.ts SUPPORTED_CRYPTO_CURRENCIES = 'packed:caches:supported-crypto'
```

None of the three values appear in `packages/civitai-redis/src/client.ts`. `'test:paid-access'`
is a self-evident placeholder; the other two are plausible enough to survive a reading, which is
the class the recipe warns produces invisible drift.

I have left the primary prediction unadjusted so the codemod result discriminates between the
recipe and josh's observation rather than confirming a number I already moved. Whichever way it
lands, the three drifted constants get logged whether or not the suite goes red — a drifted
constant nothing asserts on can neither fail nor be reviewed.

## Outcome — the stopping rule fired

```
codemod --dry, 40 candidate files: 11 convertible | 30 with refusals
  fully converted (every canonical specifier):  10
  partial (converted one, refused another):      1   <- counts as NOT migrated
  fully refused:                                29
predicted convert: 5        stopping range: 3-10        actual: 11
PER-FILE AGREEMENT: 27/40 (68%)  — 9 I called refuse converted, 4 I called convert refused
```

Both the net and the per-file rule fire. The two error populations partly cancel, which is the
shape sky flagged from josh's slice: a net closer to 5 would have licensed a classifier wrong in
both directions at a 33% rate. Two distinct bugs in mine, both found by diffing per file:

**Bug 1 — ES6 shorthand properties are invisible to it (4 false converts).** `dbRead: { keyValue:
{ findUnique }, $queryRaw: queryRaw }` has one leaf my `key:` regex can see. The codemod refuses
the shorthand as a `non-literal property inside a model object`; I saw an empty model and passed
it. `placement.service`, `placement-metrics.service`, `redeemableCode.service`, `strike.service`.

**Bug 2 — it scans into nested literals that are not the client (contributed to the 9 false
refusals).** In `search-error-log-pii` the redis factory builds a permissive key stand-in,
`new Proxy(() => 'k', { get: () => make() })`, and I read that handler's `get` as a client method
carrying behaviour. The client itself is `{ packed: { get: vi.fn(), set: vi.fn() } }` and converts
cleanly. The codemod was right and I was wrong.

## Two claims that did not survive contact

**Drifted `REDIS_KEYS` constants are converted, not refused.** josh reported this from a–l and it
reproduces here: `nowpayments.currencies.memoize.test.ts` converted while the report named
`REDIS_KEYS.CACHES.SUPPORTED_CRYPTO_CURRENCIES` as real
`"packed:caches:supported-crypto-currencies"` vs test `"packed:caches:supported-crypto"`. The
recipe said it refuses on divergence; that sentence is now corrected in
`docs/testing/shared-module-mock-migration.md`. One drifted constant in this slice, logged here
because a drifted constant nothing asserts on can neither fail nor be reviewed.

**`importOriginal` shapes are not uniformly refused.** `vae-files-cross-version.test.ts` mocks
`~/server/redis/client` through `importOriginal` and the codemod converted it. Worth knowing
before treating "it is an importOriginal, so it is hand work" as a triage rule.

## One conversion to watch in the control

`search-error-log-pii.test.ts` replaces a permissive `REDIS_KEYS`/`REDIS_SYS_KEYS` proxy — every
path resolves to a callable returning `'k'` — with the real key tables. Any key path the test
walks that does not exist for real goes from `'k'` to `undefined`. That is the intended direction,
but it is a behavioural change the collected-count diff cannot see, so it needs reading at
assertion level rather than colour.

## Slice boundary

josh took the flat allowlist files under `src/server/services/__tests__/` through
`model-version.purge-by-hash.service.test.ts` inclusive (129). My 40 is the tail after it, and
**includes** the three files whose leading `m` puts them with him under a letter rule but which
sort after the named endpoint (`-` 45 < `.` 46 < `3` 51):

```
model.service.vae-append-no-mutation.test.ts
model3d-visible-id-for-post.test.ts
model3d-visible-ids-batch.test.ts
```

129 + 40 = 169 = the flat total. No overlap, no hole.

## Slice size — the brief's count is high

The brief put this slice at "roughly 84 files". On disk the m–z range holds 61 `.test.ts` files;
40 of them carry a direct mock of a canonical specifier and appear in the allowlist. 84 matches
neither. The burn-down is the allowlist, so the work is 40.
