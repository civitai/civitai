import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) and driving a few hundred writes through it can
// exceed the default 10s hook/test timeouts on a contended runner. Relaxing them
// can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

/**
 * THE SEAM BETWEEN THE ROUTER'S QUOTA ARITHMETIC AND THE BYTES POSTGRES ACTUALLY
 * STORES.
 *
 * 🔴 WHY THIS FILE EXISTS AS A THIRD SUITE. The two existing suites are split
 * exactly at the defect, and each is individually green and individually blind:
 *
 *   - `apps.router.storage.test.ts` drives the real `set` gate, but its pool is a
 *     mock and it SUPPLIES `size_bytes` from fixtures (61_440, 1_002, 5_000).
 *     Every fixture value it supplies happens to be in the same unit as
 *     `Buffer.byteLength(JSON.stringify(v))`, so the gate is never handed a real
 *     jsonb size and the unit mismatch is unreachable from there.
 *   - `storage-provision.trigger.behavior.test.ts` runs the provisioner's own DDL
 *     on real Postgres and meets real `size_bytes`, but it writes rows with raw
 *     SQL and never executes the router's gate.
 *
 * Neither ever builds the combined state, so the class was invisible to both.
 * This suite builds it: the provisioner's own unmodified DDL, generated column
 * and trigger on an in-process Postgres, with the REAL `apps.storage.set`
 * procedure driving it through a PGlite-backed pool.
 *
 * WHAT THE GUARD PINS. Not one side of the comparison — the RELATIONSHIP between
 * the two units:
 *
 *   1. the size the router predicts for a write equals the `size_bytes` Postgres
 *      actually stores for that row, on values where the wire size DIFFERS (the
 *      positive control: a scalar-only fixture cannot see this class at all,
 *      because `null` and `"hello"` are byte-identical in both units);
 *   2. an unbounded sequence of writes that each hold `netDelta <= 0` in the WIRE
 *      unit cannot push a stored-byte counter past its ceiling.
 *
 * (2) is the deploy-blocking regression this file was written for. With the gate
 * computing `Buffer.byteLength(JSON.stringify(value)) - kv.size_bytes`, a client
 * that writes, on every pass, the largest value whose WIRE size is <= the row's
 * current STORED size holds the computed delta at or below zero forever while the
 * stored bytes grow ~1.5x per pass. The non-increasing exemption then skipped BOTH
 * byte ceilings on every one of those writes and neither ever bound.
 *
 * THE ORACLE IS NOT THE ROUTER. Every expectation is either a literal, or
 * Postgres' own `sum(size_bytes)` recompute over `kv` — a different mechanism
 * (recompute) from the one under test (incremental maintenance through a gate).
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
    return await holder.db.query(sql, params as unknown[]);
  }
  const results = await holder.db.exec(sql);
  return results[results.length - 1] ?? { rows: [] };
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

const { mockVerifyBlockToken, mockDbRead, mockIsRevoked, mockLogToAxiom } = vi.hoisted(() => ({
  mockVerifyBlockToken: vi.fn(),
  mockDbRead: {
    appBlock: { findUnique: vi.fn() },
    appBlockPublishRequest: { findUnique: vi.fn() },
  },
  mockIsRevoked: vi.fn(async () => false),
  // Spied, not silenced: the `set` log's `storedBytes` is the only place the
  // router's OWN predicted stored size is observable from outside. Without it a
  // test can only read `kv.size_bytes` and the trigger-maintained counter, both
  // of which are computed by Postgres and are therefore identical whether the
  // router predicted correctly or not — measured, a mutant that dropped the
  // `::jsonb` cast from the probe survived every assertion built on those two.
  mockLogToAxiom: vi.fn(async () => undefined),
}));

// Everything that is NOT the storage arithmetic or the database is stubbed. In
// particular `~/server/services/apps/storage-provision.service` is deliberately
// NOT mocked — this suite runs the provisioner for real, which is the whole
// point: the DDL, the generated column and the trigger under test are the
// shipped ones, not a transcription.
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => fakePool }));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (sub: string) => (sub === 'anon' ? null : Number(String(sub).split(':')[1])),
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: async () => true,
  isAppBlocksAuthorEnabled: async () => true,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async (id: number) => ({ id, isModerator: true }) },
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: async (id: number) => ({ id, isModerator: true }),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...args: unknown[]) => mockIsRevoked(...args) },
}));
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: async () => undefined,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => mockLogToAxiom(...(args as [])),
}));

const { appsRouter } = await import('../apps.router');
const { AppStorageProvisioner } = await import('~/server/services/apps/storage-provision.service');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');

// `sanitizeAppSlug` folds the token's blockId to `[a-z0-9_]`, so this blockId
// resolves to schema "app_stored_unit_probe".
const BLOCK_ID = 'stored-unit-probe';
const SCHEMA = '"app_stored_unit_probe"';
const APP_BLOCK_ID = 'apb_stored_unit_probe';
const INSTANCE = 'mbi_stored_unit_probe';
const USER_ID = 4242;

// Mirrors of the router's private constants. Deliberately re-declared as literals
// rather than imported: a test that imports the constant it asserts against
// cannot see the constant moving, and these are the ceilings the walk below has
// to actually cross.
const USER_QUOTA_BYTES = 2 * 1024 * 1024;
const PER_VALUE_BYTE_CAP = 64 * 1024;

function claims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${USER_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti_stored_unit_probe',
    blockId: BLOCK_ID,
    appId: 'app_stored_unit_probe',
    blockInstanceId: INSTANCE,
    ctx: {},
    scopes: ['apps:storage:read', 'apps:storage:write'],
  };
}

function ctx() {
  return {
    acceptableOrigin: true,
    user: { id: USER_ID, isModerator: true, tier: 'free' },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

/** One `storage.set` through the real router against the real database. */
async function set(key: string, value: unknown) {
  mockVerifyBlockToken.mockResolvedValueOnce(claims());
  const caller = appsRouter.createCaller(ctx() as never);
  return await caller.storage.set({ blockToken: 't', key, value });
}

