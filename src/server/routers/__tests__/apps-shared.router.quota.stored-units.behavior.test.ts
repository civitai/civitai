import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Booting PGlite (WASM Postgres) and driving ~100 moderated writes through it can
// exceed the default 10s hook/test timeouts on a contended runner. Relaxing them
// can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

/**
 * THE SEAM BETWEEN THE SHARED ROUTER'S QUOTA ARITHMETIC AND THE BYTES POSTGRES
 * ACTUALLY STORES.
 *
 * 🔴 WHY THIS FILE EXISTS. The shared write path has one existing suite,
 * `apps-shared.router.test.ts`, and it is structurally unable to see this class:
 * its pool is a mock, so every byte figure the gate reads — `quota.used_bytes`,
 * `shared_kv.size_bytes`, and now the stored-size probe — is supplied by the
 * fixture rather than computed by Postgres. The sibling suite
 * `storage-provision.trigger.behavior.test.ts` meets the real generated column and
 * the real trigger, but writes rows with raw SQL and never executes the router's
 * gate. Neither ever builds the combined state, so `APP_QUOTA_BYTES` was never once
 * evaluated against real Postgres anywhere in the tree.
 *
 * This suite builds it: the provisioner's own unmodified DDL, generated column and
 * quota trigger on an in-process Postgres, with the REAL `appendSharedRow` /
 * `updateSharedRow` — the same functions the tRPC procedures and the block REST
 * adapters both call — driving it through a PGlite-backed pool.
 *
 * WHAT THE GUARDS PIN. Not one side of the comparison, but the RELATIONSHIP between
 * the two units:
 *
 *   1. the units genuinely diverge for the fixture used, by a RATIO and not merely
 *      by a constant (the positive control: a title-only value diverges by exactly
 *      one byte however long the title, which is far too little for the walk in (3)
 *      to exploit);
 *   2. `append` refuses at exactly the STORED-byte boundary, so a value whose WIRE
 *      size fits the remaining budget and whose STORED size does not is refused;
 *   3. a sequence of `update`s that each hold the quota delta at or below zero in the
 *      WIRE unit cannot push `quota.used_bytes` past the ceiling — using a value the
 *      wire cap admits that stores 46.8x what it sends, which is what makes the
 *      overrun megabytes rather than kilobytes.
 *
 * (2) and (3) are the regressions this file was written for. Before the fix, the
 * gate compared a wire-unit size against a stored-unit counter:
 *   - `append` charged `Buffer.byteLength(JSON.stringify(v))`, so every create was
 *     under-charged relative to what it stored;
 *   - `update` computed `wireNew − storedOld`, a subtraction across two units.
 *     Submitting any value whose wire size is at or below the row's current stored
 *     size holds that difference at or below zero forever, so the gate passes
 *     unconditionally while the trigger charges the true stored growth.
 *
 * THE ORACLE IS NOT THE ROUTER. Every expectation is either a measured literal, the
 * `shared_kv.size_bytes` generated column (which is what the trigger sums), or
 * Postgres' own `sum(size_bytes)` recompute — a different mechanism (recompute)
 * from the one under test (incremental maintenance through a gate).
 */

const holder = {
  db: null as unknown as PGlite,
};

/**
 * Route one statement at the in-process database.
 *
 * Parameterized statements go through the extended protocol (`query`); everything
 * else through the simple protocol (`exec`), which is what parses dollar-quoted
 * function bodies, `DO $do$ … $do$` blocks and `SET LOCAL` server-side.
 */
async function runSql(sql: string, params?: unknown[]) {
  if (params && params.length > 0) {
    return normalize(await holder.db.query(sql, params as unknown[]));
  }
  const results = await holder.db.exec(sql);
  return normalize(results[results.length - 1] ?? { rows: [] });
}

/**
 * 🔴 PGlite reports DML row counts as `affectedRows`; `node-postgres` reports them as
 * `rowCount`, and that is the field `updateSharedRow` reads to decide whether its
 * in-place UPDATE actually hit a row. Left unmapped, every successful update returns
 * `rowCount: undefined` and the router's lost-race branch turns it into a NOT_FOUND —
 * a harness artifact that reads exactly like a real defect in the write path. Map it
 * once, here, so the router sees the field shape it ships against.
 *
 * A SELECT carries `affectedRows: 0`, so fall through to the row count for reads.
 */
function normalize(res: { rows?: unknown[]; affectedRows?: number; rowCount?: number }) {
  const rows = res.rows ?? [];
  const affected = res.rowCount ?? res.affectedRows ?? 0;
  return { ...res, rows, rowCount: affected > 0 ? affected : rows.length } as {
    rows: unknown[];
    rowCount: number;
  };
}

// PGlite is a single session, so one shared connection stands in for the pool.
// `release` is a no-op for the same reason. Session state (an open transaction, a
// `SET LOCAL`) therefore persists across calls exactly as it does on one real
// pooled connection — the property the quota trigger depends on.
const fakeClient = {
  query: (sql: string, params?: unknown[]) => runSql(sql, params),
  release: () => undefined,
};
const fakePool = {
  connect: async () => fakeClient,
  query: (sql: string, params?: unknown[]) => runSql(sql, params),
};

