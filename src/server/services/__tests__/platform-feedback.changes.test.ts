import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as FeedbackService from '~/server/services/feedback.service';
import type { CreatePlatformFeedbackInput } from '~/server/schema/platform-feedback.schema';
import type { SessionUser } from '~/types/session';
// Relative, because `~` does not reach `apps/`.
import {
  feedbackKysely,
  freshAppFeedbackDb,
  seedUser,
} from '../../../../apps/moderator/src/lib/server/__tests__/feedback-pglite.harness';

/**
 * The moderator change feed against real rows: the service's own writes and the moderator app's
 * REAL triage write on one PGlite database, so a change surfaces only if the column or key the
 * writer actually moves is one the feed reads.
 */

const mocks = vi.hoisted(() => ({
  isFeedbackAreaEnabled: vi.fn(),
  moderatorDb: { current: null as unknown },
}));

vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  isFeedbackAreaEnabled: mocks.isFeedbackAreaEnabled,
}));

vi.mock('../../../../apps/moderator/src/lib/server/db', () => ({
  get dbRead() {
    return mocks.moderatorDb.current;
  },
  get dbWrite() {
    return mocks.moderatorDb.current;
  },
}));

const { createPlatformFeedback, listPlatformFeedbackChanges, PLATFORM_FEEDBACK_CHANGES_SETTLE_MS } =
  await import('../platform-feedback.service');
const { triageFeedback, bulkTriageFeedback } = await import(
  '../../../../apps/moderator/src/lib/server/feedback.service'
);

const MINUTE = 60_000;
const SETTLED = PLATFORM_FEEDBACK_CHANGES_SETTLE_MS + 1_000;

let pg: PGlite;
let alice: number;
let bob: number;
let moderator: number;
/**
 * The fake clock starts an hour AHEAD of the real one. `createdAt` is the database's own default,
 * stamped off the real clock, so every service-stamped time the tests move is later than it and
 * decides the change time.
 */
let t0: number;
const at = (offsetMs: number) => vi.setSystemTime(new Date(t0 + offsetMs));

const userOf = (id: number) => ({ id } as SessionUser);

const report = (
  ref: string | undefined,
  version = '2.3.4'
): CreatePlatformFeedbackInput['report'] => ({
  about: 'cli',
  kind: 'bug',
  ref,
  client: { name: 'civitai-cli', version },
  command: 'civitai app submit',
  errorExcerpt: 'Error: REFUSED',
});

const send = (userId: number, message: string, ref?: string, version?: string) =>
  createPlatformFeedback({
    user: userOf(userId),
    input: { message, report: report(ref, version) },
  });

const idOf = (ref: string) => Number(ref.split('-')[0]);

const clientOver = (target: PGlite | Transaction) => ({
  $queryRaw: async (q: Prisma.Sql) => (await target.query(q.text, q.values)).rows,
  $executeRaw: async (q: Prisma.Sql) => (await target.query(q.text, q.values)).affectedRows ?? 0,
  $executeRawUnsafe: async (text: string) => (await target.query(text)).affectedRows ?? 0,
});

/**
 * Every page from `cursor` on; capped so a cursor that never advances fails instead of hanging.
 * The cursor goes back exactly as the feed handed it out, `null` included, as a caller would.
 */
async function drain(cursor?: string | null, limit = 50) {
  const items: Awaited<ReturnType<typeof listPlatformFeedbackChanges>>['items'] = [];
  let next = cursor;
  for (let page = 0; page < 20; page++) {
    const res = await listPlatformFeedbackChanges({ cursor: next, limit });
    items.push(...res.items);
    next = res.nextCursor;
    if (!res.hasMore) return { items, resume: res.nextCursor, pages: page + 1 };
  }
  throw new Error('the feed did not stop paging');
}

beforeEach(async () => {
  setEnv({ MODERATOR_APP_URL: 'https://mod.example.test' });
  t0 = Math.ceil((Date.now() + 60 * MINUTE) / 1000) * 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  pg = await freshAppFeedbackDb();
  mocks.moderatorDb.current = feedbackKysely(pg);
  alice = await seedUser(pg, 'alice');
  bob = await seedUser(pg, 'bob');
  moderator = await seedUser(pg, 'quinn');
  mocks.isFeedbackAreaEnabled.mockReset().mockResolvedValue(true);
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    pg.transaction((tx) => fn(clientOver(tx)))) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(clientOver(pg).$queryRaw as never);
});