/** `true` if the write was accepted, `false` if a ceiling refused it. */
async function trySet(key: string, value: unknown): Promise<boolean> {
  try {
    await set(key, value);
    return true;
  } catch (err) {
    const message = (err as { message?: string }).message ?? '';
    if (/quota exceeded|row limit exceeded/.test(message)) return false;
    throw err;
  }
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const res = params.length > 0 ? await holder.db.query(sql, params) : await holder.db.exec(sql);
  const rows = Array.isArray(res) ? res[res.length - 1].rows : res.rows;
  return Number(Object.values((rows as Record<string, unknown>[])[0])[0]);
}

/** The trigger-maintained per-user counter. */
const userUsedBytes = () =>
  scalar(
    `SELECT used_bytes FROM ${SCHEMA}.user_quota WHERE app_block_id = $1 AND user_id = $2`,
    [APP_BLOCK_ID, USER_ID]
  );

/** The same quantity recomputed from the rows — a different mechanism. */
const recomputedBytes = () =>
  scalar(`SELECT COALESCE(sum(size_bytes), 0) FROM ${SCHEMA}.kv WHERE user_id = $1`, [USER_ID]);

const storedSizeOf = (key: string) =>
  scalar(
    `SELECT size_bytes FROM ${SCHEMA}.kv
      WHERE block_instance_id = $1 AND user_id = $2 AND key = $3`,
    [INSTANCE, USER_ID, key]
  );

/** An array of `n` ones. Wire size is `2n + 1`; Postgres stores `3n`. */
const ones = (n: number) => Array.from({ length: n }, () => 1);
const wireBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.waitReady;
});

