import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `apps.mod.userStorage.{preview,purgeApp,purgeAccount}` — the moderator purge
 * path for PER-USER App Storage.
 *
 * ── WHY THIS SUITE USES AN EXECUTING FAKE, NOT `mockResolvedValueOnce` ────────
 * The defects that matter on a destructive path are an over-broad `WHERE`, the
 * wrong schema, and a counter left inconsistent with the rows. None of those is
 * visible to a pool mock that returns a canned row set: such a mock answers the
 * same way whether the `WHERE` names one user or none, so "the target is gone"
 * passes either way and the test cannot see the bug it exists for.
 *
 * So `fakeAppsDb` below holds REAL rows for three users across three schemas and
 * EXECUTES the statements against them. Two consequences, both deliberate:
 *
 *   1. A purge that reaches another user's rows, or another app's schema, makes
 *      a surviving-rows assertion fail — a behavioural red, not a string match.
 *   2. The fake refuses any `DELETE … FROM <schema>.kv` whose `WHERE` clause is
 *      not exactly `user_id = $N`, and then evaluates that predicate with the
 *      REAL bound parameter. It is a declared contract, narrow on purpose: a
 *      mutant that widens the clause (`OR true`), inverts it (`<>`), or drops it
 *      cannot be silently absorbed into "well, the fake deleted something".
 *
 * 🔴 The fake can be wrong in the same direction as the code, which is the known
 * failure mode of fake-tested DB work. What bounds that here: every expected
 * value below is a LITERAL derived from the fixture by hand (the byte totals are
 * sums of distinct primes, so no wrong subset of rows reaches the same number),
 * never read back out of the fake's own aggregate.
 */