afterEach(async () => {
  vi.useRealTimers();
  mocks.moderatorDb.current = null;
  await pg.close();
});

describe('listPlatformFeedbackChanges', () => {
  it('hands out each row once, then nothing while no row changes', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(MINUTE);
    const b = await send(bob, 'the docs page is wrong');
    at(MINUTE + SETTLED);

    const first = await drain();
    expect(first.items.map((i) => i.id)).toEqual([idOf(a.ref), idOf(b.ref)]);
    expect(first.items[0]).toMatchObject({
      status: 'new',
      handled: false,
      about: 'cli',
      kind: 'bug',
      ref: 'submit.server-refused',
      message: 'submit refused',
      client: { name: 'civitai-cli', version: '2.3.4' },
      details: { command: 'civitai app submit', errorExcerpt: 'Error: REFUSED' },
      reporters: 1,
      reports: 1,
      regressionOf: null,
      reopenOf: null,
      resolution: null,
      updatedAt: new Date(t0).toISOString(),
      moderatorUrl: `https://mod.example.test/feedback/${idOf(a.ref)}`,
    });

    at(30 * MINUTE);
    expect(await listPlatformFeedbackChanges({ cursor: first.resume ?? undefined })).toEqual({
      items: [],
      nextCursor: first.resume,
      hasMore: false,
    });
  });

  it('hands a row out again when a repeat report merges into it, and only that row', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    await send(alice, 'the docs page is wrong');
    at(SETTLED);
    const { resume } = await drain();

    at(10 * MINUTE);
    const repeat = await send(bob, 'same refusal here', 'submit.server-refused', '2.3.5');
    expect(repeat).toMatchObject({ duplicate: true, ref: a.ref });
    at(10 * MINUTE + SETTLED);

    const { items } = await drain(resume);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: idOf(a.ref),
      reporters: 2,
      reports: 2,
      samples: [{ text: 'same refusal here', clientVersion: '2.3.5' }],
      updatedAt: new Date(t0 + 10 * MINUTE).toISOString(),
    });
  });

  it('hands out a repeat from a reporter the row already counts', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(SETTLED);
    const { resume } = await drain();

    at(5 * MINUTE);
    await send(alice, 'submit refused again', 'submit.server-refused');
    at(5 * MINUTE + SETTLED);

    expect((await drain(resume)).items).toMatchObject([
      { id: idOf(a.ref), reporters: 1, reports: 2 },
    ]);
  });

  it('hands out a moderator status change and a resolution', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(SETTLED);
    const { resume } = await drain();

    at(5 * MINUTE);
    expect(
      await triageFeedback({
        id: idOf(a.ref),
        status: 'reviewed',
        expectedStatus: 'new',
        moderatorId: moderator,
      })
    ).toEqual({ ok: true, changed: true });
    at(5 * MINUTE + SETTLED);
    const triaged = await drain(resume);
    expect(triaged.items).toMatchObject([
      {
        id: idOf(a.ref),
        status: 'reviewed',
        handled: true,
        handledAt: new Date(t0 + 5 * MINUTE).toISOString(),
      },
    ]);

    // A resolution-only save leaves `handledAt` alone; it surfaces by `resolution.at` and the
    // write's `changedAt`. Each time on its own is pinned by the legacy-row test below.
    at(9 * MINUTE);
    expect(
      await triageFeedback({
        id: idOf(a.ref),
        status: 'reviewed',
        expectedStatus: 'reviewed',
        resolution: {
          kind: 'set',
          expectedAt: null,
          fixedIn: { component: 'cli', version: '2.4.0' },
          publicNote: 'Fixed in 2.4.0',
        },
        moderatorId: moderator,
      })
    ).toEqual({ ok: true, changed: true });
    at(9 * MINUTE + SETTLED);
    expect((await drain(triaged.resume)).items).toMatchObject([
      {
        id: idOf(a.ref),
        handledAt: new Date(t0 + 5 * MINUTE).toISOString(),
        updatedAt: new Date(t0 + 9 * MINUTE).toISOString(),
        resolution: {
          fixedIn: { component: 'cli', version: '2.4.0' },
          publicNote: 'Fixed in 2.4.0',
          at: new Date(t0 + 9 * MINUTE).toISOString(),
        },
      },
    ]);
  });

  it('keeps a resolution component that has no version', async () => {
    const a = await send(alice, 'the docs page is wrong', 'docs.page-404');
    await triageFeedback({
      id: idOf(a.ref),
      status: 'actioned',
      expectedStatus: 'new',
      resolution: {
        kind: 'set',
        expectedAt: null,
        fixedIn: { component: 'docs', version: '' },
        publicNote: null,
      },
      moderatorId: moderator,
    });
    at(SETTLED);
    expect((await drain()).items).toMatchObject([
      { resolution: { fixedIn: { component: 'docs', version: null }, publicNote: null } },
    ]);
  });

  it('hands out the row a dismissed report reopens into, marked as a reopen', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    await triageFeedback({
      id: idOf(a.ref),
      status: 'dismissed',
      expectedStatus: 'new',
      moderatorId: moderator,
    });
    const others = [bob, ...(await Promise.all(['c', 'd', 'e'].map((n) => seedUser(pg, n))))];
    at(SETTLED);
    const { resume } = await drain();

    // Three new reporters are absorbed by the dismissal; the fourth opens a new row.
    at(5 * MINUTE);
    for (const user of others.slice(0, 3))
      await send(user, 'still refused', 'submit.server-refused');
    at(6 * MINUTE);
    const reopened = await send(others[3], 'still refused', 'submit.server-refused');
    expect(reopened.duplicate).toBe(false);
    at(6 * MINUTE + SETTLED);

    const { items } = await drain(resume);
    expect(items.map((i) => i.id)).toEqual([idOf(a.ref), idOf(reopened.ref)]);
    expect(items[0]).toMatchObject({ status: 'dismissed', reporters: 4, reopenOf: null });
    expect(items[1]).toMatchObject({ status: 'new', reopenOf: idOf(a.ref), regressionOf: null });
  });

  it('hands out the row a regression opens, marked as a regression', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    await triageFeedback({
      id: idOf(a.ref),
      status: 'actioned',
      expectedStatus: 'new',
      resolution: {
        kind: 'set',
        expectedAt: null,
        fixedIn: { component: 'cli', version: '2.4.0' },
        publicNote: null,
      },
      moderatorId: moderator,
    });
    at(SETTLED);
    const { resume } = await drain();

    at(5 * MINUTE);
    const regressed = await send(
      bob,
      'refused on the fixed version',
      'submit.server-refused',
      '2.4.1'
    );
    at(5 * MINUTE + SETTLED);

    expect((await drain(resume)).items).toMatchObject([
      { id: idOf(regressed.ref), regressionOf: idOf(a.ref), reopenOf: null, status: 'new' },
    ]);
  });

  it('pages rows that changed in the same millisecond in id order, none twice or skipped', async () => {
    const sent = [];
    for (const [i, user] of [alice, bob, alice, bob, alice].entries())
      sent.push(await send(user, `distinct report ${i}`));
    at(SETTLED);

    const { items, pages } = await drain(undefined, 2);
    expect(pages).toBe(3);
    expect(items.map((i) => i.id)).toEqual(sent.map((s) => idOf(s.ref)));
  });

  it('never returns a reporter id, nor the fingerprint a free-text report hashes one into', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    await send(bob, 'same refusal here', 'submit.server-refused');
    await send(bob, 'the docs page is wrong');
    at(SETTLED);

    const { items } = await drain();
    expect(items).toHaveLength(2);
    const stored = (
      await pg.query<{ context: { server: Record<string, unknown> } }>(
        'SELECT "context" FROM "Feedback" WHERE "id" = $1',
        [idOf(a.ref)]
      )
    ).rows[0].context.server;
    // The control: the row does hold both ids, and bob's sample carries his.
    expect(stored.reporterIds).toEqual([alice, bob]);
    expect(stored.samples).toEqual([
      { userId: bob, text: 'same refusal here', clientVersion: '2.3.4' },
    ]);

    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
    };
    walk(items);
    for (const key of ['userId', 'reporterIds', 'fingerprint', 'byId'])
      expect(keys).not.toContain(key);
    expect(items[0].samples).toEqual([{ text: 'same refusal here', clientVersion: '2.3.4' }]);
  });

  it('hands a row out again when a moderator clears its resolution', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(5 * MINUTE);
    await triageFeedback({
      id: idOf(a.ref),
      status: 'actioned',
      expectedStatus: 'new',
      resolution: {
        kind: 'set',
        expectedAt: null,
        fixedIn: { component: 'cli', version: '2.4.0' },
        publicNote: null,
      },
      moderatorId: moderator,
    });
    at(5 * MINUTE + SETTLED);
    const { resume } = await drain();

    // Clearing removes `resolution.at` and leaves `handledAt` alone, so neither can carry it.
    at(9 * MINUTE);
    expect(
      await triageFeedback({
        id: idOf(a.ref),
        status: 'actioned',
        expectedStatus: 'actioned',
        resolution: { kind: 'clear', expectedAt: new Date(t0 + 5 * MINUTE).toISOString() },
        moderatorId: moderator,
      })
    ).toEqual({ ok: true, changed: true });
    at(9 * MINUTE + SETTLED);
    expect((await drain(resume)).items).toMatchObject([
      {
        id: idOf(a.ref),
        resolution: null,
        handledAt: new Date(t0 + 5 * MINUTE).toISOString(),
        updatedAt: new Date(t0 + 9 * MINUTE).toISOString(),
      },
    ]);
  });

  it('hands a row out again when a moderator moves it back to new', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(5 * MINUTE);
    await triageFeedback({
      id: idOf(a.ref),
      status: 'reviewed',
      expectedStatus: 'new',
      moderatorId: moderator,
    });
    at(5 * MINUTE + SETTLED);
    const { resume } = await drain();

    // A move back to `new` nulls `handledAt`.
    at(9 * MINUTE);
    await triageFeedback({
      id: idOf(a.ref),
      status: 'new',
      expectedStatus: 'reviewed',
      moderatorId: moderator,
    });
    at(9 * MINUTE + SETTLED);
    expect((await drain(resume)).items).toMatchObject([
      {
        id: idOf(a.ref),
        status: 'new',
        handled: false,
        handledAt: null,
        updatedAt: new Date(t0 + 9 * MINUTE).toISOString(),
      },
    ]);
  });

  it('hands rows out again when a bulk triage moves them back to new', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    const b = await send(bob, 'the docs page is wrong');
    at(5 * MINUTE);
    await bulkTriageFeedback({
      rows: [a, b].map((s) => ({ id: idOf(s.ref), expectedStatus: 'new' as const })),
      status: 'dismissed',
      moderatorId: moderator,
    });
    at(5 * MINUTE + SETTLED);
    const { resume } = await drain();

    at(9 * MINUTE);
    expect(
      await bulkTriageFeedback({
        rows: [a, b].map((s) => ({ id: idOf(s.ref), expectedStatus: 'dismissed' as const })),
        status: 'new',
        moderatorId: moderator,
      })
    ).toMatchObject({ actionable: 2 });
    at(9 * MINUTE + SETTLED);
    const { items } = await drain(resume);
    expect(items.map((i) => [i.id, i.status, i.updatedAt])).toEqual(
      [a, b].map((s) => [idOf(s.ref), 'new', new Date(t0 + 9 * MINUTE).toISOString()])
    );
  });

  it('holds a change back until it is 30 seconds old, by the clock', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    at(29_000);
    const early = await listPlatformFeedbackChanges({});
    expect(early).toEqual({ items: [], nextCursor: null, hasMore: false });
    at(31_000);
    // The empty page's `null` cursor goes back as it came: it means "from the start".
    expect(
      (await listPlatformFeedbackChanges({ cursor: early.nextCursor })).items.map((i) => i.id)
    ).toEqual([idOf(a.ref)]);
  });

  it('says there is no more when the page holds exactly the rows left', async () => {
    await send(alice, 'submit refused', 'submit.server-refused');
    await send(bob, 'the docs page is wrong');
    at(SETTLED);
    expect(await listPlatformFeedbackChanges({ limit: 2 })).toMatchObject({ hasMore: false });
    expect(await listPlatformFeedbackChanges({ limit: 1 })).toMatchObject({ hasMore: true });
  });

  it('strips reporter ids and the fingerprint in SQL, before a row reaches the service', async () => {
    const a = await send(alice, 'submit refused', 'submit.server-refused');
    await send(bob, 'same refusal here', 'submit.server-refused');
    at(SETTLED);
    const stored = (
      await pg.query<{ context: { server: Record<string, unknown> } }>(
        'SELECT "context" FROM "Feedback" WHERE "id" = $1',
        [idOf(a.ref)]
      )
    ).rows[0].context.server;
    // The control: the row holds both keys.
    expect(stored.reporterIds).toEqual([alice, bob]);
    expect(typeof stored.fingerprint).toBe('string');

    const query = clientOver(pg).$queryRaw;
    const selected: Array<Record<string, unknown>> = [];
    dbMock.dbWrite.$queryRaw.mockImplementation((async (q: Prisma.Sql) => {
      const rows = (await query(q)) as Array<Record<string, unknown>>;
      selected.push(...rows);
      return rows;
    }) as never);
    expect((await listPlatformFeedbackChanges({})).items).toHaveLength(1);

    expect(selected).toHaveLength(1);
    const server = selected[0].server as Record<string, unknown>;
    expect(server.reports).toBe(2);
    expect(server).not.toHaveProperty('reporterIds');
    expect(server).not.toHaveProperty('fingerprint');
  });

  /**
   * Rows a moderator triaged before `changedAt` existed carry only `handledAt` or `resolution.at`,
   * and a row whose `server` lacks `lastSeenAt` carries only `createdAt`. The moderator write now
   * stamps `changedAt` as well, so only rows shaped like these show that each older time is read.
   */
  it('hands out a legacy row by the one time it carries', async () => {
    const triaged = idOf((await send(alice, 'submit refused', 'submit.server-refused')).ref);
    const resolved = idOf((await send(bob, 'the docs page is wrong')).ref);
    const created = (
      await pg.query<{ id: number }>(
        `INSERT INTO "Feedback" ("area", "userId", "message", "context", "createdAt")
         VALUES ('apps-platform', $1, 'no times in server', '{"server": {"reports": 1}}'::jsonb, $2)
         RETURNING "id"`,
        [alice, new Date(t0 + 2 * MINUTE)]
      )
    ).rows[0].id;
    at(2 * MINUTE + SETTLED);
    const { resume, items: first } = await drain();
    expect(first.map((i) => [i.id, i.updatedAt])).toEqual([
      [triaged, new Date(t0).toISOString()],
      [resolved, new Date(t0).toISOString()],
      [created, new Date(t0 + 2 * MINUTE).toISOString()],
    ]);

    // Written as the moderator app wrote them before it stamped `changedAt`.
    await pg.query(
      `UPDATE "Feedback" SET "status" = 'reviewed', "handledById" = $2, "handledAt" = $3 WHERE "id" = $1`,
      [triaged, moderator, new Date(t0 + 5 * MINUTE)]
    );
    await pg.query(
      `UPDATE "Feedback" SET "context" = jsonb_set("context", '{server,resolution}', $2::jsonb) WHERE "id" = $1`,
      [resolved, JSON.stringify({ publicNote: 'n', at: new Date(t0 + 7 * MINUTE).toISOString() })]
    );
    at(7 * MINUTE + SETTLED);
    const { items } = await drain(resume);
    expect(items.map((i) => [i.id, i.updatedAt])).toEqual([
      [triaged, new Date(t0 + 5 * MINUTE).toISOString()],
      [resolved, new Date(t0 + 7 * MINUTE).toISOString()],
    ]);
  });
});