// `mockIsRevoked` declares the parameters `BlockRevocation.isRevoked` is actually
// called with — `(blockInstanceId, sub)`. `vi.fn(async () => false)` infers a zero-arg
// signature, which makes the spread forward below a TS2556 under
// `tsconfig.tests.json`. That program is NOT covered by `pnpm typecheck`, because
// `tsconfig.json` excludes `src/**/__tests__/**` — so the error is invisible to the
// command most likely to be run. The sibling `apps.router.storage.stored-units`
// suite carries the identical error from the same copied pattern; it is left alone
// here only because it is outside this change.
const { mockVerifyBlockToken, mockIsRevoked } = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockIsRevoked: vi.fn<(blockInstanceId: string, sub?: string) => Promise<boolean>>(
    async () => false
  ),
}));

// `~/server/db/client` and `~/server/logging/client` are mocked ONCE, globally, in
// src/__tests__/setup.ts — a per-file `vi.mock` of either is a
// `no-direct-shared-module-mock` violation (under `isolate: false` it freezes this
// file's mock shape into every later file in the same worker). Declare behaviour on
// the canonical objects instead. The sibling fixture suite predates that rule and is
// grandfathered on the allowlist; a new file is not.
//
// Everything that is NOT the storage arithmetic or the database is stubbed. In
// particular `~/server/services/apps/storage-provision.service` is deliberately NOT
// mocked — this suite runs the provisioner for real, which is the whole point: the
// DDL, the generated column and the trigger under test are the shipped ones, not a
// transcription. The min-trust gate is likewise real; only its redis-backed inputs
// are stubbed.
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => fakePool }));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (sub: string) => (sub === 'anon' ? null : Number(String(sub).split(':')[1])),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: async () => true,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: {
    getSessionUserById: async (id: number) => ({
      id,
      isModerator: false,
      bannedAt: null,
      muted: false,
      // Flags.hasFlag(Buzz, Buzz) === true → onboarding complete.
      onboarding: 31,
      emailVerified: new Date('2020-01-01'),
      createdAt: new Date('2020-01-01'),
      tier: 'free',
    }),
  },
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: {
    isRevoked: (blockInstanceId: string, sub?: string) => mockIsRevoked(blockInstanceId, sub),
  },
}));
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  checkSharedAppendRateLimit: async () => ({ allowed: true }),
  checkSharedVoteRateLimit: async () => ({ allowed: true }),
  checkSharedReportRateLimit: async () => ({ allowed: true }),
  checkSharedWithdrawRateLimit: async () => ({ allowed: true }),
}));
// Keep the content-safety belt REAL (real includesMinor / includesPoi / escape); mock
// only its redis-backed deps, exactly as the fixture suite does.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: async () => undefined,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: async () => undefined,
}));

const { appendSharedRow, updateSharedRow } = await import('../apps-shared.router');
const { AppStorageProvisioner } = await import('~/server/services/apps/storage-provision.service');

// `sanitizeAppSlug` folds the token's blockId to `[a-z0-9_]`, so this blockId
// resolves to schema "app_shared_unit_probe".
const BLOCK_ID = 'shared-unit-probe';
const SCHEMA = '"app_shared_unit_probe"';
const APP_BLOCK_ID = 'apb_shared_unit_probe';
const USER_ID = 7171;

// Mirrors of the router's private constants. Deliberately re-declared as literals
// rather than imported (they are not exported anyway): a test that imports the
// constant it asserts against cannot see the constant moving, and these are the
// ceilings the walk below has to actually press against.
const APP_QUOTA_BYTES = 50 * 1024 * 1024;
const SHARED_VALUE_BYTE_CAP = 64 * 1024;

function claims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${USER_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti_shared_unit_probe',
    blockId: BLOCK_ID,
    appId: 'app_shared_unit_probe',
    blockInstanceId: 'bki_shared_unit_probe',
    ctx: {},
    scopes: ['apps:storage:shared:read', 'apps:storage:shared:write'],
  };
}

type SharedValue = { title: string; body?: string; data?: unknown };

async function append(value: SharedValue) {
  mockVerifyBlockToken.mockResolvedValueOnce(claims());
  return await appendSharedRow('tok', value);
}

async function update(key: string, value: SharedValue) {
  mockVerifyBlockToken.mockResolvedValueOnce(claims());
  return await updateSharedRow('tok', key, value);
}

/** `true` if the write was accepted, `false` if the byte ceiling refused it. */
async function tryAppend(value: SharedValue): Promise<string | null> {
  try {
    return (await append(value)).key;
  } catch (err) {
    const message = (err as { message?: string }).message ?? '';
    if (message === 'app quota exceeded') return null;
    throw err;
  }
}

async function tryUpdate(key: string, value: SharedValue): Promise<boolean> {
  try {
    await update(key, value);
    return true;
  } catch (err) {
    const message = (err as { message?: string }).message ?? '';
    if (message === 'app quota exceeded') return false;
    throw err;
  }
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const res = params.length > 0 ? await holder.db.query(sql, params) : await holder.db.exec(sql);
  const rows = Array.isArray(res) ? res[res.length - 1].rows : res.rows;
  return Number(Object.values((rows as Record<string, unknown>[])[0])[0]);
}

