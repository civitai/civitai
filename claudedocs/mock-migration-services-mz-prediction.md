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