const { mockPool, mockClient, fake } = vi.hoisted(() => {
  type KvRow = {
    user_id: number;
    block_instance_id: string;
    key: string;
    size_bytes: number;
    value_md5: string;
    updated_at: Date;
  };
  type SchemaState = {
    kv: KvRow[];
    hasUserQuota: boolean;
    hasSharedKv: boolean;
    sharedAuthors: number[];
    /** keyed `${appBlockId}:${userId}` */
    userQuota: Map<string, { used: number; rows: number }>;
  };

  const fake = {
    schemas: new Map<string, SchemaState>(),
    statements: [] as string[],
    /** Set to a message to make the NEXT `DELETE … .kv` throw (fault injection). */
    failNextKvDelete: null as string | null,
    /** Make `COMMIT` throw — the server may still have applied it. */
    failOnCommit: null as string | null,
    /** Make `ROLLBACK` throw, so its result cannot be confirmed. */
    failOnRollback: null as string | null,
    reset() {
      fake.schemas = new Map();
      fake.statements = [];
      fake.failNextKvDelete = null;
      fake.failOnCommit = null;
      fake.failOnRollback = null;
    },
    addSchema(name: string, init: Partial<SchemaState> = {}) {
      fake.schemas.set(name, {
        kv: [],
        hasUserQuota: true,
        hasSharedKv: true,
        sharedAuthors: [],
        userQuota: new Map(),
        ...init,
      });
    },
    kv(name: string) {
      const s = fake.schemas.get(name);
      if (!s) throw new Error(`fake: no schema ${name}`);
      return s.kv;
    },
    state(name: string) {
      const s = fake.schemas.get(name);
      if (!s) throw new Error(`fake: no schema ${name}`);
      return s;
    },
  };

  /** `FROM "app_x".kv` / `.user_quota` / `.shared_kv` → `app_x`. */
  function schemaOf(sql: string): string {
    const m = sql.match(/"(app_[a-z0-9_]+)"\./);
    if (!m) throw new Error(`fake: no schema in statement: ${sql.slice(0, 120)}`);
    return m[1];
  }

  function rowsFor(sql: string): KvRow[] {
    const s = fake.schemas.get(schemaOf(sql));
    if (!s) throw new Error(`fake: relation does not exist: ${schemaOf(sql)}.kv`);
    return s.kv;
  }

  /**
   * 🔴 BIND ARITY, CHECKED THE WAY POSTGRES CHECKS IT.
   *
   * This exists because a real 500 shipped past this suite. `buildAppView`
   * assembles its statement from fragments, and when a schema has no
   * `user_quota` the fragment carrying `$2` is replaced by a literal `NULL`
   * — so the statement references only `$1` while two parameters are still
   * bound. Postgres rejects that outright:
   *
   *     bind message supplies 2 parameters, but prepared statement "" requires 1
   *
   * The old fake read `params[0]`/`params[1]` positionally and never counted
   * them, so it answered happily and the branch's own test passed. That is
   * fake-wrong-in-the-same-direction as the code — the failure mode this file's
   * header warns about, walked into anyway.
   *
   * Validating arity here kills the whole CLASS rather than the one instance:
   * every statement this service builds conditionally is now checked, and any
   * future fragment that takes a `$n` with it fails loudly in the suite instead
   * of in production. `pg` sends the array as-is, so a count mismatch in EITHER
   * direction is an error, which is what this reproduces.
   */
  function assertBindArity(sql: string, params: unknown[]): void {
    // Ignore `$n` inside string literals — none today, but the check should not
    // become the next thing that is subtly wrong.
    const stripped = sql.replace(/'[^']*'/g, "''");
    const refs = [...stripped.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const required = refs.length ? Math.max(...refs) : 0;
    if (params.length !== required) {
      throw new Error(
        `bind message supplies ${params.length} parameters, but prepared statement "" requires ${required}`
      );
    }
  }

  async function query(sql: string, params: unknown[] = []): Promise<any> {
    fake.statements.push(sql);
    const flat = sql.replace(/\s+/g, ' ').trim();

    if (/^COMMIT$/i.test(flat) && fake.failOnCommit) throw new Error(fake.failOnCommit);
    if (/^ROLLBACK$/i.test(flat) && fake.failOnRollback) throw new Error(fake.failOnRollback);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(flat)) return { rows: [], rowCount: 0 };
    if (/^SET LOCAL/i.test(flat)) return { rows: [], rowCount: 0 };

    assertBindArity(sql, params);

    // ── information_schema shape probe ──────────────────────────────────────
    if (flat.includes('information_schema.tables')) {
      const rows: { table_schema: string; table_name: string }[] = [];
      for (const [name, s] of fake.schemas) {
        rows.push({ table_schema: name, table_name: 'kv' });
        if (s.hasUserQuota) rows.push({ table_schema: name, table_name: 'user_quota' });
        if (s.hasSharedKv) rows.push({ table_schema: name, table_name: 'shared_kv' });
      }
      return { rows, rowCount: rows.length };
    }

    // ── account-wide UNION ALL count pass ───────────────────────────────────
    if (flat.includes('AS schema_name')) {
      const uid = params[0] as number;
      const branches = [...flat.matchAll(/SELECT '(app_[a-z0-9_]+)' AS schema_name/g)].map(
        (m) => m[1]
      );
      return {
        rows: branches.map((name) => ({
          schema_name: name,
          n: String((fake.schemas.get(name)?.kv ?? []).filter((r) => r.user_id === uid).length),
        })),
        rowCount: branches.length,
      };
    }

    // ── ambiguous-schema row probe (the collided targeted-preview branch) ───
    // A count over the SCHEMA, deliberately not attributed to either colliding
    // app. Matched before the totals block because it is also a bare count.
    if (
      /^SELECT count\(\*\)::text AS n FROM "app_[a-z0-9_]+"\.kv WHERE user_id = \$1$/i.test(flat)
    ) {
      const s = fake.schemas.get(schemaOf(flat));
      if (!s) throw new Error(`fake: relation does not exist: ${schemaOf(flat)}.kv`);
      const uid = params[0] as number;
      return {
        rows: [{ n: String(s.kv.filter((r) => r.user_id === uid).length) }],
        rowCount: 1,
      };
    }

    // ── per-app totals + counter + shared count ─────────────────────────────
    if (flat.includes('AS row_count') && flat.includes('AS total_bytes')) {
      const name = schemaOf(flat);
      const s = fake.schemas.get(name);
      if (!s) throw new Error(`fake: relation does not exist: ${name}.kv`);
      const uid = params[0] as number;
      const appBlockId = params[1] as string;
      const mine = s.kv.filter((r) => r.user_id === uid);
      const counter = s.hasUserQuota ? s.userQuota.get(`${appBlockId}:${uid}`) : undefined;
      return {
        rows: [
          {
            row_count: String(mine.length),
            total_bytes: String(mine.reduce((a, r) => a + r.size_bytes, 0)),
            counter_bytes: s.hasUserQuota ? (counter ? String(counter.used) : null) : null,
            counter_rows: s.hasUserQuota ? (counter ? String(counter.rows) : null) : null,
            shared_rows: s.hasSharedKv
              ? String(s.sharedAuthors.filter((a) => a === uid).length)
              : null,
          },
        ],
        rowCount: 1,
      };
    }

    // ── capped row listing ──────────────────────────────────────────────────
    if (flat.includes('md5(value::text)')) {
      const uid = params[0] as number;
      const limit = params[1] as number;
      const rows = rowsFor(flat)
        .filter((r) => r.user_id === uid)
        .sort((a, b) => b.size_bytes - a.size_bytes || a.key.localeCompare(b.key))
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }

    // ── DELETE FROM <schema>.kv ─────────────────────────────────────────────
    if (/^DELETE FROM "app_[a-z0-9_]+"\.kv/i.test(flat)) {
      if (fake.failNextKvDelete) {
        const msg = fake.failNextKvDelete;
        fake.failNextKvDelete = null;
        throw new Error(msg);
      }
      const name = schemaOf(flat);
      const s = fake.schemas.get(name);
      if (!s) throw new Error(`fake: relation does not exist: ${name}.kv`);
      // 🔴 An UNSCOPED delete is EXECUTED, not refused — Postgres would execute
      // it, so the fake must too. Refusing it would kill the over-broad-`WHERE`
      // mutant for the FAKE's reason ("unsupported predicate") instead of for
      // the reason that matters ("it deleted the bystander"), and a mutant that
      // dies to the harness proves nothing about the code. The two supported
      // shapes are therefore: no `WHERE` (delete every row in the table) and
      // `user_id = $N` (delete that bound user's rows). Anything else is a
      // predicate this fake cannot evaluate and it says so rather than guessing.
      const where = flat.match(/\bWHERE\s+(.*?)\s+RETURNING\b/i)?.[1] ?? null;
      let match: (r: KvRow) => boolean;
      if (where === null) {
        match = () => true;
      } else {
        const m = where.match(/^user_id\s*=\s*\$(\d+)$/);
        if (!m) {
          throw new Error(
            `fake: cannot evaluate kv DELETE predicate ${JSON.stringify(where)} — ` +
              `supported shapes are (none) and \`user_id = $N\``
          );
        }
        const uid = params[Number(m[1]) - 1] as number;
        match = (r) => r.user_id === uid;
      }
      const removed = s.kv.filter(match);
      s.kv = s.kv.filter((r) => !match(r));
      return { rows: removed.map((r) => ({ size_bytes: r.size_bytes })), rowCount: removed.length };
    }

    // ── DELETE FROM <schema>.user_quota ─────────────────────────────────────
    if (/^DELETE FROM "app_[a-z0-9_]+"\.user_quota/i.test(flat)) {
      const s = fake.schemas.get(schemaOf(flat));
      if (!s) throw new Error('fake: no schema');
      if (!s.hasUserQuota) throw new Error('relation "user_quota" does not exist');
      const key = `${params[0] as string}:${params[1] as number}`;
      const existed = s.userQuota.delete(key);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    throw new Error(`fake: unhandled statement: ${flat.slice(0, 160)}`);
  }

  const mockClient = { query: vi.fn(query), release: vi.fn() };
  const mockPool = { query: vi.fn(query), connect: vi.fn(async () => mockClient) };

  return {
    fake,
    mockPool,
    mockClient,
  };
});

vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
import { appsModUserStorageRouter } from '../apps-mod-storage.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import { APP_USER_STORAGE_PURGE_ACTION } from '~/server/services/apps/user-storage-purge.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;
dbMock.dbWrite.appListingModerationEvent.create.mockImplementation(
  async ({ data }: { data: Record<string, unknown> }) => data
);
dbMock.dbWrite.appListingModerationEvent.update.mockImplementation(async () => ({}));

// ── Fixture ───────────────────────────────────────────────────────────────────
// Three schemas, three users. Byte sizes are DISTINCT PRIMES so that no wrong
// subset of rows can sum to a right-looking total.
const TARGET = 42;
const BYSTANDER = 77;

const APP_A = { id: 'apb_aaa', blockId: 'my-app', schema: 'app_my_app', slug: 'my-app' };
const APP_B = { id: 'apb_bbb', blockId: 'other-app', schema: 'app_other_app', slug: 'other-app' };
// A provisioned schema with NO AppBlock row behind it (decommissioned block,
// renamed slug). It must be reported and skipped, never purged.
const ORPHAN_SCHEMA = 'app_orphaned_app';
// The run-for-real review-preview namespace. Must never be enumerated.
const PREVIEW_SCHEMA = 'apprev_01hpreview';

/** TARGET's rows in APP_A: 101 + 211 + 307 = 619 bytes over 3 rows. */
const A_TARGET_BYTES = 619;
/** TARGET's rows in APP_B: 1009 bytes over 1 row. */
const B_TARGET_BYTES = 1009;
/** BYSTANDER's single row in APP_A. */
const A_BYSTANDER_BYTES = 2003;

function kvRow(user_id: number, key: string, size_bytes: number, instance = 'mbi_1') {
  return {
    user_id,
    block_instance_id: instance,
    key,
    size_bytes,
    value_md5: `md5_${key}`,
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
  };
}

function seed() {
  fake.reset();
  fake.addSchema(APP_A.schema);
  fake.addSchema(APP_B.schema);
  fake.addSchema(ORPHAN_SCHEMA);
  fake.addSchema(PREVIEW_SCHEMA);

  fake
    .kv(APP_A.schema)
    .push(
      kvRow(TARGET, 'a-one', 101),
      kvRow(TARGET, 'a-two', 211, 'mbi_2'),
      kvRow(TARGET, 'a-three', 307),
      kvRow(BYSTANDER, 'b-keep', A_BYSTANDER_BYTES)
    );
  fake.kv(APP_B.schema).push(kvRow(TARGET, 'b-one', B_TARGET_BYTES));
  fake.kv(ORPHAN_SCHEMA).push(kvRow(TARGET, 'orphan-key', 4001));
  fake.kv(PREVIEW_SCHEMA).push(kvRow(TARGET, 'preview-key', 5003));

  // Counters, as the triggers would have left them.
  fake.state(APP_A.schema).userQuota.set(`${APP_A.id}:${TARGET}`, { used: 619, rows: 3 });
  fake.state(APP_A.schema).userQuota.set(`${APP_A.id}:${BYSTANDER}`, { used: 2003, rows: 1 });
  fake.state(APP_B.schema).userQuota.set(`${APP_B.id}:${TARGET}`, { used: 1009, rows: 1 });
  fake.state(APP_A.schema).sharedAuthors.push(TARGET, TARGET);

  mockDbRead.appBlock.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id === APP_A.id)
      return {
        id: APP_A.id,
        blockId: APP_A.blockId,
        appListing: { id: 'apl_a', slug: APP_A.slug },
      };
    if (where.id === APP_B.id) return { id: APP_B.id, blockId: APP_B.blockId, appListing: null };
    return null;
  });
  mockDbRead.appBlock.findMany.mockImplementation(async () => [
    { id: APP_A.id, blockId: APP_A.blockId, appListing: { id: 'apl_a', slug: APP_A.slug } },
    { id: APP_B.id, blockId: APP_B.blockId, appListing: null },
  ]);
}

