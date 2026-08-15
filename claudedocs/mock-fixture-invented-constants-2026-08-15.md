# Fixtures that invented their own Redis keys — and the blind spot that hid them

Recorded 2026-08-15, during the shared-mock migration of `src/server/**` (minus `services/`,
`jobs/`, `routers/`). The evidence is perishable: these were only visible while the per-file
`vi.mock` factories still existed, and the migration deletes them.

## What was found

Ten test files declared their own copy of a Redis key constant inside a `vi.mock` factory, and the
copy did not match the real constant. **Six distinct constants, 14 occurrences.** (The codemod's
own summary line counts files with drift and says "9"; the per-file listing below is the number
that matters.)

| constant | real value | fixture's value | files |
|---|---|---|---|
| `REDIS_KEYS.CACHE_LOCKS` | `cache-lock` | `caches:lock` | 5 |
| `REDIS_KEYS.TAG` | `tag` | `caches:tag` | 3 |
| `REDIS_KEYS.CACHES.EDGE_CACHED` | `packed:caches:edge-cache` | `edge-cached` | 1 |
| `REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.FAILURES` | `new-order:sanity-failures` | `new-order:sanity-check-failures` | 2 |
| `REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ACOLYTE_FAILED` | `new-order:judgments:acolyte-failed` | `new-order:acolyte-failed` | 2 |
| `REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.POOL` | `new-order:sanity-checks` | `new-order:sanity-checks:pool` | 1 |

```
src/server/cloudflare/__tests__/client.purgeCache.test.ts          EDGE_CACHED
src/server/games/new-order/__tests__/counter-clickhouse-transient-503.test.ts  FAILURES, ACOLYTE_FAILED
src/server/games/new-order/__tests__/counter-getall-buffer.test.ts             FAILURES, ACOLYTE_FAILED
src/server/games/new-order/__tests__/sanity-check-buffer.test.ts               POOL
src/server/redis/__tests__/model-votable-tags-cache.test.ts        CACHE_LOCKS
src/server/utils/__tests__/cache-helpers-l1.test.ts                CACHE_LOCKS, TAG
src/server/utils/__tests__/cache-helpers-malformed-entry.test.ts   CACHE_LOCKS, TAG
src/server/utils/__tests__/cache-helpers-refresh-dontcache.test.ts CACHE_LOCKS, TAG
src/server/utils/__tests__/tensor-metadata-cache-split.test.ts     CACHE_LOCKS
```

## Why nothing was red

**Not one test failed, before or after the conversion.** No affected test named those constants
outside its own factory, so wherever a key appeared in an assertion, the value under test and the
expected value were both the fixture's invention. The test compared the fixture to itself.

That is a test which is **green forever and means nothing** — and it is the one class that no
before-and-after diff can catch, because there is no difference to observe. The migration did not
cause it and does not fix the underlying habit; it merely deleted the copies, so these tests now see
the real values.

**Six of the fourteen are plausible variants of the real name**, which is what makes this dangerous
rather than embarrassing: `new-order:sanity-check-failures` for `new-order:sanity-failures`,
`caches:lock` for `cache-lock`. A reviewer reading the factory sees a name that looks right.

## The blind-spot table this completes

Each safeguard the migration relies on catches one class and is blind to the next:

```
collected-count diff   blind to a file that collects and asserts nothing
residual-mocks         blind to behaviour lost inside a converted mock
pass/fail diff         blind to assertions that stopped failing
all three              blind to an assertion that never COULD fail
```

The only thing that caught the third row was a **control pair at assertion level on a small file
set, run by someone who did not write the tool**. The only thing that caught the fourth was the
codemod comparing each factory's constants against the real module — i.e. a check aimed at the
fixture rather than at the outcome.

**Corollary for anyone verifying a conversion:** a mutation that does not bite is evidence of
nothing until it has been shown to bite on the *original*. Two mutations during this slice came back
green and looked like conversion-induced vacuity; both were equally green against the unconverted
file, so both were mis-aimed at paths those files never exercise.

## One caveat on this slice specifically

Three files converted some specifiers while the codemod correctly refused another:

```
~/server/redis/client     challenge-helpers.test.ts
~/server/logging/client   challenge-winner-payout-dedupe.test.ts, challenge-winner-persistence.test.ts
```

Per-specifier atomicity holds — nothing is half-converted for any single specifier — but those
specifiers stay poisoned for the worker. `residual-mocks.mjs` reports it honestly as `0 / 1 / 2`.
The trap is reading a green slice as "redis is clean here"; it is the partially-migrated-set problem
arriving *within* a slice rather than between slices.
