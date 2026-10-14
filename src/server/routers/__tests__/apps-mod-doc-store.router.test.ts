import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocStore, DocStoreDb } from '~/server/services/apps/doc-store';

/**
 * `apps.mod.docStore.*` end to end below the HTTP layer: the REAL router and its
 * `moderatorProcedure`, the REAL moderation service, and the REAL document store on the
 * embedded Postgres (real migration, least-privilege role, RLS on). Replaced at the
 * boundary only: the main-database rows (`AppBlock`, `User`, the audit table) through the
 * canonical db mock.
 *
 * Every effect is asserted through the store's own VIEWER reads — what an app would see —
 * never by reading back the moderation call's return value.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const h = vi.hoisted(() => ({ store: undefined as unknown as DocStore }));
vi.mock('~/server/services/apps/doc-store.instance', () => ({ getDocStore: () => h.store }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { appsModRouter } from '~/server/routers/apps-shared.router';
import { createDocStore } from '~/server/services/apps/doc-store';
import { MOD_APP_CONCURRENCY } from '~/server/services/apps/doc-store-moderation.service';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createPgliteHarness,
  createRealPgHarness,
  REAL_PG_URL,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  BOARD,
  ctx as sctx,
  NS_PROD,
  POSTS,
  VIEWER_1,
  VIEWER_2,
} from '~/server/services/apps/__tests__/doc-store.functional';

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

// Pairwise-distinct app ids, in an order unlike their creation order.
const APP_A = {
  id: 'apb_MODA',
  blockId: 'mod-a',
  listing: { id: 'apl_moda', slug: 'mod-a-store' },
};
const APP_B = { id: 'apb_MODB', blockId: 'mod-b', listing: null };
const APP_C = { id: 'apb_MODC', blockId: 'mod-c', listing: { id: 'apl_modc', slug: 'mod-c' } };
const APPS = [APP_A, APP_B, APP_C];

const MOD = { id: 8801, isModerator: true, deletedAt: null, bannedAt: null };
const USER = { id: 8802, isModerator: false, deletedAt: null, bannedAt: null };
const R = [5101, 5202, 5303, 5404];

function ctx(user: unknown, cred: Record<string, unknown> = {}) {
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
    ...cred,
  };
}
const caller = (user: unknown = MOD, cred?: Record<string, unknown>) =>
  appsModRouter.createCaller(ctx(user, cred) as never).docStore;

let harness: Harness;
type AuditRow = { id: string; action: string; before: any; after?: any; [k: string]: unknown };
let audit: AuditRow[];

/**
 * PGlite is ONE session, and the queue runs several per-app transactions at once
 * (`MOD_APP_CONCURRENCY`), which on one session would interleave their `BEGIN`s. So
 * checkouts are serialised here, as a pool of size one would; a real pool gives each its
 * own connection.
 */
function serialised(db: DocStoreDb): DocStoreDb {
  let tail = Promise.resolve();
  return {
    async connect() {
      let unlock!: () => void;
      const prev = tail;
      tail = new Promise<void>((r) => (unlock = r));
      await prev;
      const c = await db.connect();
      return {
        query: (sql, params) => c.query(sql, params),
        release: (err) => {
          c.release(err);
          unlock();
        },
      };
    },
  };
}

beforeAll(async () => {
  // A real server when one is named (its pool connections really run in parallel), else PGlite.
  harness = REAL_PG_URL ? await createRealPgHarness() : await createPgliteHarness({ rls: true });
  h.store = createDocStore({ db: harness.concurrent ? harness.db : serialised(harness.db) });
});
afterAll(async () => {
  await harness?.close();
});

async function reset() {
  await harness.raw(
    `TRUNCATE appdata.doc, appdata.doc_index, appdata.doc_tally, appdata.doc_mark,
       appdata.doc_tomb, appdata.usage_app, appdata.usage_user`
  );
  audit = [];
}