const MOD = { id: 9, isModerator: true, deletedAt: null, bannedAt: null };

function ctx(user: unknown = MOD) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const caller = (user: unknown = MOD) => appsModUserStorageRouter.createCaller(ctx(user) as never);

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

// ── 1. THE READ SURFACE ───────────────────────────────────────────────────────

describe('preview (the read surface)', () => {
  it('reports exactly what a targeted purge would remove, and removes nothing', async () => {
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });

    expect(out.apps).toHaveLength(1);
    const app = out.apps[0];
    expect(app.appBlockId).toBe(APP_A.id);
    expect(app.slug).toBe('my-app');
    // BARE identifier, not the quoted SQL form — this value is persisted into the
    // permanent snapshot, where quotes would break a JSON-path query and would never
    // match `information_schema.schemata`.
    expect(app.schema).toBe('app_my_app');
    expect(app.rowCount).toBe(3);
    expect(app.totalBytes).toBe(A_TARGET_BYTES);
    // Largest first, and ONLY the target's keys.
    expect(app.rows.map((r) => r.key)).toEqual(['a-three', 'a-two', 'a-one']);
    expect(app.rows.map((r) => r.sizeBytes)).toEqual([307, 211, 101]);
    expect(app.rows.map((r) => r.blockInstanceId)).toEqual(['mbi_1', 'mbi_2', 'mbi_1']);
    // A fingerprint, never the value — no `value` field is returned at all.
    expect(app.rows[0]).not.toHaveProperty('value');
    expect(app.rows[0].valueMd5).toBe('md5_a-three');
    expect(app.rowsTruncated).toBe(false);
    // Context: shared rows exist and are NOT in scope for this purge.
    expect(app.sharedRowsNotPurged).toBe(2);

    // Read-only: every row still there.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('flags counter drift the purge would silently repair', async () => {
    fake.state(APP_A.schema).userQuota.set(`${APP_A.id}:${TARGET}`, { used: 999_999, rows: 3 });
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps[0].counter).toEqual({ usedBytes: 999_999, rowCount: 3 });
    expect(out.apps[0].counterMatchesRows).toBe(false);
  });

  it('agrees with the rows when the counter is correct', async () => {
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps[0].counterMatchesRows).toBe(true);
  });

  it('returns a null counter verdict (not false) on a schema with no user_quota', async () => {
    fake.state(APP_A.schema).hasUserQuota = false;
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps[0].counter).toBeNull();
    expect(out.apps[0].counterMatchesRows).toBeNull();
    // …and the rest of the view is still correct, not a degraded fallback.
    expect(out.apps[0].rowCount).toBe(3);
    expect(out.apps[0].totalBytes).toBe(A_TARGET_BYTES);
  });

  it('🔴 binds ONE parameter on a no-user_quota schema — the vanished $2', async () => {
    // The contract pinned HERE rather than only in the fake, so deleting the
    // fake's arity check does not silently un-cover it. `$2` appears only inside
    // the `user_quota` fragment; when that fragment is replaced by a literal
    // NULL the statement references `$1` alone, and a two-element bind array is
    // a hard Postgres error rather than an ignored extra.
    fake.state(APP_A.schema).hasUserQuota = false;
    await caller().preview({ userId: TARGET, appBlockId: APP_A.id });

    const totals = mockPool.query.mock.calls.find((c) =>
      String(c[0]).includes('AS total_bytes')
    ) as [string, unknown[]];
    expect(totals[0]).not.toContain('$2');
    expect(totals[1]).toEqual([TARGET]);
  });

  it('🔴 an account-wide sweep SURVIVES a schema that has no user_quota', async () => {
    // The reachability that made this a live 500 rather than a latent one:
    // `buildAppView` is awaited inside the enumeration loop, so one such schema
    // took out the whole sweep — every healthy app with it. Measured in
    // production at 11 of 20 schemas on this branch.
    fake.state(APP_A.schema).hasUserQuota = false;
    const out = await caller().preview({ userId: TARGET });
    expect(out.apps.map((a) => a.appBlockId).sort()).toEqual([APP_A.id, APP_B.id]);
    expect(out.totals.rowCount).toBe(4);
  });

  it('🔴 an account-wide PURGE survives it too, and still purges the healthy apps', async () => {
    // `previewUserAppStorage` is called OUTSIDE the per-app try in the sweep, so
    // this threw before any app was purged — including apps that were fine.
    fake.state(APP_A.schema).hasUserQuota = false;
    const out = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });
    expect(out.failures).toEqual([]);
    expect(out.totals.deletedRowCount).toBe(4);
    expect(fake.kv(APP_A.schema).map((r) => r.user_id)).toEqual([BYSTANDER]);
    expect(fake.kv(APP_B.schema)).toEqual([]);
  });

  it('account-wide: enumerates every mapped app, reports unmapped schemas, totals exactly', async () => {
    const out = await caller().preview({ userId: TARGET });

    expect(out.apps.map((a) => a.appBlockId).sort()).toEqual([APP_A.id, APP_B.id]);
    expect(out.totals).toEqual({
      appCount: 2,
      rowCount: 4,
      totalBytes: A_TARGET_BYTES + B_TARGET_BYTES,
    });
    // The schema with no AppBlock behind it is SURFACED, not silently swept.
    expect(out.unmappedSchemas).toEqual([ORPHAN_SCHEMA]);
    expect(out.schemasTruncated).toBe(false);
  });

  it('NEVER enumerates the run-for-real review-preview namespace', async () => {
    const out = await caller().preview({ userId: TARGET });
    const seen = JSON.stringify(out);
    expect(seen).not.toContain('apprev_');
    expect(out.unmappedSchemas).not.toContain(PREVIEW_SCHEMA);
    // And the preview schema's row for the same user is untouched + uncounted.
    expect(out.totals.totalBytes).toBe(A_TARGET_BYTES + B_TARGET_BYTES);
  });

  it('two blocks claiming ONE schema disqualifies it — no arbitrary winner', async () => {
    // 🔴 THE REACHABLE SHAPE. This fixture used `my_app`, which the manifest
    // pattern `^[a-z][a-z0-9-]*[a-z0-9]$` FORBIDS — so it tested a collision that
    // could not occur and left the one that can untested. `sanitizeAppSlug`
    // collapses RUNS (`replace(/[^a-z0-9]+/g, '_')`), and the pattern admits
    // consecutive hyphens, so `my-app` and `my--app` are BOTH legal and BOTH
    // resolve to `app_my_app`. Measured, along with `my---app`.
    mockDbRead.appBlock.findMany.mockImplementation(async () => [
      { id: APP_A.id, blockId: 'my-app', appListing: { id: 'apl_a', slug: 'my-app' } },
      { id: 'apb_ccc', blockId: 'my--app', appListing: null },
      { id: APP_B.id, blockId: APP_B.blockId, appListing: null },
    ]);
    const out = await caller().preview({ userId: TARGET });
    expect(out.apps.map((a) => a.appBlockId)).toEqual([APP_B.id]);
    expect(out.unmappedSchemas.sort()).toEqual([APP_A.schema, ORPHAN_SCHEMA].sort());

    // …and the account-wide purge then leaves that schema's rows alone.
    const purge = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });
    expect(purge.unmappedSchemas).toContain(APP_A.schema);
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
    expect(fake.kv(APP_B.schema)).toEqual([]);
  });

  it('🔴 the TARGETED purge refuses a shared schema too — it had no guard at all', async () => {
    // This is where the hazard was actually reachable. The sweep disqualified a
    // shared schema; the targeted verb resolved one block, derived its schema and
    // deleted — so a purge aimed at `my-app` also destroyed `my--app`'s rows for
    // that user, decremented only `my-app`'s quota, and left `my--app`'s
    // user_quota as a phantom balance for rows that no longer exist.
    mockDbRead.appBlock.findMany.mockImplementation(async () => [
      { id: APP_A.id, blockId: 'my-app', appListing: { id: 'apl_a', slug: 'my-app' } },
      { id: 'apb_ccc', blockId: 'my--app', appListing: null },
    ]);

    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // CONFLICT, not NOT_FOUND: the block exists, the purge is refused.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
    expect(mockDbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 the TARGETED preview disqualifies a shared schema, like the other two paths', async () => {
    // The read and the write disagreed: `purgeApp` refused with CONFLICT and the
    // account-wide preview called the schema unresolvable, while the targeted
    // preview happily rendered BOTH apps' rows as if they belonged to the one
    // named. Nothing was destroyed by that, but the read surface is what a
    // moderator approves.
    mockDbRead.appBlock.findMany.mockImplementation(async () => [
      { id: APP_A.id, blockId: 'my-app', appListing: { id: 'apl_a', slug: 'my-app' } },
      { id: 'apb_ccc', blockId: 'my--app', appListing: null },
    ]);

    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps).toEqual([]);
    expect(out.unmappedSchemas).toEqual([APP_A.schema]);
    // No key names or fingerprints leak out of the disqualified schema.
    const serialized = JSON.stringify(out);
    for (const k of ['a-one', 'a-two', 'a-three']) expect(serialized).not.toContain(k);
  });

  it('a collided schema holding NO rows for the target is not reported as holding them', async () => {
    // `unmappedSchemas` means "holds rows for this user AND could not be resolved
    // to one app". The collision branch used to return the name before any count
    // was taken, telling a moderator a schema holds their target's rows when it
    // may hold none — falsifying the field's own docstring and costing an
    // investigation.
    mockDbRead.appBlock.findMany.mockImplementation(async () => [
      { id: APP_A.id, blockId: 'my-app', appListing: { id: 'apl_a', slug: 'my-app' } },
      { id: 'apb_ccc', blockId: 'my--app', appListing: null },
    ]);

    // A user with nothing stored anywhere.
    const out = await caller().preview({ userId: 999, appBlockId: APP_A.id });
    expect(out.apps).toEqual([]);
    expect(out.unmappedSchemas).toEqual([]);
  });

  it('an app that was never provisioned reads as empty, not as an error', async () => {
    fake.schemas.delete(APP_A.schema);
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps).toEqual([]);
    expect(out.totals).toEqual({ appCount: 0, rowCount: 0, totalBytes: 0 });
  });

  it('an unknown app block reads as empty', async () => {
    const out = await caller().preview({ userId: TARGET, appBlockId: 'apb_nope' });
    expect(out.apps).toEqual([]);
  });
});