beforeEach(async () => {
  mockVerifyBlockToken.mockReset();
  mockLogToAxiom.mockClear();
  mockIsRevoked.mockReset();
  mockIsRevoked.mockResolvedValue(false);
  mockDbRead.appBlock.findUnique.mockReset();
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: APP_BLOCK_ID, status: 'approved' });
  mockDbRead.appBlockPublishRequest.findUnique.mockReset();
  mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({ status: 'pending' });

  // Real DDL, real generated column, real trigger. Idempotent, so re-provisioning
  // per test is safe; the tables are truncated so each test starts from zero.
  await AppStorageProvisioner.provision({ appBlockId: APP_BLOCK_ID, slug: 'stored_unit_probe' });
  await holder.db.exec(`TRUNCATE ${SCHEMA}.kv, ${SCHEMA}.user_quota`);
  await holder.db.exec(
    `UPDATE ${SCHEMA}.quota SET used_bytes = 0, row_count = 0 WHERE app_block_id = '${APP_BLOCK_ID}'`
  );
});

describe('storage.set quota arithmetic vs the bytes Postgres stores', () => {
  /**
   * The positive control for this whole file. If the two units agreed, the walk
   * below would be vacuous — so establish, against the real database, that they
   * disagree and by how much, before asserting anything about the gate.
   *
   * Values are chosen pairwise-distinct in BOTH units and none of them equals a
   * ceiling or a fixture size used elsewhere, so no assertion here can be
   * satisfied by the wrong quantity.
   */
  it('stores MORE bytes than JSON.stringify produces, for separator-dense values', async () => {
    const cases: Array<{ value: unknown; wire: number; stored: number }> = [
      { value: [1, 2, 3], wire: 7, stored: 9 },
      { value: { a: 1, b: 2 }, wire: 13, stored: 16 },
      { value: ones(5000), wire: 10_001, stored: 15_000 },
    ];
    for (const [i, c] of cases.entries()) {
      expect(wireBytes(c.value)).toBe(c.wire);
      await set(`control_${i}`, c.value);
      // The literal is the oracle; Postgres is the thing being read.
      await expect(storedSizeOf(`control_${i}`)).resolves.toBe(c.stored);
      expect(c.stored).toBeGreaterThan(c.wire);
    }
    // …and the scalars where they agree, so "stored is always bigger" is not
    // mistaken for the claim. `null` and a short string are byte-identical in
    // both units, which is exactly why a scalar-only fixture is blind here.
    await set('control_null', null);
    await expect(storedSizeOf('control_null')).resolves.toBe(wireBytes(null));
    await set('control_str', 'hello');
    await expect(storedSizeOf('control_str')).resolves.toBe(wireBytes('hello'));
  });

  /**
   * The identity the gate's arithmetic rests on: the size the router PREDICTS for
   * a write equals the `size_bytes` Postgres ends up storing for it. Asserted on a
   * value whose wire size differs, so a router charging wire bytes cannot pass.
   *
   * 🔴 READ THE ROUTER'S OWN NUMBER, not the database's. `kv.size_bytes` and the
   * trigger-maintained counter are both computed by Postgres, so they are
   * identical whether the router predicted correctly or not — measured, a mutant
   * that dropped the `::jsonb` cast from the probe (making it measure the wire
   * text) SURVIVED every assertion built on those two, and died only to the walk
   * below. The router's prediction is observable exactly once, as `storedBytes` on
   * the `set` log line, which is why that log is spied rather than silenced.
   *
   * `sizeBytes` on the reply is deliberately the WIRE size — the unit
   * PER_VALUE_BYTE_CAP is enforced in and the unit a block can predict for itself.
   */
  it('predicts exactly what Postgres stores, and reports the wire size separately', async () => {
    const value = ones(3000);
    const wire = wireBytes(value);
    expect(wire).toBe(6001);

    const reply = await set('identity', value);
    // The reply reports wire bytes — the per-value cap's unit.
    expect(reply.sizeBytes).toBe(wire);

    const stored = await storedSizeOf('identity');
    expect(stored).toBe(9000);
    expect(stored).not.toBe(wire);

    // The router's OWN predicted size, against what Postgres actually stored.
    const setLog = mockLogToAxiom.mock.calls
      .map(([payload]) => payload as { event?: string; storedBytes?: number; sizeBytes?: number })
      .find((payload) => payload?.event === 'set');
    expect(setLog).toBeDefined();
    expect(setLog?.storedBytes).toBe(stored);
    expect(setLog?.sizeBytes).toBe(wire);

    // …and the counter moved by the stored size, cross-checked by recompute.
    await expect(userUsedBytes()).resolves.toBe(stored);
    await expect(recomputedBytes()).resolves.toBe(stored);
  });

  /**
   * 🔴 THE REGRESSION. Every write in this walk holds `netDelta <= 0` in the WIRE
   * unit — each pass writes the largest all-ones array whose `JSON.stringify`
   * length is at most the row's CURRENT stored size — while growing the stored
   * bytes ~1.5x per pass. Under a wire-unit `netDelta` the non-increasing
   * exemption fires on every one of them and both byte ceilings are skipped.
   *
   * The per-value cap still binds per value and the row count never moves (these
   * are all updates), so no other gate can stop it: the per-user byte ceiling is
   * the only thing standing between this loop and unbounded storage.
   */
  it('cannot be walked past the per-user byte ceiling by wire-non-increasing writes', async () => {
    const KEYS = 30;
    // Seeded so the whole population starts well inside the ceiling: 30 keys x
    // 6,000 stored bytes = 180,000, under a tenth of the 2 MiB budget. Every seed
    // is an INSERT and is correctly gated either way.
    for (let k = 0; k < KEYS; k++) {
      expect(await trySet(`walk_${k}`, ones(2000))).toBe(true);
    }
    const seeded = await userUsedBytes();
    expect(seeded).toBe(KEYS * 6000);
    expect(seeded).toBeLessThan(USER_QUOTA_BYTES);

    let accepted = 0;
    let refused = 0;
    // 12 passes is comfortably more than the ~8 needed for every key to saturate
    // at the per-value cap; the loop is bounded so a broken gate produces a
    // failed assertion rather than a hang.
    for (let pass = 0; pass < 12; pass++) {
      for (let k = 0; k < KEYS; k++) {
        const key = `walk_${k}`;
        const stored = await storedSizeOf(key);
        // The largest all-ones array whose WIRE size (2n + 1) is <= the row's
        // current STORED size, clamped to the per-value cap. This is the entire
        // attack: in the wire unit the delta is <= 0 every single time.
        const n = Math.min(Math.floor((stored - 1) / 2), Math.floor((PER_VALUE_BYTE_CAP - 1) / 2));
        const value = ones(n);
        expect(wireBytes(value)).toBeLessThanOrEqual(stored);
        expect(wireBytes(value)).toBeLessThanOrEqual(PER_VALUE_BYTE_CAP);
        if (await trySet(key, value)) accepted++;
        else refused++;
      }
    }

    // Positive control: the walk did real work. A walk that refused everything
    // would satisfy the ceiling assertion below for the wrong reason.
    expect(accepted).toBeGreaterThan(0);

    const used = await userUsedBytes();
    // The counter agrees with an independent recompute over the rows, so this is
    // stored data and not counter drift.
    await expect(recomputedBytes()).resolves.toBe(used);
    // 🔴 The claim, asserted before the remaining controls so a regression fails
    // with the actual overrun in the message rather than with a control's `0 > 0`.
    // Measured against the pre-fix router (wire-unit netDelta): this walk reached
    // 2,949,030 stored bytes against the 2,097,152-byte ceiling with `refused`
    // still 0. 2,949,030 is exactly 30 x 98,301, i.e. every key saturated at the
    // per-value cap's stored size — the walk was stopped by the per-value cap and
    // the loop bound, and by no ceiling at all. Scaling the key count scales the
    // overrun linearly; USER_ROW_LIMIT (1,000) puts the reachable figure near
    // 98 MiB for a single account, past APP_QUOTA_BYTES as well.
    expect(used).toBeLessThanOrEqual(USER_QUOTA_BYTES);
    // …and it genuinely pressed against the ceiling rather than stopping early
    // for some unrelated reason.
    expect(used).toBeGreaterThan(USER_QUOTA_BYTES / 2);
    // The gate has to have actually said no. Without this the assertion above is
    // also satisfied by a walk that simply never grew.
    expect(refused).toBeGreaterThan(0);
    // The row population never moved: these were all updates, so no row gate
    // could have been what stopped the walk.
    await expect(scalar(`SELECT count(*) FROM ${SCHEMA}.kv WHERE user_id = $1`, [USER_ID])).resolves.toBe(
      KEYS
    );
  });

  /**
   * The exemption the walk must NOT be fixed by deleting. A user already over the
   * ceiling has to be able to shrink out of it; `storage.delete` being the only
   * exit is a trap the app has to expose an affordance for.
   *
   * Stated in STORED bytes against a real row, which the fixture-fed suite cannot
   * do: the shrink here is a shrink in the unit the counter is in.
   */
  it('still lets an over-ceiling user shrink an existing value, measured in stored bytes', async () => {
    await set('shrink', ones(3000)); // 9,000 stored
    const before = await storedSizeOf('shrink');
    expect(before).toBe(9000);

    // Drive the counter above the ceiling directly, the way a lowered cap or a
    // drifted counter would, without needing 2 MiB of rows.
    await holder.db.query(
      `UPDATE ${SCHEMA}.user_quota SET used_bytes = $3 WHERE app_block_id = $1 AND user_id = $2`,
      [APP_BLOCK_ID, USER_ID, USER_QUOTA_BYTES + 512 * 1024]
    );

    // A genuine shrink in the stored unit: 3,000 stored against 9,000.
    const smaller = ones(1000);
    expect(await trySet('shrink', smaller)).toBe(true);
    await expect(storedSizeOf('shrink')).resolves.toBe(3000);

    // The other half of the same claim: from the same over-ceiling state a real
    // GROWTH is still refused. Without this, deleting the gate outright also
    // passes the assertion above.
    await holder.db.query(
      `UPDATE ${SCHEMA}.user_quota SET used_bytes = $3 WHERE app_block_id = $1 AND user_id = $2`,
      [APP_BLOCK_ID, USER_ID, USER_QUOTA_BYTES + 512 * 1024]
    );
    expect(await trySet('shrink', ones(5000))).toBe(false);
    // …and the refused write left the row untouched.
    await expect(storedSizeOf('shrink')).resolves.toBe(3000);
  });

  /**
   * The boundary. A same-STORED-size rewrite is `netDelta === 0` and must be
   * allowed. Pinned separately so narrowing `<= 0` to `< 0` has its own killing
   * test rather than dying to a neighbouring assertion — and pinned on a value
   * whose wire and stored sizes differ, so it also fails if the boundary is
   * evaluated in the wrong unit.
   */
  it('lets an over-ceiling user rewrite a value to the same STORED size', async () => {
    await set('same', ones(2000));
    await expect(storedSizeOf('same')).resolves.toBe(6000);
    await holder.db.query(
      `UPDATE ${SCHEMA}.user_quota SET used_bytes = $3 WHERE app_block_id = $1 AND user_id = $2`,
      [APP_BLOCK_ID, USER_ID, USER_QUOTA_BYTES + 512 * 1024]
    );
    // 2,000 twos: same length in both units as 2,000 ones, so stored is 6,000.
    const same = Array.from({ length: 2000 }, () => 2);
    expect(await trySet('same', same)).toBe(true);
    await expect(storedSizeOf('same')).resolves.toBe(6000);
  });
});
