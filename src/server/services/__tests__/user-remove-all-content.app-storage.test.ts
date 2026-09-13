import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `removeAllContent` → App Blocks per-user storage purge.
 *
 * The purge service shipped with a moderator surface and NO other caller, so the
 * second gap its own header names — "a deleted account left its rows behind" —
 * was still open: nothing triggered a purge when an account was wiped. This pins
 * the seam.
 *
 * 🔴 THE PURGE SERVICE IS **NOT** MOCKED HERE. Asserting "a function was called"
 * would pass just as well against a purge wired to the wrong user, the wrong
 * database, or a no-op. So the real service runs against an executing fake apps
 * pool holding rows for two users, and the assertion is that the TARGET's rows
 * are gone and the BYSTANDER's are not.
 *
 * 🔴 THE NEGATIVE CONTROL IS THE OTHER HALF AND IT IS NOT OPTIONAL. The wipe and
 * the purge live in different databases with no transaction between them. A purge
 * failure must never abort the wipe or make it look undone — a moderator's
 * content wipe failing because an apps-DB schema was briefly unreachable would be
 * a regression, not a safety feature.
 */

const { fake, mockPool, mockClient } = vi.hoisted(() => {
  type KvRow = { user_id: number; key: string; size_bytes: number };
  const fake = {
    kv: [] as KvRow[],
    quota: new Map<string, boolean>(),
    /** Set to make every apps-DB statement throw (fault injection). */
    poolDown: null as string | null,
    /**
     * Extra EMPTY app schemas, purely to push the enumeration past its candidate
     * cap. They hold no rows for anyone, so they are filtered out of `hits` and
     * never reach `buildAppView` — the only thing they change is the candidate
     * COUNT, which is exactly the condition under test.
     */
    extraSchemas: 0,
    reset() {
      fake.kv = [];
      fake.quota = new Map();
      fake.poolDown = null;
      fake.extraSchemas = 0;
    },
  };

  /**
   * Bind arity, checked the way Postgres checks it. Same guard, same reason, as
   * the one in `apps-mod-storage.router.test.ts` — a statement assembled from
   * fragments can lose the only reference to a `$n` while the parameter is still
   * bound, and `pg` ships the array regardless. Duplicated deliberately: this
   * suite drives a DIFFERENT entry point (the account wipe) and must not depend
   * on the other file's fake to catch a statement it is the only caller of.
   */
  function assertBindArity(sql: string, params: unknown[]): void {
    const stripped = String(sql).replace(/'[^']*'/g, "''");
    const refs = [...stripped.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const required = refs.length ? Math.max(...refs) : 0;
    if (params.length !== required) {
      throw new Error(
        `bind message supplies ${params.length} parameters, but prepared statement "" requires ${required}`
      );
    }
  }

  async function query(sql: string, params: unknown[] = []): Promise<any> {
    if (fake.poolDown) throw new Error(fake.poolDown);
    const flat = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(flat) || /^SET LOCAL/i.test(flat)) {
      return { rows: [], rowCount: 0 };
    }
    assertBindArity(sql, params);
    if (flat.includes('information_schema.tables')) {
      const rows = [
        { table_schema: 'app_wiped_app', table_name: 'kv' },
        { table_schema: 'app_wiped_app', table_name: 'user_quota' },
      ];
      for (let i = 0; i < fake.extraSchemas; i++) {
        rows.push({ table_schema: `app_filler_${i}`, table_name: 'kv' });
      }
      return { rows, rowCount: rows.length };
    }
    if (flat.includes('AS schema_name')) {
      const uid = params[0] as number;
      // Answer every branch the statement actually contains, so a capped
      // enumeration is reflected here rather than assumed.
      const branches = [...flat.matchAll(/SELECT '(app_[a-z0-9_]+)' AS schema_name/g)].map(
        (m) => m[1]
      );
      return {
        rows: branches.map((name) => ({
          schema_name: name,
          n:
            name === 'app_wiped_app'
              ? String(fake.kv.filter((r) => r.user_id === uid).length)
              : '0',
        })),
        rowCount: branches.length,
      };
    }
    if (flat.includes('AS row_count') && flat.includes('AS total_bytes')) {
      const uid = params[0] as number;
      const mine = fake.kv.filter((r) => r.user_id === uid);
      return {
        rows: [
          {
            row_count: String(mine.length),
            total_bytes: String(mine.reduce((a, r) => a + r.size_bytes, 0)),
            counter_bytes: null,
            counter_rows: null,
            shared_rows: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (flat.includes('md5(value::text)')) {
      const uid = params[0] as number;
      return {
        rows: fake.kv
          .filter((r) => r.user_id === uid)
          .map((r) => ({
            key: r.key,
            block_instance_id: 'mbi_1',
            size_bytes: r.size_bytes,
            updated_at: new Date('2026-09-01T00:00:00.000Z'),
            value_md5: `md5_${r.key}`,
          })),
        rowCount: 0,
      };
    }
    if (/^DELETE FROM "app_wiped_app"\.kv/i.test(flat)) {
      // Same declared contract as the router suite's fake: the scope must be
      // exactly `user_id = $N`, and it is EVALUATED with the bound parameter.
      const where = flat.match(/\bWHERE\s+(.*?)\s+RETURNING\b/i)?.[1] ?? null;
      const m = where?.match(/^user_id\s*=\s*\$(\d+)$/);
      if (!m) throw new Error(`fake: unsupported kv DELETE predicate ${JSON.stringify(where)}`);
      const uid = params[Number(m[1]) - 1] as number;
      const removed = fake.kv.filter((r) => r.user_id === uid);
      fake.kv = fake.kv.filter((r) => r.user_id !== uid);
      return { rows: removed.map((r) => ({ size_bytes: r.size_bytes })), rowCount: removed.length };
    }
    if (/^DELETE FROM "app_wiped_app"\.user_quota/i.test(flat)) {
      fake.quota.delete(`${params[0]}:${params[1]}`);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`fake: unhandled statement: ${flat.slice(0, 140)}`);
  }

  const mockClient = { query: vi.fn(query), release: vi.fn() };
  return {
    fake,
    mockClient,
    mockPool: { query: vi.fn(query), connect: vi.fn(async () => mockClient) },
  };
});

vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const idx = { queueUpdate: vi.fn(async () => undefined) };
  return {
    ...actual,
    modelsSearchIndex: idx,
    imagesSearchIndex: idx,
    imagesMetricsSearchIndex: idx,
    articlesSearchIndex: idx,
    collectionsSearchIndex: idx,
    bountiesSearchIndex: idx,
    usersSearchIndex: idx,
  };
});
vi.mock('~/server/metrics', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const m = { queueUpdate: vi.fn(async () => undefined) };
  return { ...actual, userMetrics: m, articleMetrics: m };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteImageById: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/auction.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deleteBidsForModel: vi.fn(async () => undefined),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { removeAllContent } from '~/server/services/user.service';
import { APP_USER_STORAGE_MAX_SCHEMAS } from '~/server/services/apps/user-storage-purge.service';

const TARGET = 42;
const BYSTANDER = 77;
const MOD = 9;

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  fake.kv.push(
    { user_id: TARGET, key: 'gone-a', size_bytes: 101 },
    { user_id: TARGET, key: 'gone-b', size_bytes: 211 },
    { user_id: BYSTANDER, key: 'keep', size_bytes: 2003 }
  );

  for (const model of Object.values(dbMock.dbRead) as any[]) {
    if (model && typeof model === 'object' && 'findMany' in model) {
      model.findMany.mockResolvedValue([]);
    }
  }
  dbMock.dbWrite.appBlock.findMany.mockResolvedValue([
    { id: 'apb_wiped', blockId: 'wiped-app', appListing: { id: 'apl_w', slug: 'wiped-app' } },
  ]);
  dbMock.dbRead.appBlock.findMany.mockResolvedValue([
    { id: 'apb_wiped', blockId: 'wiped-app', appListing: { id: 'apl_w', slug: 'wiped-app' } },
  ]);
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
    id: 'apb_wiped',
    blockId: 'wiped-app',
    appListing: { id: 'apl_w', slug: 'wiped-app' },
  });
  dbMock.dbWrite.appListingModerationEvent.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => data
  );
  dbMock.dbWrite.appListingModerationEvent.update.mockResolvedValue({});
});