/** The trigger-maintained app counter. */
const usedBytes = () =>
  scalar(`SELECT used_bytes FROM ${SCHEMA}.quota WHERE app_block_id = $1`, [APP_BLOCK_ID]);

/** The same quantity recomputed from the rows — a different mechanism. */
const recomputedBytes = () =>
  scalar(`SELECT COALESCE(sum(size_bytes), 0) FROM ${SCHEMA}.shared_kv`);

/** The generated column: exactly what the quota trigger sums for this row. */
const storedSizeOf = (key: string) =>
  scalar(`SELECT size_bytes FROM ${SCHEMA}.shared_kv WHERE key = $1`, [key]);

const rowCount = () => scalar(`SELECT count(*) FROM ${SCHEMA}.shared_kv`);

/** Seed the app counter directly, the way a nearly-full app arrives in production. */
async function seedUsedBytes(value: number) {
  await holder.db.query(`UPDATE ${SCHEMA}.quota SET used_bytes = $2 WHERE app_block_id = $1`, [
    APP_BLOCK_ID,
    value,
  ]);
}

/**
 * An array of `n` ones, carried in the value's opaque `data` blob.
 *
 * 🔴 THE FIXTURE IS CHOSEN SO THE TWO UNITS DIVERGE, and a careless choice sees
 * nothing. `JSON.stringify` emits `[1,1,1]`; Postgres' jsonb output function emits
 * `[1, 1, 1]` — a space after every separator, and `: ` after every object key — so
 * an n-element integer array is `2n + 1` wire bytes against `3n` stored bytes, a
 * 1.5x RATIO. A title-only value differs by exactly one byte however long the title,
 * a constant with no ratio to exploit, and would make every guard in this file pass
 * against the pre-fix router.
 *
 * `data` is the half of the value the title/body belt never reads (and, with the
 * data-moderation flags off as they are here, nothing else does either), so it can carry
 * an arbitrary JSON shape without the content-safety belt having an opinion about it.
 */
const ones = (n: number) => Array.from({ length: n }, () => 1);
const wireBytes = (value: SharedValue) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * A high-expansion value whose whole-value wire size is at most `wireLimit`, for
 * showing that SHARED_VALUE_BYTE_CAP — enforced in the wire unit — bounds stored
 * bytes by nothing.
 *
 * `JSON.stringify(Number.MIN_VALUE)` is `5e-324`, six bytes plus a comma, while jsonb
 * normalises the same number to its full 326-digit decimal expansion plus `, `. So a
 * single value of 65,532 wire bytes stores 3,069,452 — **46.8x** — and one accepted
 * write can add megabytes to a counter a wire-unit gate thought it was holding flat.
 *
 * ⚠️ MEASURED, NOT MAXIMAL. An earlier draft of this file used `1e308` and claimed in
 * two places to be "the highest-expansion value the cap admits". It is not: at the
 * identical wire size and element count, `1e308` stores 2,910,366 (44.4x) against
 * `5e-324`'s 3,069,452 (46.8x), because the decimal expansion is 309 digits rather
 * than 326. Both numbers were measured against Postgres. No claim of maximality is
 * made here — only that these two were compared and this is the larger. If you need a
 * true maximum, search for it; do not infer one from this comment.
 *
 * Solved rather than searched — the wire size is linear in the element count — and
 * the result is asserted at the call site rather than trusted.
 */
function expansionBomb(title: string, wireLimit: number): SharedValue {
  const base = wireBytes({ title, data: [] as unknown });
  const perElement = Buffer.byteLength(`${JSON.stringify(Number.MIN_VALUE)},`, 'utf8');
  const ceiling = Math.min(wireLimit, SHARED_VALUE_BYTE_CAP);
  const n = Math.max(1, Math.floor((ceiling - base) / perElement));
  return { title, data: Array.from({ length: n }, () => Number.MIN_VALUE) };
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.waitReady;
});

beforeEach(async () => {
  mockVerifyBlockToken.mockReset();
  mockIsRevoked.mockReset();
  mockIsRevoked.mockResolvedValue(false);
  // The approved-app lookup is on the REPLICA (dbRead). The canonical mock keeps
  // dbRead and dbWrite DISTINCT, so naming the wrong one silently leaves the
  // resolver seeing a null and every write refused with NOT_FOUND.
  dbMock.dbRead.appBlock.findUnique.mockReset();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: APP_BLOCK_ID, status: 'approved' });

  // Real DDL, real generated column, real trigger. Idempotent, so re-provisioning
  // per test is safe; the tables are truncated so each test starts from zero.
  await AppStorageProvisioner.provision({ appBlockId: APP_BLOCK_ID, slug: 'shared_unit_probe' });
  await holder.db.exec(`TRUNCATE ${SCHEMA}.shared_kv CASCADE`);
  await seedUsedBytes(0);
  await holder.db.exec(
    `UPDATE ${SCHEMA}.quota SET row_count = 0 WHERE app_block_id = '${APP_BLOCK_ID}'`
  );
});

