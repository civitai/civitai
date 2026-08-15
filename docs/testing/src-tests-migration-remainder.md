# `src/tests/**` shared-mock migration — the four not done

22 of 25 files in this slice are migrated onto the canonical shared mocks
([shared-module-mocks.md](./shared-module-mocks.md), [migration recipe](./shared-module-mock-migration.md)).
These four are not, with the reason each refused. All are ordinary hand-work; none needs a
different owner, and none is blocked on `~/env/server`.

**The slice's residual state is known-good, not assumed.** `node scripts/test-perf/residual-mocks.mjs`
over **all 25 files** (not a subset) reports:

```
  2  ~/server/db/client       id-file-download-url, git-push.gate
  2  ~/server/redis/client    apps-catalog-rate-limit, withdraw
  0  ~/server/logging/client
```

Exactly the four below and nothing else. Re-run it over the full 25 after each conversion, and say
which set you ran it over — see the first warning at the bottom.

| file                                                 | specifier               | codemod refusal                                                                      |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `api/v1/model-versions/id-file-download-url.test.ts` | `~/server/db/client`    | `factory replaces "dbKV" with behaviour — it is a canonical export`                  |
| `api/internal/blocks/git-push.gate.test.ts`          | `~/server/db/client`    | `local "mockPubReqFindFirst" aliases dbMock.dbRead.appBlockPublishRequest.findFirst` |
| `server/utils/apps-catalog-rate-limit.test.ts`       | `~/server/redis/client` | `no module-scope declaration found for "mockSysRedis"`                               |
| `api/v1/blocks/withdraw.test.ts`                     | `~/server/redis/client` | `hoisted entry "mockSysRedis" is not a bare vi.fn()`                                 |

## What the two redis ones will need

Both build a `sysRedis` fake around a chainable `multi()` whose `exec` the tests drive. The
worked conversion is in `api/v1/blocks/submissions.test.ts` and `api/v1/blocks/dev-token.test.ts`:
bind `redisMock.sysRedis` to the file's existing local name so downstream assertions need no
edits, and move the chainable into `beforeEach` as a `mockImplementation`, since no canonical
default covers it.

⚠️ `withdraw.test.ts` hand-writes `REDIS_SYS_KEYS.BLOCKS.WITHDRAW_RATE_LIMIT`. Check it against
`packages/civitai-redis/src/client.ts` before deleting: seven of the copies in this slice were
wrong, and the ones that read like real keys were wrong as often as the obvious placeholders.

## Two things that cost time here

**Run `residual-mocks.mjs` over the whole slice, not the files you are thinking about.**
`tier1-public-route-disclosure` sat half converted — logging migrated, redis mock left in place —
through a full round of measurement. Collected counts, pass/fail and mutation are all blind to it;
a leftover mock on a canonical specifier re-poisons that specifier for every file sharing the
worker. The tool that catches it was in the protocol and was run on the wrong subset.

**A partially migrated slice's totals are unreadable in both directions.** This slice's
`--no-isolate` failure count moved 19 -> 41 -> 24 -> 37 across batches while every converted file
stayed clean. `dev-token` went 0 -> 41 without being touched: it was a hold-out replacing the
canonical `withSysReadDeadline`, and it broke only once the canonical registration won in more
workers. Judge conversions per file against a control; the slice total means nothing until the
slice is finished.