// Spies on the store are restored even when the case that installed them fails.
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await reset();
  const toRow = (a: (typeof APPS)[number]) => ({
    id: a.id,
    blockId: a.blockId,
    appListing: a.listing,
  });
  mockRead.appBlock.findUnique.mockImplementation(async ({ where }: any) => {
    const a = APPS.find((x) => x.id === where.id);
    return a ? toRow(a) : null;
  });
  mockRead.appBlock.findMany.mockImplementation(async () => APPS.map(toRow));
  mockRead.user.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as number[]).map((id) => ({ id, username: `user${id}` }))
  );
  mockWrite.appListingModerationEvent.create.mockImplementation(async ({ data }: any) => {
    audit.push({ ...data });
    return data;
  });
  mockWrite.appListingModerationEvent.update.mockImplementation(async ({ where, data }: any) => {
    const row = audit.find((r) => r.id === where.id);
    if (row) Object.assign(row, data);
    return row;
  });
});

const v = (app: { id: string }, uid: number | null = VIEWER_1) => sctx(app.id, NS_PROD, uid);
async function report(app: { id: string }, coll: typeof POSTS, key: string, n: number) {
  for (const u of R.slice(0, n)) await h.store.mark(v(app, u), coll, key, 'report');
}

/**
 * A: posts/a1 ×3, posts/a0 ×3, board/a2 ×1.   B: posts/b1 ×2, posts/b2 ×1.   C: posts/c1 ×3.
 * Cross-app order by reports (DESC on reports, app, collection, key):
 *   C/posts/c1:3, A/posts/a1:3, A/posts/a0:3, B/posts/b1:2, B/posts/b2:1, A/board/a2:1
 * (a1/a0 tie on count, app and collection, so the TypeScript merge must order them by key.)
 */
async function seedQueue() {
  await h.store.put(v(APP_A), POSTS, 'a1', { status: 'open', score: 5 });
  await h.store.put(v(APP_A), POSTS, 'a0', { status: 'open' });
  await h.store.put(v(APP_A), BOARD, 'a2', { text: 'x' });
  await h.store.put(v(APP_B, VIEWER_2), POSTS, 'b1', { status: 'open' });
  await h.store.put(v(APP_B, VIEWER_2), POSTS, 'b2', { status: 'open' });
  await h.store.put(v(APP_C), POSTS, 'c1', { status: 'open' });
  await h.store.put(v(APP_C), POSTS, 'unreported', { status: 'open' });
  await report(APP_A, POSTS, 'a1', 3);
  await report(APP_A, POSTS, 'a0', 3);
  await report(APP_A, BOARD, 'a2', 1);
  await report(APP_B, POSTS, 'b1', 2);
  await report(APP_B, POSTS, 'b2', 1);
  await report(APP_C, POSTS, 'c1', 3);
}
const EXPECTED_ORDER = [
  'apb_MODC/posts/c1:3',
  'apb_MODA/posts/a1:3',
  'apb_MODA/posts/a0:3',
  'apb_MODB/posts/b1:2',
  'apb_MODB/posts/b2:1',
  'apb_MODA/board/a2:1',
];
const tag = (i: { appBlockId: string; collection: string; key: string; reports: number }) =>
  `${i.appBlockId}/${i.collection}/${i.key}:${i.reports}`;

describe('access: session moderators only', () => {
  const target = { appBlockId: APP_A.id, collection: 'posts', key: 'a1' };
  const calls = (c: ReturnType<typeof caller>) =>
    [
      ['listReported', () => c.listReported({})],
      ['get', () => c.get(target)],
      ['setHidden', () => c.setHidden({ ...target, hidden: true, reason: 'abuse report' })],
      ['delete', () => c.delete({ ...target, reason: 'abuse report' })],
    ] as const;

  async function expectRefusedAndUntouched(c: ReturnType<typeof caller>, code: string) {
    for (const [name, run] of calls(c)) {
      await expect(run(), name).rejects.toMatchObject({ code });
    }
    // Nothing was hidden, deleted or audited.
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
    expect(audit).toEqual([]);
  }

  it('a non-moderator session is FORBIDDEN on every procedure', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(caller(USER), 'FORBIDDEN');
  });

  it('no session (what a block token resolves to on tRPC: it is not an API key) is UNAUTHORIZED', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(caller(null), 'UNAUTHORIZED');
  });

  it('a moderator presenting a delegated (OAuth) token instead of a session is FORBIDDEN', async () => {
    await seedQueue();
    await expectRefusedAndUntouched(
      caller(MOD, { apiKeyId: 77, apiKeyType: 'Access', subject: { type: 'oauth', id: 'cli_x' } }),
      'FORBIDDEN'
    );
  });

  it('positive control: the same calls succeed for a moderator session', async () => {
    await seedQueue();
    expect((await caller().listReported({})).items).toHaveLength(6);
    expect((await caller().get(target)).key).toBe('a1');
  });
});