describe('shared-storage quota arithmetic vs the bytes Postgres stores', () => {
  /**
   * The positive control for this whole file. If the two units agreed, every guard
   * below would be vacuous — so establish, against the real database and through the
   * real write path, that they disagree and by how much, before asserting anything
   * about a gate.
   *
   * Values are pairwise distinct in BOTH units, and none of them equals a ceiling or
   * a size used elsewhere in this file, so no assertion here can be satisfied by the
   * wrong quantity.
   */
  it('stores MORE bytes than JSON.stringify produces, in a RATIO for dense values', async () => {
    const cases: Array<{ value: SharedValue; wire: number; stored: number }> = [
      { value: { title: 't', data: [1, 2, 3] }, wire: 28, stored: 33 },
      { value: { title: 't', data: { a: 1, b: 2 } }, wire: 34, stored: 40 },
      { value: { title: 't', data: ones(5000) }, wire: 10_022, stored: 15_024 },
    ];
    for (const c of cases) {
      expect(wireBytes(c.value)).toBe(c.wire);
      const key = await append(c.value);
      // The literals are the oracle; Postgres is the thing being read.
      await expect(storedSizeOf(key.key)).resolves.toBe(c.stored);
      expect(c.stored).toBeGreaterThan(c.wire);
    }
    // The dense case is a RATIO, which is what makes the sequence below compound.
    // 🔴 Computed from what Postgres ACTUALLY STORED and what JSON.stringify actually
    // produced, never from the literals above — `expect(15_024 / 10_022)` is arithmetic
    // on two constants and cannot fail, which is the worst kind of line to leave in the
    // test labelled "the positive control for this whole file". The threshold is well
    // under the measured 1.4991x so an unrelated jsonb formatting change does not fail
    // this for no reason.
    const dense = cases[2];
    const denseKey = await append(dense.value);
    const denseStored = await storedSizeOf(denseKey.key);
    const denseWire = wireBytes(dense.value);
    expect(denseStored / denseWire).toBeGreaterThan(1.4);

    // …and the shape where the gap is a CONSTANT, so "stored is bigger" is not
    // mistaken for the claim. A title-only value differs by exactly the one `: `
    // jsonb writes after the single key — one byte, however long the title — which
    // is precisely why a title-only fixture cannot see this class: there is no ratio
    // for a wire-bounded rewrite to compound.
    for (const title of ['hello', 'a considerably longer title than that one']) {
      const key = await append({ title });
      await expect(storedSizeOf(key.key)).resolves.toBe(wireBytes({ title }) + 1);
    }
  });

  /**
   * 🔴 THE APPEND REGRESSION, pinned at the exact boundary.
   *
   * The boundary is the oracle for the gate's UNIT: at `used_bytes = CAP − stored`
   * the write must be accepted (the gate is `used + stored > CAP`, false on
   * equality), and one byte above that it must be refused. A gate holding the WIRE
   * size accepts BOTH, because the wire size of this fixture is ~2/3 of its stored
   * size — so the refusal arm cannot be satisfied in the wrong unit, and the
   * acceptance arm cannot be satisfied by a gate that simply refuses everything.
   *
   * `stored` is measured from the generated column on a real row rather than
   * predicted here, so the expectation is not derived from the implementation.
   */
  it('refuses a create at the STORED-byte boundary, not the wire-byte one', async () => {
    const value: SharedValue = { title: 'boundary', data: ones(2000) };
    const wire = wireBytes(value);

    // Measure what this value stores, using Postgres' own generated column.
    const probe = await append(value);
    const stored = await storedSizeOf(probe.key);
    expect(stored).toBe(6031);
    expect(wire).toBe(4029);
    // The gap is the whole defect: a wire-unit gate under-charges by this much.
    expect(stored).toBeGreaterThan(wire);

    await holder.db.exec(`TRUNCATE ${SCHEMA}.shared_kv CASCADE`);

    // ACCEPTED: the remaining budget is exactly the stored size.
    await seedUsedBytes(APP_QUOTA_BYTES - stored);
    const accepted = await tryAppend(value);
    expect(accepted).not.toBeNull();
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES);

    // REFUSED: one byte less budget. In the WIRE unit this still fits with ~2,000
    // bytes to spare, so a wire-unit gate admits it and the trigger then carries
    // `used_bytes` past the ceiling.
    await holder.db.exec(`TRUNCATE ${SCHEMA}.shared_kv CASCADE`);
    await seedUsedBytes(APP_QUOTA_BYTES - stored + 1);
    expect(APP_QUOTA_BYTES - stored + 1 + wire).toBeLessThan(APP_QUOTA_BYTES);
    const refused = await tryAppend(value);
    expect(refused).toBeNull();
    // Nothing was written, so the counter did not move.
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES - stored + 1);
    await expect(rowCount()).resolves.toBe(0);
  });

  /**
   * 🔴 THE UPDATE REGRESSION, in the shape that actually bites.
   *
   * Each edit here holds the quota delta at or BELOW ZERO in the WIRE unit while
   * multiplying the row's STORED bytes by 46.8x. Under a wire-unit delta the gate's
   * comparison is `used + (wire − storedOld) > CAP` with the parenthesised term
   * negative, so it cannot refuse — and the trigger then charges the real 3.0 MB of
   * growth, carrying `used_bytes` straight past the ceiling.
   *
   * THE FIXTURE IS A HIGH-EXPANSION VALUE SHARED_VALUE_BYTE_CAP ADMITS (see
   * `expansionBomb` — measured at 46.8x, and deliberately not claimed to be the
   * maximum), because that cap is enforced in the wire unit and therefore does not
   * bound stored bytes at all. The all-ones array used elsewhere in this file only
   * reaches 1.5x, which makes it a poor discriminator here: the pre-fix gate
   * self-limits once `used_bytes` passes the cap, since acceptance then requires the
   * negative wire delta to exceed the overrun, and at 1.5x it barely does — measured,
   * that variant separated the two arms by 11 KB where this one separates them by
   * 2.8 MB.
   *
   * No other control stands in the way: the row population never moves (these are all
   * updates, so neither APP_ROW_LIMIT nor SHARED_KV_PER_USER_ROW_CAP is consulted),
   * and the rate limiter is the same daily bucket an honest editor uses. The app byte
   * ceiling is the only thing between this and 3.0 MB of unbudgeted storage per
   * write.
   *
   * The counter is SEEDED near the ceiling rather than walked up to it: the defect is
   * in the delta arithmetic, not in accumulation, and filling 50 MiB honestly would
   * take thousands of moderated writes.
   */
  it('cannot be driven past the app byte ceiling by wire-non-increasing edits', async () => {
    const ROWS = 4;
    // Enough for exactly ONE honest bomb (whose stored delta is 3,003,424) and not
    // two, so the accepted-control below is satisfiable by a correct gate and the
    // second write is the one that has to be refused.
    const HEADROOM = 3_200_000;

    // Seed real rows, each climbed just past the wire cap in STORED bytes so a
    // cap-maximal bomb is wire-non-increasing against it. 22,000 ones is 44,026 wire
    // bytes — comfortably inside the wire cap — and stores 66,028.
    const keys: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      keys.push((await append({ title: 'climb', data: ones(22_000) })).key);
    }
    for (const key of keys) await expect(storedSizeOf(key)).resolves.toBe(66_028);
    const seededRowBytes = await recomputedBytes();
    const baseline = APP_QUOTA_BYTES - HEADROOM;
    await seedUsedBytes(baseline);

    let accepted = 0;
    let refused = 0;
    for (const key of keys) {
      const storedBefore = await storedSizeOf(key);
      const bomb = expansionBomb('climb', storedBefore);
      // The attack's preconditions, asserted rather than assumed.
      expect(wireBytes(bomb)).toBe(65_532);
      expect(wireBytes(bomb)).toBeLessThanOrEqual(SHARED_VALUE_BYTE_CAP);
      // In the WIRE unit this edit SHRINKS the row, so the pre-fix delta is negative.
      expect(wireBytes(bomb)).toBeLessThan(storedBefore);
      if (await tryUpdate(key, bomb)) accepted++;
      else refused++;
    }

    // Positive control: a correct gate still accepts the one write that fits. Without
    // it, an implementation that refused everything would satisfy the ceiling
    // assertion below for the wrong reason.
    expect(accepted).toBeGreaterThan(0);
    // …and the 46.8x expansion really happened on an accepted row, so the ceiling
    // assertion is about real stored bytes.
    const grown = await recomputedBytes();
    expect(grown - seededRowBytes).toBeGreaterThan(2_900_000);

    const used = await usedBytes();
    // The counter agrees with an independent recompute over the rows, so this is
    // stored data and not counter drift. The seeded offset is the only term that is
    // not row-derived, and it is constant.
    await expect(recomputedBytes()).resolves.toBe(seededRowBytes + (used - baseline));

    // 🔴 THE CLAIM, asserted before the remaining controls so a regression fails with
    // the actual overrun in the message rather than with a control's `0 > 0`.
    // MEASURED, both arms, on this exact sequence. Pre-fix (wire-unit delta): TWO
    // bombs accepted, `used_bytes` 55,235,648 against the 52,428,800-byte ceiling —
    // 2,806,848 bytes over, from writes the gate was structurally unable to refuse.
    // Post-fix: ONE bomb accepted (the one that fits), three refused, 52,232,224.
    // ⚠️ These four figures move together with `expansionBomb` and `HEADROOM`. An
    // earlier revision carried the pair from the `1e308` / 3,000,000 configuration
    // (55,117,476 / 2,688,676 / 52,273,138) after the fixture was swapped, and nothing
    // went red because all the assertions here are thresholds. Re-measure them, do not
    // adjust them by hand.
    expect(used).toBeLessThanOrEqual(APP_QUOTA_BYTES);
    // …and it genuinely pressed against the ceiling rather than stopping early for
    // some unrelated reason: most of the seeded headroom was consumed.
    expect(used).toBeGreaterThan(baseline + HEADROOM / 2);
    // The gate has to have actually said no. Without this the assertion above is also
    // satisfied by a sequence that simply never grew.
    expect(refused).toBeGreaterThan(0);
    // The row population never moved: these were all updates, so no row gate could
    // have been what stopped it.
    await expect(rowCount()).resolves.toBe(ROWS);
  });

  /**
   * The direction of the comparison, so the ceiling guard above cannot be satisfied
   * by an implementation that simply refuses every edit — and so the fix is pinned as
   * a change of UNIT rather than a change of policy.
   *
   * Both arms are stated in STORED bytes against a real row, which the fixture suite
   * cannot do: a shrink of 6,000 stored bytes is only ~4,000 wire bytes, so a
   * wire-unit gate would compute a different (smaller) reclaim and the thresholds
   * below would not land where they do.
   *
   * The non-increasing exemption's own killing test is the next one; this one is about
   * the growth arm, from a counter already over the ceiling.
   */
  it('accepts a shrinking edit that reclaims enough, and refuses a growing one', async () => {
    const key = (await append({ title: 'shrink', data: ones(3000) })).key;
    const before = await storedSizeOf(key);
    expect(before).toBe(9029);

    // Drive the counter just over the ceiling directly, the way a drifted counter or
    // a lowered cap would, without needing 50 MiB of rows.
    const over = APP_QUOTA_BYTES + 2_000;

    // ACCEPTED: the stored shrink is 6,000 bytes, which clears the 2,000-byte
    // overrun. In the WIRE unit the same edit reclaims only ~4,000 — still enough
    // here, which is why the refusal arm below is the one that pins the unit.
    await seedUsedBytes(over);
    expect(await tryUpdate(key, { title: 'shrink', data: ones(1000) })).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(3029);
    await expect(usedBytes()).resolves.toBe(over - 6_000);

    // REFUSED: a real growth from the same over-ceiling state.
    await seedUsedBytes(over);
    expect(await tryUpdate(key, { title: 'shrink', data: ones(5000) })).toBe(false);
    // …and the refused write left the row untouched.
    await expect(storedSizeOf(key)).resolves.toBe(3029);
    await expect(usedBytes()).resolves.toBe(over);
  });

  /**
   * 🔴 THE TRAP THE UNIT FIX WOULD OTHERWISE OPEN, and the reason the
   * `isNonIncreasing` exemption on the update path is part of that fix rather than a
   * separate policy change.
   *
   * An app whose `quota.used_bytes` already sits above the ceiling — from a lowered
   * cap, from trigger drift, or from the pre-fix bypass this commit closes — makes
   * `used + netDelta > CAP` true for a SHRINK and for a NO-OP RE-SAVE as well as for a
   * growth. Without the exemption the one action that reduces the counter is the action
   * refused, and the only exit left is `withdraw`, which deletes the row and cascades
   * its votes, counters and reports.
   *
   * ⚠️ MEASURED AT BOTH COMMITS, because the obvious story is wrong in a way worth
   * recording. The old delta was `wireNew − storedOld`, and on a separator-dense value
   * the wire term is ~2/3 of the stored term, so a no-op re-save computed roughly −⅓ of
   * the row — an accidental credit that let the write through a gate that should have
   * refused it. That credit is bounded by the row, so it covered only a SMALL overrun:
   *
   *   - at `CAP + 2_000` the pre-fix gate ACCEPTED a no-op re-save (credit −3,000
   *     against a 2,000 overrun), and the unit fix WITHOUT this exemption refuses it —
   *     a regression the fix would have introduced. Pinned as arm (a) below.
   *   - at the `CAP + 5_000_000` used for arms (b) and (c), the credit is nowhere near
   *     enough and the pre-fix gate refused too — a PRE-EXISTING trap, which this
   *     exemption also fixes.
   *
   * So this test is red at `c4b553af79` (the pre-fix base) as well, and it is not purely
   * a guard against a regression this commit introduces.
   *
   * WARNING: EVERY REF HERE IS NAMED BY SHA, because a relative word gets this wrong. An
   * earlier revision of this very paragraph said "this commit's parent" for the
   * no-exemption tree; by the time it landed the parent WAS the exemption commit, and
   * the sentence was false. Measured, per ref:
   *   - `c4b553af79` (no unit fix)               -> arm (b) fails, arm (a) passes;
   *   - `84994429f8` (unit fix, no exemption)    -> arm (a) fails, the regression reading;
   *   - `862452e9ac` onward (with the exemption) -> all three arms pass.
   *
   * So both readings are true, at different overrun sizes, and neither alone describes
   * this test. Removing the exemption, or narrowing it from `netDelta <= 0` to `< 0`,
   * each make arm (a) fail — so (a) and (b) have distinct killing conditions and both
   * are load-bearing.
   */
  it('lets an over-ceiling app re-save and shrink, including when the reclaim is too small', async () => {
    const key = (await append({ title: 'trap', data: ones(3000) })).key;
    const stored = await storedSizeOf(key);
    expect(stored).toBe(9027);

    // Far enough over that no realistic single reclaim could clear it, so neither
    // acceptance in (b) can be explained by the delta arithmetic alone.
    const wayOver = APP_QUOTA_BYTES + 5_000_000;
    // Small enough that the pre-fix wire-unit credit (~-3,000 on this row) covered it,
    // which is what makes arm (a) the regression-shaped one. See the docstring.
    const slightlyOver = APP_QUOTA_BYTES + 2_000;

    // (a) EXACT NO-OP at a SMALL overrun: byte-identical content, netDelta === 0. 3,000
    // twos is the same length as 3,000 ones in both units, so this is a real rewrite
    // rather than a skipped write, and the stored size is unchanged. This is the arm
    // the two mutations named in the docstring kill.
    await seedUsedBytes(slightlyOver);
    const twos = Array.from({ length: 3000 }, () => 2);
    expect(await tryUpdate(key, { title: 'trap', data: twos })).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(stored);
    await expect(usedBytes()).resolves.toBe(slightlyOver);

    // (b) A SHRINK FAR TOO SMALL to clear a 5 MB overrun — 6,000 stored bytes against
    // it — which the unconditional comparison would refuse. It must be accepted, and
    // the counter must move DOWN by the stored reclaim.
    await seedUsedBytes(wayOver);
    expect(await tryUpdate(key, { title: 'trap', data: ones(1000) })).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(3027);
    await expect(usedBytes()).resolves.toBe(wayOver - 6_000);

    // (c) 🔴 The exemption must NOT be a blanket "updates always pass": a GROWTH from
    // the same over-ceiling state is still refused. Without this arm, deleting the
    // whole gate also satisfies (a) and (b).
    await seedUsedBytes(wayOver);
    expect(await tryUpdate(key, { title: 'trap', data: ones(5000) })).toBe(false);
    await expect(storedSizeOf(key)).resolves.toBe(3027);
    await expect(usedBytes()).resolves.toBe(wayOver);
  });

  /**
   * 🔴 THE UPDATE GATE'S OWN BOUNDARY, WITH THE EXEMPTION IN PLACE — and the reason
   * this test exists at all is a trap worth recording.
   *
   * Before the `isNonIncreasing` exemption was added, the `>` in the update gate was
   * killed by the same-STORED-size test below: that write has `netDelta === 0`, so
   * tightening `>` to `>=` refused it. The exemption now short-circuits the gate for
   * `netDelta <= 0`, which means that write NO LONGER REACHES the comparison — the
   * mutation became UNREACHABLE and `>` → `>=` SURVIVED the whole suite. Verified by
   * running that mutant against the suite as it then stood — this file's 6 tests plus
   * the fixture file's 146 — which is **152/152 green**. (An earlier revision said
   * 153/153; that was an intermediate state during the same session, not the baseline,
   * and the fixture file's own docstring says 152. The configuration matters more than
   * the number: the mutant survives whenever the only `netDelta === 0` case is the
   * same-stored-size test, because the exemption short-circuits ahead of it.)
   *
   * So the boundary needs a case with `netDelta > 0` — one the exemption cannot
   * swallow — landing `used + netDelta` exactly ON the cap. The gate is `>`, so
   * equality must be ACCEPTED, and one byte less headroom must be REFUSED.
   *
   * The generalisable bit: adding a short-circuit in front of a comparison can make an
   * existing test stop exercising it while staying green. The guard that was killed
   * yesterday is not necessarily the guard that is killed today.
   */
  it('accepts a growing edit that lands exactly on the cap, and refuses one byte more', async () => {
    const key = (await append({ title: 'edge', data: ones(1000) })).key;
    const small = await storedSizeOf(key);
    expect(small).toBe(3027);

    // Measure the grown row's stored size the only way that is not a prediction:
    // append it, read the generated column, roll it back.
    const grown: SharedValue = { title: 'edge', data: ones(3000) };
    const probeKey = (await append(grown)).key;
    const grownStored = await storedSizeOf(probeKey);
    await holder.db.query(`DELETE FROM ${SCHEMA}.shared_kv WHERE key = $1`, [probeKey]);
    expect(grownStored).toBe(9027);

    const netDelta = grownStored - small;
    expect(netDelta).toBe(6_000);
    // The exemption must not apply here, or this test cannot see the comparison.
    expect(netDelta).toBeGreaterThan(0);

    // ACCEPTED at exactly the cap: `used + netDelta === CAP` is not `> CAP`.
    await seedUsedBytes(APP_QUOTA_BYTES - netDelta);
    expect(await tryUpdate(key, grown)).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(grownStored);
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES);

    // REFUSED one byte over. Reset the row to its small size first — through the
    // router, so the counter stays consistent with the rows.
    await seedUsedBytes(0);
    expect(await tryUpdate(key, { title: 'edge', data: ones(1000) })).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(small);
    await seedUsedBytes(APP_QUOTA_BYTES - netDelta + 1);
    expect(await tryUpdate(key, grown)).toBe(false);
    await expect(storedSizeOf(key)).resolves.toBe(small);
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES - netDelta + 1);
  });

  /**
   * The ONE structural claim the new SQL shape makes about itself, which nothing else
   * in the tree exercises: the probe is selected WITHOUT a FROM clause, as a sibling of
   * scalar subqueries over `quota`, so it returns exactly one row whether or not the
   * app has a quota row — preserving the pre-existing "missing quota row counts as 0"
   * behaviour rather than turning it into a hard failure.
   *
   * The provisioner seeds that row with `ON CONFLICT DO NOTHING` and `beforeEach`
   * re-provisions, so the row always exists in every other test here. Delete it and the
   * write must still be ACCEPTED (treated as 0 used bytes), not throw. A `FROM quota`
   * column would return zero rows and `requireStoredSize` would raise.
   */
  it('still accepts a write when the app has no quota row at all', async () => {
    await holder.db.query(`DELETE FROM ${SCHEMA}.quota WHERE app_block_id = $1`, [APP_BLOCK_ID]);
    await expect(
      scalar(`SELECT count(*) FROM ${SCHEMA}.quota WHERE app_block_id = $1`, [APP_BLOCK_ID])
    ).resolves.toBe(0);

    // Accepted on both write paths, and neither raises the probe's hard error.
    const key = (await append({ title: 'no-quota-row', data: ones(100) })).key;
    await expect(storedSizeOf(key)).resolves.toBe(335);
    await expect(update(key, { title: 'no-quota-row', data: ones(200) })).resolves.toEqual({
      ok: true,
    });
    await expect(storedSizeOf(key)).resolves.toBe(635);

    // The trigger's UPDATE matched no counter row, which is the pre-existing
    // accept-and-drift behaviour this shape preserves — asserted so a future change to
    // it is visible rather than silent.
    await expect(rowCount()).resolves.toBe(1);
    await expect(
      scalar(`SELECT count(*) FROM ${SCHEMA}.quota WHERE app_block_id = $1`, [APP_BLOCK_ID])
    ).resolves.toBe(0);
  });

  /**
   * 🔴 THE REFUSAL THAT ONLY THE STORED UNIT PRODUCES, isolated from the walk so the
   * unit has a killing test that needs no loop.
   *
   * One single edit, from a counter 5,000 bytes under the ceiling, growing a row from
   * 3,029 to 9,029 stored bytes:
   *   - stored delta  = +6,000  → over the remaining 5,000 → REFUSED (correct);
   *   - wire   delta  = 6,027 − 2,027 = +4,000 → inside the remaining 5,000 → the
   *     pre-fix gate ACCEPTED it, and the trigger then charged the true 6,000,
   *     carrying `used_bytes` 1,000 bytes past the ceiling in one write.
   *
   * The wire delta here is POSITIVE, so this case is not covered by the walk's
   * non-increasing trick — it is the plain under-charge, and it dies only to a
   * stored-unit comparison.
   */
  it('refuses a single growth whose wire delta fits and whose stored delta does not', async () => {
    const key = (await append({ title: 'shrink', data: ones(1000) })).key;
    expect(await storedSizeOf(key)).toBe(3029);

    const grown: SharedValue = { title: 'shrink', data: ones(3000) };
    // The two deltas, both MEASURED. 🔴 The stored side is read back from Postgres on a
    // throwaway row rather than written as `9_029 - 3_029`: that subtraction is
    // arithmetic on two literals, cannot fail, and sat under a comment claiming it was
    // measured. The grown row never exists in this test — the write under test is
    // refused — so the only way to measure its stored size is to append it, read the
    // generated column, and roll it back.
    const wireDelta = wireBytes(grown) - wireBytes({ title: 'shrink', data: ones(1000) });
    expect(wireDelta).toBe(4_000);
    const probeKey = (await append(grown)).key;
    const grownStored = await storedSizeOf(probeKey);
    await holder.db.query(`DELETE FROM ${SCHEMA}.shared_kv WHERE key = $1`, [probeKey]);
    const storedDelta = grownStored - 3_029;
    expect(storedDelta).toBe(6_000);

    const remaining = 5_000;
    expect(wireDelta).toBeLessThan(remaining);
    expect(storedDelta).toBeGreaterThan(remaining);

    await seedUsedBytes(APP_QUOTA_BYTES - remaining);
    expect(await tryUpdate(key, grown)).toBe(false);
    await expect(storedSizeOf(key)).resolves.toBe(3029);
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES - remaining);
  });

  /**
   * A rewrite to the same STORED size (`netDelta === 0`) at a counter sitting exactly
   * on the cap must be allowed.
   *
   * ⚠️ THIS IS AN INVARIANT GUARD, NOT A BOUNDARY TEST — and its docstring used to
   * claim otherwise, which is why the correction is spelled out rather than quietly
   * applied. It was written before the `isNonIncreasing` exemption existed, when
   * `netDelta === 0` still reached the comparison and tightening `> CAP` to `>= CAP`
   * refused this write. The exemption now short-circuits ahead of the comparison, so
   * this test no longer exercises it at all: measured, NONE of `> CAP` -> `>= CAP`,
   * removing `!isNonIncreasing &&`, or `netDelta <= 0` -> `< 0` makes this test fail —
   * each is killed by one of the two tests above instead.
   *
   * What it still pins is worth keeping: that a same-size rewrite is accepted at the
   * cap, on a value whose wire and stored sizes differ. The gate's `>` boundary is
   * pinned by `accepts a growing edit that lands exactly on the cap`, which uses a
   * `netDelta > 0` case the exemption cannot swallow.
   */
  it('allows a rewrite to the same STORED size when the app is at its ceiling', async () => {
    const key = (await append({ title: 'same', data: ones(2000) })).key;
    const stored = await storedSizeOf(key);
    expect(stored).toBe(6027);
    await seedUsedBytes(APP_QUOTA_BYTES);

    // 2,000 twos: same length in both units as 2,000 ones, so stored is unchanged.
    const twos = Array.from({ length: 2000 }, () => 2);
    expect(await tryUpdate(key, { title: 'same', data: twos })).toBe(true);
    await expect(storedSizeOf(key)).resolves.toBe(stored);
    await expect(usedBytes()).resolves.toBe(APP_QUOTA_BYTES);
  });
});