describe('removeAllContent → App Blocks per-user storage', () => {
  it('destroys the wiped account rows and leaves every other account alone', async () => {
    await removeAllContent({ id: TARGET, actorUserId: MOD });

    expect(fake.kv.map((r) => r.key)).toEqual(['keep']);
    expect(fake.kv[0].user_id).toBe(BYSTANDER);
  });

  it('records the purge as SYSTEM-initiated, attributed to the acting moderator', async () => {
    await removeAllContent({ id: TARGET, actorUserId: MOD });

    expect(dbMock.dbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const { data } = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    expect(data.action).toBe('purge-user-storage');
    expect(data.actorUserId).toBe(MOD);
    expect(data.before.targetUserId).toBe(TARGET);
    // 🔴 The structural discriminator. A moderator types `reason` freely and could
    // spell the system wording by hand; `initiator` is set by the code path and
    // the two `apps.mod.*` verbs hard-code 'moderator'.
    expect(data.before.initiator).toBe('system:account-wipe');
    expect(data.reason).toBe('[system] account content wipe (user.removeAllContent)');
    // The snapshot still says HOW MUCH was destroyed. The per-key detail is
    // withheld on this path — see the erasure test below.
    expect(data.before.rowCount).toBe(2);
    expect(data.before.totalBytes).toBe(312);
    expect(data.before.rows).toBeUndefined();
  });

  it('🔴 ERASURE: the wipe row carries NO per-key detail — counts and bytes only', async () => {
    // `removeAllContent` is an erasure. A permanent main-DB row holding the wiped
    // account's key names and content fingerprints would be a durable derived
    // artefact OF THE CONTENT BEING ERASED. The moderator-takedown framing that
    // justifies `valueMd5` elsewhere does not transfer to this path.
    //
    // 🔴 ASSERTED ON STATE AND CONTENT, NOT ON A FIELD NAME. Grepping for the
    // string `valueMd5` is walked past by a rename; this checks that none of the
    // fixture's actual key names or fingerprint VALUES appear anywhere in the
    // persisted payload, whatever they might be called.
    await removeAllContent({ id: TARGET, actorUserId: MOD });

    const { data } = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    expect(data.before.initiator).toBe('system:account-wipe');

    const serialized = JSON.stringify(data.before);
    for (const key of ['gone-a', 'gone-b']) expect(serialized).not.toContain(key);
    for (const md5 of ['md5_gone-a', 'md5_gone-b']) expect(serialized).not.toContain(md5);
    expect(data.before.rows).toBeUndefined();

    // …and it still answers "was anything removed, and how much?".
    expect(data.before.rowCount).toBe(2);
    expect(data.before.totalBytes).toBe(312);
    expect(data.before.appBlockId).toBe('apb_wiped');
    expect(data.before.rowDetailWithheld).toBe('erasure');
  });

  it('records a NULL actor when no human ordered it (the webhook caller)', async () => {
    // `/api/mod/remove-all-content` is a secret-authed WebhookEndpoint with no
    // user identity. `actorUserId` is Int? with onDelete: SetNull on this rail,
    // so null is a first-class state, not a hole.
    await removeAllContent({ id: TARGET });
    const { data } = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0] as any;
    expect(data.actorUserId).toBeNull();
    expect(data.before.initiator).toBe('system:account-wipe');
  });

  it('🔴 WARNS when the sweep resolves but purged nothing (the CHECK-not-applied case)', async () => {
    // The sweep is log-and-continue: it catches each app's failure into
    // `failures[]` and RESOLVES. So a bare try/catch here sees a clean resolve
    // and says nothing. That is exactly the live case until the action CHECK
    // widen is applied — every audit write is rejected with 23514, nothing is
    // purged, and the operator would have seen a silent success.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbMock.dbWrite.appListingModerationEvent.create.mockRejectedValue(
      Object.assign(new Error('new row violates check constraint'), { code: '23514' })
    );

    await removeAllContent({ id: TARGET, actorUserId: MOD });

    const lines = warn.mock.calls.map((c) => String(c[0]));
    const incomplete = lines.find((l) => l.includes('purge INCOMPLETE'));
    expect(incomplete).toBeTruthy();
    expect(incomplete).toContain(`userId=${TARGET}`);
    expect(incomplete).toContain('1 app(s) failed');
    expect(incomplete).toContain('check constraint');
    // And nothing was destroyed, which is the state the warning describes.
    expect(fake.kv.map((r) => r.key).sort()).toEqual(['gone-a', 'gone-b', 'keep']);
    warn.mockRestore();
  });

  it('🔴 WARNS when the schema sweep hit its candidate cap and skipped schemas', async () => {
    // The THIRD way the sweep completes having deliberately skipped rows,
    // alongside failures[] and unmappedSchemas[]. Unreachable at today's scale
    // (the cap is 500 against ~20 schemas), which is exactly why it was easy to
    // leave unread — and why two-of-three covered is how the next silent partial
    // wipe happens. Reached here by seeding past the cap rather than by asserting
    // the branch is unreachable.
    fake.extraSchemas = APP_USER_STORAGE_MAX_SCHEMAS + 1;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await removeAllContent({ id: TARGET, actorUserId: MOD });

    const truncated = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('hit its candidate cap'));
    expect(truncated).toBeTruthy();
    expect(truncated).toContain(`userId=${TARGET}`);
    warn.mockRestore();
  });

  it('stays quiet on a clean sweep', async () => {
    // Positive control for the guard above: the warning must not fire on the
    // happy path, or it is noise that trains an operator to ignore it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await removeAllContent({ id: TARGET, actorUserId: MOD });
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[removeAllContent]'))
    ).toEqual([]);
    warn.mockRestore();
  });

  it('writes the audit row BEFORE deleting — an audit failure destroys no rows', async () => {
    dbMock.dbWrite.appListingModerationEvent.create.mockRejectedValueOnce(
      new Error('new row violates check constraint')
    );
    await removeAllContent({ id: TARGET, actorUserId: MOD });

    // 🔴 The ATTEMPT assertion is what stops this being vacuous. "No rows were
    // destroyed" is trivially true of a build where nothing purges at all — it
    // passed at the base ref for exactly that reason. Pinning that the audit
    // write was REACHED makes the claim "the purge ran and stopped at the audit
    // row", which is the invariant this test is named for.
    expect(dbMock.dbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(fake.kv.map((r) => r.key).sort()).toEqual(['gone-a', 'gone-b', 'keep']);
  });

  it('🔴 NEGATIVE CONTROL: a purge failure does NOT abort or roll back the wipe', async () => {
    fake.poolDown = 'apps database unreachable';

    // Must RESOLVE, not reject.
    await expect(removeAllContent({ id: TARGET, actorUserId: MOD })).resolves.toBeUndefined();

    // 🔴 Same anti-vacuity point: a build that never calls the purge also never
    // rejects, so "it resolved" alone is satisfied by the bug this whole commit
    // fixes. Assert the purge was genuinely ATTEMPTED against the (downed) apps
    // pool — that is the state under test, and it is false at the base ref.
    expect(mockPool.query).toHaveBeenCalled();

    // And the main-DB wipe must have happened in full regardless. These are the
    // deletes that define the wipe; if the purge could abort it, they would be
    // missing or partial.
    for (const model of ['model', 'image', 'post', 'article', 'collection', 'comment'] as const) {
      expect(dbMock.dbWrite[model].deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET } });
    }
  });
});