// ── 1b. THE READ IS ATTRIBUTABLE ─────────────────────────────────────────────

describe('preview attribution', () => {
  const previewLines = () =>
    mockLogToAxiom.mock.calls.filter(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'mod_preview_user_storage'
    );

  it('records WHO looked at WHOSE data, at what scope, and how much was there', async () => {
    await caller().preview({ userId: TARGET, appBlockId: APP_A.id });

    expect(previewLines()).toHaveLength(1);
    const [payload, stream] = previewLines()[0] as [Record<string, unknown>, string];
    expect(payload.actorUserId).toBe(MOD.id);
    expect(payload.targetUserId).toBe(TARGET);
    expect(payload.scope).toBe('app');
    expect(payload.appBlockId).toBe(APP_A.id);
    expect(payload.rowCount).toBe(3);
    expect(payload.totalBytes).toBe(A_TARGET_BYTES);
    // Same ops datastream the purge writes to — no new stream, no DDL.
    expect(stream).toBe('app-storage-trpc');
  });

  it('marks an account-wide read as such', async () => {
    await caller().preview({ userId: TARGET });
    const [payload] = previewLines()[0] as [Record<string, unknown>];
    expect(payload.scope).toBe('account');
    expect(payload.appBlockId).toBeNull();
    expect(payload.appCount).toBe(2);
  });

  it('🔴 never writes the KEY NAMES into the log', async () => {
    // Recording that someone looked must not copy the thing they looked at into a
    // second store. The trail answers "who looked at whose data, and when"; it
    // deliberately does not answer "what exactly did they see".
    await caller().preview({ userId: TARGET });
    const serialized = JSON.stringify(previewLines());
    for (const key of ['a-one', 'a-two', 'a-three', 'b-one']) {
      expect(serialized).not.toContain(key);
    }
    expect(serialized).not.toContain('md5_');
  });

  it('a purge does NOT forge a "a moderator looked" event', async () => {
    // The account-wide purge enumerates internally via the bare function. If it
    // went through the moderator wrapper, every purge would also claim a read.
    mockLogToAxiom.mockClear();
    await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });
    expect(previewLines()).toHaveLength(0);
  });

  it('a logging failure never fails the read', async () => {
    mockLogToAxiom.mockRejectedValueOnce(new Error('log store down'));
    const out = await caller().preview({ userId: TARGET, appBlockId: APP_A.id });
    expect(out.apps[0].rowCount).toBe(3);
  });
});