describe('listReported: the cross-app queue', () => {
  it('merges every app, most-reported first, with app/collection/key as tiebreaks', async () => {
    await seedQueue();
    const out = await caller().listReported({});
    expect(out.items.map(tag)).toEqual(EXPECTED_ORDER);
    expect(out.nextCursor).toBeNull();
    const a1 = out.items.find((i) => i.key === 'a1')!;
    expect(a1).toMatchObject({
      appSlug: 'mod-a-store',
      author: { kind: 'user', userId: VIEWER_1, username: `user${VIEWER_1}` },
      hidden: null,
    });
    expect(out.items.find((i) => i.key === 'b1')!.appSlug).toBe('mod-b');
  });

  it('pages across app boundaries with no duplicates or gaps, at every page size', async () => {
    await seedQueue();
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await caller().listReported({ limit, cursor });
        seen.push(...page.items.map(tag));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect({ limit, seen }).toEqual({ limit, seen: EXPECTED_ORDER });
    }
  });

  it('newest sorts by the latest report across apps', async () => {
    await seedQueue();
    const at: [string, string, string][] = [
      [APP_B.id, 'b2', '2026-05-05T00:00:00Z'],
      [APP_A.id, 'a2', '2026-05-04T00:00:00Z'],
      [APP_C.id, 'c1', '2026-05-03T00:00:00Z'],
      [APP_A.id, 'a1', '2026-05-02T00:00:00Z'],
      [APP_B.id, 'b1', '2026-05-01T00:00:00Z'],
      [APP_A.id, 'a0', '2026-04-30T00:00:00Z'],
    ];
    for (const [app, key, t] of at) {
      await harness.raw(
        `UPDATE appdata.doc_mark SET created_at = $3 WHERE app_id = $1 AND key = $2`,
        [app, key, t]
      );
    }
    const out = await caller().listReported({ sort: 'newest', limit: 2 });
    const next = await caller().listReported({
      sort: 'newest',
      limit: 10,
      cursor: out.nextCursor!,
    });
    expect([...out.items, ...next.items].map((i) => `${i.appBlockId}/${i.key}`)).toEqual(
      at.map(([app, key]) => `${app}/${key}`)
    );
  });

  it('one app only, and refuses a cursor from the other sort or a forged one', async () => {
    await seedQueue();
    const out = await caller().listReported({ appBlockId: APP_B.id });
    expect(out.items.map(tag)).toEqual(['apb_MODB/posts/b1:2', 'apb_MODB/posts/b2:1']);
    const first = await caller().listReported({ limit: 1 });
    await expect(
      caller().listReported({ sort: 'newest', cursor: first.nextCursor! })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().listReported({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().listReported({ appBlockId: 'apb_NOPE' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('asks the store once per app', async () => {
    await seedQueue();
    const spy = vi.spyOn(h.store.moderation, 'listReported');
    await caller().listReported({});
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(APPS.map((a) => a.id).sort());
  });

  it('keeps exactly MOD_APP_CONCURRENCY per-app store calls in flight, not more', async () => {
    // More apps than the limit, and store calls that overlap for as long as they are allowed
    // to, so an unbounded fan-out would reach the app count instead of the limit.
    const ids = Array.from({ length: MOD_APP_CONCURRENCY + 3 }, (_, i) => `apb_FAN${i}`);
    mockRead.appBlock.findMany.mockImplementationOnce(async () =>
      ids.map((id) => ({ id, blockId: id.toLowerCase(), appListing: null }))
    );
    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(h.store.moderation, 'listReported').mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return [];
    });
    await caller().listReported({});
    expect({ calls: spy.mock.calls.length, peak }).toEqual({
      calls: ids.length,
      peak: MOD_APP_CONCURRENCY,
    });
  });

  it('accepts the largest page size (the store is asked for limit + 1)', async () => {
    await seedQueue();
    expect((await caller().listReported({ limit: 100 })).items.map(tag)).toEqual(EXPECTED_ORDER);
  });
});

describe('get', () => {
  it('returns the data and the author for a moderator; an unknown doc or app is NOT_FOUND', async () => {
    await seedQueue();
    const doc = await caller().get({ appBlockId: APP_A.id, collection: 'posts', key: 'a1' });
    expect(doc).toMatchObject({
      data: { status: 'open', score: 5 },
      reports: 3,
      author: { userId: VIEWER_1, username: `user${VIEWER_1}` },
      hidden: null,
    });
    await expect(
      caller().get({ appBlockId: APP_A.id, collection: 'posts', key: 'nope' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().get({ appBlockId: 'apb_NOPE', collection: 'posts', key: 'a1' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Not audited: a shared document is readable by every viewer of the app.
    expect(audit).toEqual([]);
  });
});

describe('setHidden / delete: effects through the app reads, and the audit trail', () => {
  const A1 = { appBlockId: APP_A.id, collection: 'posts', key: 'a1' };

  it('hide: the app reads not found; audited BEFORE the change with a snapshot and no content', async () => {
    await seedQueue();
    let visibleWhenAudited: boolean | null = null;
    mockWrite.appListingModerationEvent.create.mockImplementationOnce(async ({ data }: any) => {
      visibleWhenAudited = (await h.store.get(v(APP_A), POSTS, 'a1')) !== null;
      audit.push({ ...data });
      return data;
    });
    const out = await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    expect(out).toMatchObject({ changed: true, auditEventId: expect.stringMatching(/^alme_/) });
    expect(visibleWhenAudited).toBe(true);
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
    expect((await h.store.list(v(APP_A), POSTS)).items.map((d) => d.key)).toEqual(['a0']);

    expect(audit).toHaveLength(1);
    const [row] = audit;
    expect(row).toMatchObject({
      id: out.auditEventId,
      action: 'storage-doc-hide',
      actorUserId: MOD.id,
      reason: 'spam report',
      appListingId: 'apl_moda',
      slug: 'mod-a-store',
      before: {
        appBlockId: APP_A.id,
        ns: 'prod',
        collection: 'posts',
        key: 'a1',
        authorUserId: VIEWER_1,
        reports: 3,
        hiddenAt: null,
        version: 1,
        dataMd5: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
      after: { outcome: 'applied', changed: true },
    });
    // The content itself never enters the audit row.
    expect(JSON.stringify(row)).not.toContain('"open"');
    expect(APP_LISTING_MODERATION_ACTIONS as readonly string[]).toContain(row.action);

    // The queue still shows it, as hidden, to moderators.
    const hidden = await caller().listReported({ status: 'hidden' });
    expect(hidden.items.map((i) => [i.key, i.hidden?.byUserId, i.hidden?.byUsername])).toEqual([
      ['a1', MOD.id, `user${MOD.id}`],
    ]);
    expect((await caller().listReported({})).items.map((i) => i.key)).not.toContain('a1');
  });

  it('unhide restores it to the app and is audited as its own action', async () => {
    await seedQueue();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().setHidden({ ...A1, hidden: false, reason: 'reviewed, fine' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toMatchObject({ key: 'a1' });
    expect(audit.map((r) => r.action)).toEqual(['storage-doc-hide', 'storage-doc-unhide']);
    expect(audit[1].before.hiddenBy).toBe(MOD.id);
  });

  it('delete: gone for the app, usage refunded, audited', async () => {
    await seedQueue();
    const before = await h.store.usage(v(APP_A));
    const doc = await caller().get(A1);
    const out = await caller().delete({ ...A1, reason: 'illegal content' });
    expect(out).toMatchObject({ deleted: true, sizeBytes: doc.sizeBytes });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
    expect(await h.store.usage(v(APP_A))).toEqual({
      app: { bytes: before.app.bytes - doc.sizeBytes, docs: before.app.docs - 1 },
      viewer: { bytes: before.viewer!.bytes - doc.sizeBytes, docs: before.viewer!.docs - 1 },
    });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-delete', 'applied'],
    ]);
    await expect(caller().get(A1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('acting on app A leaves the other apps exactly as they were', async () => {
    await seedQueue();
    const others = async () =>
      Promise.all(
        [APP_B, APP_C].map(async (app) => ({
          list: (await h.store.list(v(app), POSTS)).items.map((d) => [d.key, d.version]),
          usage: await h.store.usage(v(app)),
        }))
      );
    const before = await others();
    await caller().setHidden({ ...A1, hidden: true, reason: 'spam report' });
    await caller().delete({ ...A1, reason: 'illegal content' });
    await caller().delete({
      appBlockId: APP_A.id,
      collection: 'board',
      key: 'a2',
      reason: 'spam x',
    });
    expect(await others()).toEqual(before);
    // An app's key cannot be reached through another app's id.
    await expect(
      caller().delete({ appBlockId: APP_A.id, collection: 'posts', key: 'b1', reason: 'spam x' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await h.store.get(v(APP_B, VIEWER_2), POSTS, 'b1')).not.toBeNull();
  });

  it('a missing document is NOT_FOUND before any audit row is written', async () => {
    await seedQueue();
    await expect(
      caller().setHidden({ ...A1, key: 'nope', hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().delete({ ...A1, key: 'nope', reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit).toEqual([]);
  });

  it('when the audit row cannot be written, nothing is hidden or deleted', async () => {
    await seedQueue();
    mockWrite.appListingModerationEvent.create.mockRejectedValue(
      Object.assign(new Error('violates check constraint "app_listing_mod_events_action_check"'), {
        code: 'P2010',
      })
    );
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toThrow();
    await expect(caller().delete({ ...A1, reason: 'spam report' })).rejects.toThrow();
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
  });

  it('an action carrying the version the moderator saw is refused once the author edits', async () => {
    await seedQueue();
    const seen = await caller().get(A1);
    await h.store.put(v(APP_A), POSTS, 'a1', { status: 'edited', score: 1 });
    await expect(
      caller().delete({ ...A1, version: seen.version, reason: 'illegal content' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller().setHidden({ ...A1, hidden: true, version: seen.version, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toMatchObject({ version: 2 });
    expect(audit).toEqual([]);
    // The current version goes through.
    await caller().delete({ ...A1, version: 2, reason: 'illegal content' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).toBeNull();
  });

  it('the store action is bound to the audited snapshot version', async () => {
    await seedQueue();
    const spy = vi.spyOn(h.store.moderation, 'delete');
    await caller().delete({ ...A1, reason: 'illegal content' });
    expect(spy.mock.calls[0][4]).toEqual({ ifVersion: audit[0].before.version });
  });

  it('a store refusal after the audit row is stamped failed; any other error unknown', async () => {
    await seedQueue();
    const spy = vi
      .spyOn(h.store.moderation, 'setHidden')
      .mockRejectedValueOnce(new DocStoreError('rate_limited', 'storage is busy; retry'))
      .mockRejectedValueOnce(new Error('connection reset after commit'));
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'spam report' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(audit.map((r) => [r.action, r.after?.outcome])).toEqual([
      ['storage-doc-hide', 'failed'],
      ['storage-doc-hide', 'unknown'],
    ]);
  });

  it('a reason is required and bounded', async () => {
    await seedQueue();
    await expect(caller().delete({ ...A1, reason: '  ' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().setHidden({ ...A1, hidden: true, reason: 'x'.repeat(1001) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await h.store.get(v(APP_A), POSTS, 'a1')).not.toBeNull();
  });
});

describe('the moderation operations are reachable from the moderator service only', () => {
  // A seam ledger: fails when the set of files calling `<store>.moderation.*` grows OR
  // shrinks. The block-token routes (`doc-store-api.ts`, `pages/api/v1/blocks/storage`)
  // must never appear here. Enumerated with fs: the wrapped grep honours .gitignore.
  const SRC = path.resolve(__dirname, '../../..');
  const PATTERN = /\.moderation\.(listReported|get|setHidden|delete)\b/;
  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.') || name === '__tests__') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        if (PATTERN.test(readFileSync(full, 'utf8'))) {
          out.push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    }
    return out;
  }
  it('is exactly the moderation service', () => {
    expect(walk(SRC, []).sort()).toEqual(['server/services/apps/doc-store-moderation.service.ts']);
  });
});
