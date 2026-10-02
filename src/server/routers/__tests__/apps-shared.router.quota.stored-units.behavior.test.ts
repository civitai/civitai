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
 *      WIRE unit cannot push `quota.used_bytes` past the ceiling — using the
 *      highest-expansion value the wire cap admits (44.4x), which is what makes the
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

const { mockVerifyBlockToken, mockIsRevoked } = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockIsRevoked: vi.fn(async () => false),
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
  BlockRevocation: { isRevoked: (...args: unknown[]) => mockIsRevoked(...args) },
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
 * `data` is the opaque, unmoderated half of the value, so it can carry an arbitrary
 * JSON shape without the content-safety belt having an opinion about it.
 */
const ones = (n: number) => Array.from({ length: n }, () => 1);
const wireBytes = (value: SharedValue) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The HIGHEST-EXPANSION value SHARED_VALUE_BYTE_CAP admits, whose whole-value wire
 * size is also at most `wireLimit`.
 *
 * `JSON.stringify(1e308)` is `1e+308` — six bytes plus a comma — while jsonb
 * normalises the same number to its full 309-digit decimal expansion plus `, `. So
 * the wire cap, which is enforced in the wire unit, admits a value that stores 44.4x
 * what it sent. That is why a wire-unit quota term is not merely imprecise: a single
 * accepted write can add megabytes to a counter the gate thought it was holding flat.
 *
 * Solved rather than searched — the wire size is linear in the element count — and
 * the result is asserted at the call site rather than trusted.
 */
function expansionBomb(title: string, wireLimit: number): SharedValue {
  const base = wireBytes({ title, data: [] as unknown });
  const perElement = Buffer.byteLength(`${JSON.stringify(1e308)},`, 'utf8');
  const ceiling = Math.min(wireLimit, SHARED_VALUE_BYTE_CAP);
  const n = Math.max(1, Math.floor((ceiling - base) / perElement));
  return { title, data: Array.from({ length: n }, () => 1e308) };
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
    // The dense case is a RATIO, which is what makes the walk below compound. The
    // threshold is deliberately well under the measured 1.4991x so an unrelated
    // jsonb formatting change does not fail this for no reason.
    expect(15_024 / 10_022).toBeGreaterThan(1.4);

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
   * multiplying the row's STORED bytes by 44.4x. Under a wire-unit delta the gate's
   * comparison is `used + (wire − storedOld) > CAP` with the parenthesised term
   * negative, so it cannot refuse — and the trigger then charges the real 2.84 MB of
   * growth, carrying `used_bytes` straight past the ceiling.
   *
   * THE FIXTURE IS THE HIGHEST-EXPANSION VALUE SHARED_VALUE_BYTE_CAP ADMITS, because
   * that cap is enforced in the wire unit and therefore does not bound stored bytes
   * at all: 9,358 copies of `1e308` serialize to 65,532 wire bytes (JSON.stringify
   * writes `1e+308`, six bytes) and store 2,910,366, because jsonb normalises each
   * element to its full 309-digit decimal expansion. Measured, not assumed — the
   * ratio is asserted below. The all-ones array used elsewhere in this file only
   * reaches 1.5x, which makes it a poor discriminator here: the pre-fix gate
   * self-limits once `used_bytes` passes the cap, since acceptance then requires the
   * negative wire delta to exceed the overrun, and at 1.5x it barely does.
   *
   * No other control stands in the way: the row population never moves (these are all
   * updates, so neither APP_ROW_LIMIT nor SHARED_KV_PER_USER_ROW_CAP is consulted),
   * and the rate limiter is the same daily bucket an honest editor uses. The app byte
   * ceiling is the only thing between this and 2.84 MB of unbudgeted storage per
   * write.
   *
   * The counter is SEEDED near the ceiling rather than walked up to it: the defect is
   * in the delta arithmetic, not in accumulation, and filling 50 MiB honestly would
   * take thousands of moderated writes.
   */
  it('cannot be driven past the app byte ceiling by wire-non-increasing edits', async () => {
    const ROWS = 4;
    // Enough for exactly ONE honest bomb, so the accepted-control below is satisfiable
    // by a correct gate and the second write is the one that has to be refused.
    const HEADROOM = 3_000_000;

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
    // …and the 44.4x expansion really happened on an accepted row, so the ceiling
    // assertion is about real stored bytes.
    const grown = await recomputedBytes();
    expect(grown - seededRowBytes).toBeGreaterThan(2_800_000);

    const used = await usedBytes();
    // The counter agrees with an independent recompute over the rows, so this is
    // stored data and not counter drift. The seeded offset is the only term that is
    // not row-derived, and it is constant.
    await expect(recomputedBytes()).resolves.toBe(seededRowBytes + (used - baseline));

    // 🔴 THE CLAIM, asserted before the remaining controls so a regression fails with
    // the actual overrun in the message rather than with a control's `0 > 0`.
    // MEASURED, both arms, on this exact sequence. Pre-fix (wire-unit delta): TWO
    // bombs accepted, `used_bytes` 55,117,476 against the 52,428,800-byte ceiling —
    // 2,688,676 bytes over, from writes the gate was structurally unable to refuse.
    // Post-fix: ONE bomb accepted (the one that fits), three refused, 52,273,138.
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
   * ⚠️ NOTE WHAT THIS DOES *NOT* SAY, because the per-user path differs here and the
   * difference is easy to misread as a bug in this test. `app-storage.service`'s
   * `set` carries an explicit non-increasing EXEMPTION: a write with `netDelta <= 0`
   * skips its byte ceilings outright, so a shrink is accepted from ANY counter value.
   * This path has no such exemption — it evaluates `used + delta > CAP` unconditionally
   * — so from an over-ceiling counter a shrink is accepted only if it is large enough
   * to land back under the cap. That is pre-existing behaviour, unchanged by the unit
   * fix, and pinned here as what the code does rather than as what it should do.
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
    // The two deltas, measured rather than asserted in prose.
    const wireDelta = wireBytes(grown) - wireBytes({ title: 'shrink', data: ones(1000) });
    expect(wireDelta).toBe(4_000);
    const storedDelta = 9_029 - 3_029;
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
   * The boundary of the delta comparison. A rewrite to the same STORED size is
   * `delta === 0` and must be allowed; pinned separately so tightening the gate from
   * `> CAP` to `>= CAP` has its own killing test rather than dying to a neighbouring
   * assertion — and pinned on a value whose wire and stored sizes differ, so it also
   * fails if the boundary is evaluated in the wrong unit.
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