// ── 1c. THE INPUT BOUNDARY THE ERASURE REDUCTION RESTS ON ────────────────────

describe('initiator is not a remote input', () => {
  /**
   * 🔴 THIS PINS THE SENTENCE THAT JUSTIFIES THE ERASURE REDUCTION.
   *
   * The snapshot shape is chosen by `before.initiator`, and the safety argument
   * is precisely that NEITHER tRPC PROCEDURE ACCEPTS `initiator` FROM INPUT — not
   * that "no caller can supply it", which is false (both service functions export
   * an optional `initiator?:`). So the guarantee lives on the input schema, and
   * until now nothing guarded it.
   *
   * Every other test asserts `before.initiator` EQUALS the expected value, which
   * keeps passing if someone adds `initiator` to `purgeApp`'s input and the test's
   * caller merely does not send it. The failure that would ship: a "re-run as
   * system" affordance is added, a moderator passes `'system:account-wipe'`, and
   * gets a takedown whose permanent row records NONE of the keys they destroyed —
   * with the suite green.
   *
   * Asserted against the procedure's own zod schemas — ALL of them, which is what
   * actually decides what a remote caller may send.
   *
   * 🔴 `_def.inputs` IS A LIST, AND READING `[0]` LEFT A HOLE IN THE GUARD THAT
   * CARRIES THIS ARGUMENT. tRPC MERGES chained `.input()` calls, so a second
   * chained `.input(z.object({ initiator: … }))` is admitted from the wire while
   * an `inputs[0]` reader reports the field absent. Demonstrated: with that
   * mutation applied the whole suite stayed green, `_def.inputs.length === 2`,
   * and the merged parse returned `initiator` alongside the declared fields.
   *
   * A guard whose docstring claims it checks "the procedure's own zod schema"
   * while checking only the first of several is worse than no guard — it reads as
   * coverage and stops anyone looking. Everything below reduces over the whole
   * list.
   */
  type InputSchema = {
    shape?: Record<string, unknown>;
    parse: (v: unknown) => Record<string, unknown>;
  };

  const inputSchemasOf = (name: 'preview' | 'purgeApp' | 'purgeAccount'): InputSchema[] => {
    const proc = (
      appsModUserStorageRouter as never as {
        _def: { procedures: Record<string, { _def: { inputs: unknown[] } }> };
      }
    )._def.procedures[name];
    expect(proc).toBeTruthy();
    const inputs = proc._def.inputs as InputSchema[];
    // POSITIVE CONTROL on the reader itself: a procedure with no declared input
    // would make every "does not contain" assertion below vacuously true.
    expect(inputs.length).toBeGreaterThan(0);
    return inputs;
  };

  /** Every key any of the procedure's input schemas declares. */
  const inputKeysOf = (name: 'preview' | 'purgeApp' | 'purgeAccount') =>
    inputSchemasOf(name).flatMap((i) => Object.keys(i.shape ?? {}));

  it.each(['preview', 'purgeApp', 'purgeAccount'] as const)(
    '%s does not admit `initiator` from the wire',
    (name) => {
      const keys = inputKeysOf(name);
      // POSITIVE CONTROL — the reader really is looking at the field list.
      expect(keys).toContain('userId');
      expect(keys).not.toContain('initiator');
    }
  );

  it('a client that sends `initiator` anyway cannot change the recorded shape', () => {
    // The schemas are strict-by-omission: an unknown key is stripped, not honoured.
    // Parsed through EVERY input and merged, which is what tRPC does with chained
    // `.input()` calls — so a second schema that DID accept the field would show
    // up here rather than being skipped.
    const sent = {
      userId: TARGET,
      appBlockId: APP_A.id,
      reason: 'abuse',
      initiator: 'system:account-wipe',
    };
    const parsed = inputSchemasOf('purgeApp').reduce<Record<string, unknown>>(
      (acc, schema) => ({ ...acc, ...schema.parse(sent) }),
      {}
    );
    expect(parsed).not.toHaveProperty('initiator');
    // Positive control: the merge really did produce the declared fields.
    expect(parsed).toMatchObject({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' });
  });

  /**
   * 🔴 THE LEDGER, BECAUSE EVERY ASSERTION ABOVE IS SPELLED RATHER THAN
   * STRUCTURAL. They pin the WORD `initiator`, and the sentence they carry has a
   * second link they never observe: what the ROUTER BODY forwards to the
   * service's `initiator?:`. A schema can omit `initiator` and still hand the
   * service one, under any other name.
   *
   * Demonstrated: adding `asSystem: z.boolean().optional()` to `purgeApp`'s input
   * and `initiator: input.asSystem ? 'system:account-wipe' : undefined` to the
   * service call ran the whole delta suite green. A moderator then POSTs
   * `{userId, appBlockId, reason, asSystem: true}` and gets a MODERATOR TAKEDOWN
   * whose permanent audit row carries `rowDetailWithheld: 'erasure'` and names
   * NONE of the keys it destroyed — verbatim the failure the docstring at the top
   * of this describe says it prevents. The row-shape test misses it for exactly
   * the reason that docstring predicts: its caller simply does not send the field.
   *
   * So pin the WIRE KEY SET EXACTLY. It fails when the set GROWS or SHRINKS, so it
   * catches any alias by construction rather than any particular spelling — which
   * is the whole point, the old guard being able to see only the one word it
   * named. A new wire field is a deliberate edit here, where the reviewer is
   * looking at this comment.
   */
  it.each([
    ['preview', ['appBlockId', 'userId']],
    ['purgeApp', ['appBlockId', 'reason', 'userId']],
    ['purgeAccount', ['reason', 'userId']],
  ] as const)('%s accepts EXACTLY these wire keys, and no others', (name, expected) => {
    expect([...inputKeysOf(name)].sort()).toEqual([...expected].sort());
  });
});

// ── 2. TARGETED PURGE + ITS NEGATIVE CONTROLS ────────────────────────────────

describe('purgeApp (targeted)', () => {
  it('removes only the target user, only in the named app', async () => {
    const out = await caller().purgeApp({
      userId: TARGET,
      appBlockId: APP_A.id,
      reason: 'CSAM report #123',
    });

    expect(out.deletedRowCount).toBe(3);
    expect(out.deletedBytes).toBe(A_TARGET_BYTES);
    expect(out.userQuotaReset).toBe(true);
    expect(out.auditCompletionRecorded).toBe(true);

    // NEGATIVE CONTROL 1 — the other user's row in the SAME schema survives.
    const remainingA = fake.kv(APP_A.schema);
    expect(remainingA).toHaveLength(1);
    expect(remainingA[0].user_id).toBe(BYSTANDER);
    expect(remainingA[0].size_bytes).toBe(A_BYSTANDER_BYTES);

    // NEGATIVE CONTROL 2 — the SAME user's rows in another app survive.
    expect(fake.kv(APP_B.schema).map((r) => r.key)).toEqual(['b-one']);

    // NEGATIVE CONTROL 3 — the orphan + review-preview schemas are untouched.
    expect(fake.kv(ORPHAN_SCHEMA)).toHaveLength(1);
    expect(fake.kv(PREVIEW_SCHEMA)).toHaveLength(1);
  });

  it('leaves user_quota consistent: the target counter is gone, the bystander keeps theirs', async () => {
    await caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' });
    const q = fake.state(APP_A.schema).userQuota;
    expect(q.has(`${APP_A.id}:${TARGET}`)).toBe(false);
    expect(q.get(`${APP_A.id}:${BYSTANDER}`)).toEqual({ used: 2003, rows: 1 });
  });

  it('sets the app_block_id GUC so the app-wide quota trigger fires', async () => {
    await caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' });
    const setLocal = mockClient.query.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.startsWith('SET LOCAL'));
    expect(setLocal).toBe(`SET LOCAL app.current_app_block_id = '${APP_A.id}'`);
  });

  it('an unknown app block is NOT_FOUND, and deletes nothing anywhere', async () => {
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: 'apb_nope', reason: 'abuse' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('is NOT reachable by a non-moderator session (FORBIDDEN)', async () => {
    await expect(
      caller({ id: 1, isModerator: false, deletedAt: null, bannedAt: null }).purgeApp({
        userId: TARGET,
        appBlockId: APP_A.id,
        reason: 'abuse',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('refuses a missing or trivial reason, and deletes nothing', async () => {
    await expect(
      // @ts-expect-error — the reason is required; this pins the runtime refusal.
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'x' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
    expect(mockDbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});

// ── 3. THE AUDIT RECORD ──────────────────────────────────────────────────────

describe('audit record', () => {
  it('records actor + target + reason + a row snapshot on the existing mod-event rail', async () => {
    await caller().purgeApp({
      userId: TARGET,
      appBlockId: APP_A.id,
      reason: 'ToS violation, ticket 99',
    });

    expect(mockDbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const { data } = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;

    expect(data.action).toBe('purge-user-storage');
    expect(data.actorUserId).toBe(MOD.id); // ACTOR
    expect(data.before.targetUserId).toBe(TARGET); // TARGET
    expect(data.reason).toBe('ToS violation, ticket 99'); // REASON
    expect(data.appListingId).toBe('apl_a');
    expect(data.slug).toBe('my-app');
    expect(data.id).toMatch(/^alme_[0-9A-HJKMNP-TV-Z]{26}$/);

    // ROW SNAPSHOT — what was destroyed, not merely that something was.
    expect(data.before.rowCount).toBe(3);
    expect(data.before.totalBytes).toBe(A_TARGET_BYTES);
    expect(data.before.rows.map((r: any) => r.key)).toEqual(['a-three', 'a-two', 'a-one']);
    expect(data.before.rows.map((r: any) => r.sizeBytes)).toEqual([307, 211, 101]);
    expect(data.before.rows.map((r: any) => r.valueMd5)).toEqual([
      'md5_a-three',
      'md5_a-two',
      'md5_a-one',
    ]);
    expect(data.before.schema).toBe('app_my_app');
    expect(data.before.scope).toBe('app');
    // 🔴 POSITIVE CONTROL for the erasure reduction in
    // `user-remove-all-content.app-storage.test.ts`: the MODERATOR path keeps the
    // full per-key snapshot. If someone reduced BOTH paths, the erasure test would
    // still pass and only this assertion would catch it.
    expect(data.before.initiator).toBe('moderator');
    expect(data.before.rowDetailWithheld).toBeUndefined();

    // 🔴 The snapshot carries no VALUES — that is the point of the fingerprint.
    expect(JSON.stringify(data.before)).not.toContain('"value"');

    // Outcome stamped after the delete commits.
    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.where.id).toBe(data.id);
    expect(update.data.after.deletedRowCount).toBe(3);
    expect(update.data.after.deletedBytes).toBe(A_TARGET_BYTES);
    expect(update.data.after.userQuotaReset).toBe(true);
  });

  it('writes the audit row BEFORE deleting: an audit failure destroys nothing', async () => {
    mockDbWrite.appListingModerationEvent.create.mockRejectedValueOnce(
      Object.assign(new Error('new row violates check constraint'), { code: '23514' })
    );
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/check constraint/);

    // Every row still present — the purge did not happen.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
    expect(fake.state(APP_A.schema).userQuota.has(`${APP_A.id}:${TARGET}`)).toBe(true);
  });

  it('a failed outcome stamp is reported, not thrown, once the rows are already gone', async () => {
    mockDbWrite.appListingModerationEvent.update.mockRejectedValueOnce(new Error('db down'));
    const out = await caller().purgeApp({
      userId: TARGET,
      appBlockId: APP_A.id,
      reason: 'abuse',
    });
    expect(out.deletedRowCount).toBe(3);
    expect(out.auditCompletionRecorded).toBe(false);
    expect(fake.kv(APP_A.schema)).toHaveLength(1);
  });

  it('🔴 a rolled-back delete stamps after.outcome FAILED — not an ambiguous null', async () => {
    // "Were the rows actually removed?" is the question this row exists to
    // answer. Before this, a rolled-back delete and a successful delete whose
    // stamp failed were byte-identical: `before` present, `after` null. One
    // destroyed nothing, the other destroyed everything.
    fake.failNextKvDelete = 'deadlock detected';
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/deadlock/);

    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.data.after.outcome).toBe('failed');
    expect(update.data.after.deletedRowCount).toBe(0);
    // The EVIDENCE the outcome was derived from, recorded so a reader can
    // re-derive it rather than trust it.
    expect(update.data.after.connected).toBe(true);
    expect(update.data.after.commitAttempted).toBe(false);
    expect(update.data.after.rollbackStatementOk).toBe(true);
    expect(String(update.data.after.error)).toContain('deadlock');
    // And the rows really are intact — the stamp is not merely claiming it.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('🔴 a COMMIT that threw records outcome UNKNOWN and omits deletedRowCount', async () => {
    // THE INVERSION THIS REPLACES. The connection dies during COMMIT: the server
    // may already have applied it. The old code discarded the rollback result and
    // wrote `deletedRowCount: 0, rolledBack: true` from constants, so the
    // permanent row asserted "NOTHING was destroyed" about a purge that may have
    // destroyed everything — and a reader acts on that.
    //
    // An audit row that is merely ambiguous is a gap; one that is confidently
    // wrong is worse than none.
    fake.failOnCommit = 'connection terminated unexpectedly';
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/connection terminated/);

    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.data.after.outcome).toBe('unknown');
    // 🔴 ABSENT, not zero. Its absence IS the signal.
    expect(update.data.after).not.toHaveProperty('deletedRowCount');
    // What the DELETE itself reported — the bound on what may be gone.
    expect(update.data.after.observedDeleteRowCount).toBe(3);
    expect(update.data.after.commitAttempted).toBe(true);
  });

  it('🔴 a failed ROLLBACK before COMMIT is still FAILED — no COMMIT, no durability', async () => {
    // 🔴 THE EXPECTATION COMES FROM POSTGRES, NOT FROM THE IMPLEMENTATION. Every
    // statement here runs after a successful BEGIN, so it is inside an explicit
    // transaction, and a transaction that never receives COMMIT cannot become
    // durable — the server discards it whether we managed to send ROLLBACK or the
    // connection simply died. So "the ROLLBACK statement failed" changes the
    // EVIDENCE, not the verdict.
    //
    // An earlier version recorded 'unknown' here. That was an over-claim of
    // UNCERTAINTY — "we cannot tell whether your data was destroyed" on a takedown
    // row, about a case where we can tell — and it would send someone
    // investigating nothing.
    fake.failNextKvDelete = 'deadlock detected';
    fake.failOnRollback = 'connection terminated unexpectedly';
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/deadlock/);

    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.data.after.outcome).toBe('failed');
    expect(update.data.after.deletedRowCount).toBe(0);
    expect(update.data.after.commitAttempted).toBe(false);
    // Recorded as evidence, and named for what it is: the statement returned or
    // it did not. It is NOT a claim that a rollback is confirmed.
    expect(update.data.after.rollbackStatementOk).toBe(false);
    expect(update.data.after).not.toHaveProperty('rollbackConfirmed');
    // The rows are genuinely intact, which is what the verdict claims.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('🔴 UNKNOWN is reserved for a COMMIT that was actually sent', async () => {
    // The only branch where the state is genuinely unestablished: COMMIT went to
    // the server and threw, so the server may or may not have applied it. Pins
    // that 'unknown' did not simply become unreachable when it was narrowed.
    fake.failOnCommit = 'connection terminated unexpectedly';
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/connection terminated/);

    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.data.after.outcome).toBe('unknown');
    expect(update.data.after.commitAttempted).toBe(true);
    expect(update.data.after).not.toHaveProperty('deletedRowCount');
  });

  it('🔴 a pool checkout failure is stamped, logged and wrapped — not an orphan', async () => {
    // `pool.connect()` used to sit OUTSIDE the try, so the most ordinary fault
    // there is — a connection timeout — bypassed the failure stamp, the log line
    // AND the error wrapper carrying the audit id, producing exactly the orphaned
    // `before`-only row this service claims to have eliminated.
    mockPool.connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));

    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow(/timeout exceeded/);

    const created = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;

    // 1. STAMPED — and as 'failed', because nothing can have run without a client.
    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.where.id).toBe(created.data.id);
    expect(update.data.after.outcome).toBe('failed');
    expect(update.data.after.connected).toBe(false);
    expect(update.data.after.deletedRowCount).toBe(0);

    // 2. LOGGED, with the audit id.
    const line = mockLogToAxiom.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'mod_purge_app_failed'
    ) as [Record<string, unknown>, string];
    expect(line).toBeTruthy();
    expect(line[0].auditEventId).toBe(created.data.id);

    // 3. And nothing was touched.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('a pool checkout failure carries the audit id into the sweep failures[]', async () => {
    // The correlation the wrapper exists for did not apply on this path either:
    // the sweep recorded `auditEventId: null`.
    mockPool.connect.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
    const out = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });

    const failed = out.failures.find((f) => f.appBlockId === APP_A.id);
    expect(failed).toBeTruthy();
    expect(failed!.auditEventId).not.toBeNull();
    const createdA = (mockDbWrite.appListingModerationEvent.create.mock.calls as any[]).find(
      (c) => c[0].data.before.appBlockId === APP_A.id
    );
    expect(failed!.auditEventId).toBe(createdA[0].data.id);
  });

  it('a successful purge stamps after.outcome PURGED', async () => {
    await caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' });
    const update = mockDbWrite.appListingModerationEvent.update.mock.calls[0][0] as any;
    expect(update.data.after.outcome).toBe('purged');
    expect(update.data.after.deletedRowCount).toBe(3);
  });

  it('the failure is logged WITH the audit id, on the targeted verb too', async () => {
    // The targeted verb used to log nothing at all on this path, so an orphaned
    // audit row had no correlate anywhere. Both verbs funnel through the same
    // emit now.
    fake.failNextKvDelete = 'deadlock detected';
    await expect(
      caller().purgeApp({ userId: TARGET, appBlockId: APP_A.id, reason: 'abuse' })
    ).rejects.toThrow();

    const created = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    const line = mockLogToAxiom.mock.calls.find(
      (c: unknown[]) => (c[0] as { event?: string })?.event === 'mod_purge_app_failed'
    ) as [Record<string, unknown>, string];
    expect(line).toBeTruthy();
    expect(line[0].auditEventId).toBe(created.data.id);
    expect(line[0].appBlockId).toBe(APP_A.id);
  });

  it('writes a row even for a purge that removes nothing', async () => {
    const out = await caller().purgeApp({
      userId: 12345,
      appBlockId: APP_A.id,
      reason: 'checked, nothing stored',
    });
    expect(out.deletedRowCount).toBe(0);
    expect(mockDbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const { data } = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    expect(data.before.rowCount).toBe(0);
    expect(data.before.rows).toEqual([]);
  });

  it('a block with no listing still writes a self-describing row (appListingId null)', async () => {
    await caller().purgeApp({ userId: TARGET, appBlockId: APP_B.id, reason: 'abuse' });
    const { data } = mockDbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    expect(data.appListingId).toBeNull();
    expect(data.slug).toBe('other-app');
    expect(data.before.targetUserId).toBe(TARGET);
  });

  it('the action it writes is in the shipped taxonomy tuple', () => {
    expect(APP_LISTING_MODERATION_ACTIONS).toContain(APP_USER_STORAGE_PURGE_ACTION);
  });
});

