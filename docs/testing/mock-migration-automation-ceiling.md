# Where the shared-mock codemod stops, and why

`src/server/routers/**` + `src/server/jobs/**` had 36 test files still mocking a canonical specifier
after the automatable ones were converted. **The codemod converts 0 of the 36.** Every remaining file
refuses.

That is not a criticism of the tool — it is the shape of the tail. What follows is what the tail is
made of, so whoever continues knows which refusals are a missing feature and which are a judgement
call that should stay manual.

Counts are refusal instances, not files; several files refuse for more than one reason.

## 1. Hand-built client factories — 14

```ts
const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const make = () => ({ appListing: { findUnique: vi.fn(async () => null) }, … });
  return { mockDbRead: make(), mockDbWrite: make() };
});
```

Refusal: `hoisted entry "mockDbRead" is not a bare vi.fn()`.

**Judgement call, correctly refused.** The conversion is mechanical (bind the root, drop the helper)
but deciding which of `make()`'s behaviours are canonical defaults and which have to be re-declared in
`beforeEach` needs a human reading the helper. `findUnique → null` and `findMany → []` are already
defaults; `create: async (args) => args.data` is not.

## 2. Inline behaviour in the factory — 9

```ts
vi.mock('~/server/redis/client', () => ({ redis: { set: vi.fn(async () => undefined) } }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: () => {} }) }));
```

Refusal: `inline behaviour at redisMock.redis.set (…)`.

**Automatable, and the highest-value gap.** The behaviour is already written as an expression; the
conversion is to move it to `mockImplementation` on the canonical node in `beforeEach`. Three of the
nine are `redis.set → undefined`, where the canonical default is `'OK'` — a real difference, so it has
to move rather than be dropped, but the move is mechanical.

The `logToAxiom: () => ({ catch: () => {} })` shape is worth its own note: it exists because the code
under test calls `.catch()` on the return value, and the canonical default returns a promise, which
already has `.catch`. Those two may be droppable rather than portable — but proving that needs the
call site, so a tool should port them and let the test say.

## 3. `dbRead` and `dbWrite` aliased to one object — 6

```ts
const mockDb = { … };
vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
```

Refusal: `local "mockDbRead" aliases dbMock.dbRead and dbMock.dbWrite — needs a human`.

**Judgement call, must stay manual, and it is the one that finds bugs.** The canonical mock keeps the
two distinct, so a `dbWrite` call can no longer satisfy a `dbRead` assertion. Splitting them requires
knowing which client the code actually exercises, and some of these will go red. That redness is the
finding; do not alias them back.

## 4. Constants supplied by the factory — 8

```ts
REDIS_KEYS: completeKeys({ BLOCKS: { POPULAR_CHECKPOINT: 'blocks:popular-checkpoint' } }),
```

Refusals: `REDIS_KEYS in the factory is not a plain literal` (4), `non-literal property inside a
client object` (2), `REDIS_SYS_KEYS literal DIFFERS from the real constant` (2).

**Automatable, but the tool is asking the wrong question.** `setup.ts` registers the canonical mocks
with an `importOriginal` spread, so `REDIS_KEYS` and `REDIS_SYS_KEYS` already come from the real
module. The factory's copy is not needed at all — it can be deleted rather than translated.

The tool refuses because it tries to prove the literal matches the real constant, which it cannot do
when the value is a call expression. The question that actually decides safety is narrower: **does the
test assert on a key string?** If it only passes keys through, dropping the override is safe whatever
it contained. If it asserts one, the real value has to match — and where it does not, that is a
finding:

```
  remove-deleted-user-images.test.ts   DELETED_USER_IMAGE_PURGE_LIMIT: real
                                       "system:deleted-user-image-purge-limit" vs test "k"
  restore-user-images.test.ts          PENDING_IMAGE_RESTORES: real
                                       "system:pending-image-restores" vs test "pending-restores"
```

Two tests asserting against their own fixture rather than the real key.

## 5. Factory declares an export the canonical mock does not own — 3

`safeError` (2, on `~/server/logging/client`), `withSysReadDeadline` (1, on `~/server/redis/client`).

**Genuine gap in the canonical mocks, not in the codemod.** These are real exports of the mocked
modules that a test needs to stub, and the canonical mock owns only `logToAxiom` / `redis` /
`sysRedis`. Since both registrations spread the original, the real implementations are present — so
the question is whether these three tests need to stub them at all, or were stubbing them only because
the whole module was being replaced. Two of the three (`safeError`) are in files that also carry the
drifted-constant finding above, which suggests the whole factory was written to avoid loading the real
module rather than to change behaviour.

## What would raise the ceiling

In value order:

1. **Port inline behaviour to `mockImplementation` (§2, 9 instances).** Purely mechanical.
2. **Delete factory-supplied constants instead of validating them (§4, 8 instances)** — gated on
   "does the test assert a key", which is a grep, not an inference.
3. **§1 and §3 should stay manual.** 20 of the 36 refusals are there, and both categories are where a
   human decision has value: which behaviours are non-default, and which client the code exercises.

So the automation ceiling on this tail is around 17 of 36 refusals, and the remaining 20 are the work
the tool should not be doing.

## The control run that found a hazard, and why the fix was not a precondition

Taking a control run on the migration branch _before_ converting anything turned up a file collecting
**zero tests inside a run reporting `870 passed, 0 failed`** —
`src/server/jobs/__tests__/process-vault-items.test.ts`, which is 15 tests on a main-based tree.

The chain: `setup.ts` registered the canonical db mock with an `importOriginal` spread, which evaluated
the real `~/server/db/client`; that shim constructs Prisma clients at module scope; the file mocks
`@prisma/client` without a `PrismaClient` export, so the construction threw. At module scope, so it
collected nothing and the failure count never moved.

Two things about it are worth keeping:

- **A file's own `vi.mock('~/server/db/client')` protected it**, because that registration replaces the
  canonical one for that file and the real module is never evaluated. Migration removes exactly that
  protection — so the same file is safe before conversion and fatal after, which is the worst possible
  shape for a hazard to have.
- **The obvious fix was the wrong one.** Adding `PrismaClient: class PrismaClient {}` to the six
  factories lacking it (one migrated, five one conversion away) would have addressed the instances and
  left the mechanism. The mechanism fix was to spread the _package_ rather than the shim:

  ```ts
  vi.mock('~/server/db/client', async () => ({
    ...(await import('@civitai/db/client')),
    dbRead: dbMock.dbRead,
    dbWrite: dbMock.dbWrite,
  }));
  ```

  Same exports, nothing constructed, and it covers `@civitai/db` and anything else of that shape rather
  than enumerating them. Re-measured after: 36 files, 885 tests, zero zero-collect, and the only
  per-file change was that file going 0 → 15.

The general rule this leaves: **take the control on the migration branch.** A control taken on `main`
would have shown 15 tests, the post-conversion run 0, and the conversion would have been blamed.