// ── 4. ACCOUNT-WIDE PURGE ────────────────────────────────────────────────────

describe('purgeAccount (account-wide)', () => {
  it('purges every mapped app, one audit row each, sharing a batch id', async () => {
    const out = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });

    expect(out.totals).toEqual({
      appCount: 2,
      deletedRowCount: 4,
      deletedBytes: A_TARGET_BYTES + B_TARGET_BYTES,
    });
    expect(out.failures).toEqual([]);
    expect(fake.kv(APP_A.schema).map((r) => r.user_id)).toEqual([BYSTANDER]);
    expect(fake.kv(APP_B.schema)).toEqual([]);

    expect(mockDbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(2);
    const batches = mockDbWrite.appListingModerationEvent.create.mock.calls.map(
      (c: any) => c[0].data.before.purgeBatchId
    );
    expect(new Set(batches).size).toBe(1);
    expect(batches[0]).toBe(out.purgeBatchId);
    for (const c of mockDbWrite.appListingModerationEvent.create.mock.calls) {
      expect((c[0] as any).data.before.scope).toBe('account');
    }
  });

  it('NEVER touches a schema it could not map to an AppBlock, and says so', async () => {
    const out = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });
    expect(out.unmappedSchemas).toEqual([ORPHAN_SCHEMA]);
    expect(fake.kv(ORPHAN_SCHEMA)).toHaveLength(1);
    expect(fake.kv(PREVIEW_SCHEMA)).toHaveLength(1);
  });

  it('one failing app does not strand the sweep — the rest complete and the failure is named', async () => {
    // Fail the FIRST kv delete the sweep attempts (apps are enumerated in
    // schema-name order, so that is app_my_app).
    fake.failNextKvDelete = 'deadlock detected';
    const out = await caller().purgeAccount({ userId: TARGET, reason: 'account terminated' });

    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].appBlockId).toBe(APP_A.id);
    expect(out.failures[0].error).toContain('deadlock');
    // The sweep's report points AT the orphaned audit row, so a reviewer who
    // finds one can tie it to the run that produced it.
    const createdA = (mockDbWrite.appListingModerationEvent.create.mock.calls as any[]).find(
      (c) => c[0].data.before.appBlockId === APP_A.id
    );
    expect(out.failures[0].auditEventId).toBe(createdA[0].data.id);
    // The other app still got purged.
    expect(out.totals.deletedRowCount).toBe(1);
    expect(fake.kv(APP_B.schema)).toEqual([]);
    // The failed app is intact.
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('is NOT reachable by a non-moderator session (FORBIDDEN)', async () => {
    await expect(
      caller({ id: 1, isModerator: false, deletedAt: null, bannedAt: null }).purgeAccount({
        userId: TARGET,
        reason: 'abuse',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.kv(APP_A.schema)).toHaveLength(4);
  });

  it('a user with nothing stored purges nothing and records nothing', async () => {
    const out = await caller().purgeAccount({ userId: 999, reason: 'routine check' });
    expect(out.totals).toEqual({ appCount: 0, deletedRowCount: 0, deletedBytes: 0 });
    expect(mockDbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});
