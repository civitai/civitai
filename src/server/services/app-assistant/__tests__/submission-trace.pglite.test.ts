import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

/**
 * The moderator reads over `app_publish_request_traces` against a real database built from the
 * MIGRATION FILES THEMSELVES (both tracing tables), so the SQL the aggregate runs and the columns
 * the paginated read selects are the ones the tables have. The canonical db mock's `dbRead` is
 * pointed at the PGlite client.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const migration = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`,
        import.meta.url
      )
    ),
    'utf8'
  );

const { aggregateSignals, getAppTraces, getRequestTrace } = await import(
  '~/server/services/app-assistant/submission-trace.service'
);
const { backfillPage, writeReplacingEmptyTrace } = await import(
  '~/server/services/app-assistant/trace-backfill'
);

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TABLE "User" (id integer PRIMARY KEY);
    INSERT INTO "User" VALUES (7301), (7402);
    CREATE TABLE "app_block_publish_requests" (
      id text PRIMARY KEY, slug text NOT NULL, version text NOT NULL, status text NOT NULL,
      submitted_at timestamptz(6) NOT NULL, submitted_by_user_id integer NOT NULL,
      bundle_key text NOT NULL DEFAULT ''
    );
    ${migration('20271124120000_app_assistant_session_links')}
    ${migration('20271124130000_app_publish_request_traces')}
  `);
});
afterAll(() => h?.stop());

beforeEach(async () => {
  await h.pg.exec(`
    DELETE FROM app_publish_request_traces; DELETE FROM app_block_publish_requests;
    DELETE FROM app_assistant_session_links;
  `);
  for (const client of [dbMock.dbRead] as const) {
    client.$queryRaw.mockImplementation((...args: unknown[]) =>
      (h.prisma.$queryRaw as (...a: unknown[]) => unknown)(...args)
    );
    client.appBlockPublishRequest.findMany.mockImplementation((args: unknown) =>
      h.prisma.appBlockPublishRequest.findMany(args as never)
    );
    client.appBlockPublishRequest.findUnique.mockImplementation((args: unknown) =>
      h.prisma.appBlockPublishRequest.findUnique(args as never)
    );
    client.appPublishRequestTrace.findUnique.mockImplementation((args: unknown) =>
      h.prisma.appPublishRequestTrace.findUnique(args as never)
    );
    client.appAssistantSessionLink.findMany.mockImplementation((args: unknown) =>
      h.prisma.appAssistantSessionLink.findMany(args as never)
    );
  }
});

async function request(id: string, slug: string, submittedAt: string, userId = 7301) {
  await h.pg.query(
    `INSERT INTO app_block_publish_requests VALUES ($1, $2, '0.1.0', 'pending', $3, $4)`,
    [id, slug, submittedAt, userId]
  );
}

async function trace(
  id: string,
  slug: string,
  createdAt: string,
  signals: Record<string, unknown>,
  conversationIds: string[] = []
) {
  await h.pg.query(
    `INSERT INTO app_publish_request_traces
       (publish_request_id, slug, user_id, conversation_ids, snapshots, signals, signals_version, created_at)
     VALUES ($1, $2, 7301, $3, '[]', $4, 1, $5)`,
    [id, slug, conversationIds, JSON.stringify(signals), createdAt]
  );
}

describe('aggregateSignals', () => {
  it('counts per ISO week: traced, with sessions, customised / default / unknown theme, averages', async () => {
    // Week of Mon 2026-11-09, and week of Mon 2026-11-16.
    await request('r1', 'a', '2026-11-10T10:00:00Z');
    await request('r2', 'b', '2026-11-11T10:00:00Z');
    await request('r3', 'c', '2026-11-12T10:00:00Z');
    await request('r4', 'd', '2026-11-17T10:00:00Z');
    await trace(
      'r1',
      'a',
      '2026-11-10T10:00:00Z',
      {
        themeCustomized: false,
        turnCount: 4,
        buzzTotal: 10,
        readDocsTopics: ['/apps/theme', '/apps/sdk'],
      },
      ['c1']
    );
    await trace(
      'r2',
      'b',
      '2026-11-11T10:00:00Z',
      {
        themeCustomized: true,
        turnCount: 8,
        buzzTotal: 30,
        readDocsTopics: ['/apps/theme'],
      },
      ['c2', 'c3']
    );
    await trace('r3', 'c', '2026-11-12T10:00:00Z', { themeCustomized: null });
    await trace('r4', 'd', '2026-11-17T10:00:00Z', { themeCustomized: false, readDocsTopics: [] });

    const result = await aggregateSignals({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-30T00:00:00Z'),
    });
    expect(result.weeks).toEqual([
      {
        week: '2026-11-09',
        submissions: 3,
        withSessions: 2,
        themeCustomized: 1,
        themeDefault: 1,
        themeUnknown: 1,
        avgTurns: 6,
        avgBuzz: 20,
      },
      {
        week: '2026-11-16',
        submissions: 1,
        withSessions: 0,
        themeCustomized: 0,
        themeDefault: 1,
        themeUnknown: 0,
        avgTurns: null,
        avgBuzz: null,
      },
    ]);
    expect(result.docsTopics).toEqual([
      { topic: '/apps/theme', submissions: 2, themeCustomized: 1 },
      { topic: '/apps/sdk', submissions: 1, themeCustomized: 0 },
    ]);
  });

  it('the window is [from, to): a row at `to` is out', async () => {
    await request('r5', 'e', '2026-11-20T00:00:00Z');
    await trace('r5', 'e', '2026-11-20T00:00:00Z', { themeCustomized: true });
    const at = await aggregateSignals({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-11-20T00:00:00Z'),
    });
    expect(at.weeks).toEqual([]);
  });
});

describe('getAppTraces / getRequestTrace', () => {
  it('pages an app’s requests newest first with their traces, and lists its links', async () => {
    await request('r-old', 'app-x', '2026-11-01T00:00:00Z');
    await request('r-mid', 'app-x', '2026-11-05T00:00:00Z');
    await request('r-new', 'app-x', '2026-11-09T00:00:00Z');
    await request('r-other', 'app-y', '2026-11-10T00:00:00Z');
    await trace('r-mid', 'app-x', '2026-11-05T00:00:00Z', { themeCustomized: true }, ['c-mid']);
    await h.pg.query(
      `INSERT INTO app_assistant_session_links (user_id, conversation_id, app_slug, turn_count)
       VALUES (7301, 'c-mid', 'app-x', 3), (7402, 'c-stranger', 'app-x', 1), (7301, 'c-y', 'app-y', 2)`
    );

    const first = await getAppTraces('app-x', { limit: 2 });
    expect(
      first.requests.map(({ request, trace }) => [request.id, trace?.conversationIds ?? null])
    ).toEqual([
      ['r-new', null],
      ['r-mid', ['c-mid']],
    ]);
    expect(first.nextCursor).toBe('r-mid');
    expect(first.links.map((l) => [l.userId, l.conversationId]).sort()).toEqual([
      [7301, 'c-mid'],
      [7402, 'c-stranger'],
    ]);

    const second = await getAppTraces('app-x', { limit: 2, cursor: first.nextCursor! });
    expect(second.requests.map(({ request }) => request.id)).toEqual(['r-old']);
    expect(second.nextCursor).toBeNull();

    // One request: only the SUBMITTER's links to the app.
    const one = await getRequestTrace('r-mid');
    expect(one!.trace).toMatchObject({
      publishRequestId: 'r-mid',
      signals: { themeCustomized: true },
    });
    expect(one!.links.map((l) => l.conversationId)).toEqual(['c-mid']);
    expect(await getRequestTrace('r-missing')).toBeNull();
  });
});

describe('the backfill’s page and write', () => {
  async function three() {
    await request('r-untraced', 'app-u', '2026-11-03T00:00:00Z');
    await request('r-empty', 'app-e', '2026-11-02T00:00:00Z');
    await request('r-chats', 'app-c', '2026-11-01T00:00:00Z');
    await trace('r-empty', 'app-e', '2026-11-02T00:00:00Z', { themeCustomized: true });
    await trace('r-chats', 'app-c', '2026-11-01T00:00:00Z', { themeCustomized: false }, ['c-kept']);
  }

  it('pages untraced requests newest first; with includeEmpty, zero-chat traces too; never one with chats', async () => {
    await three();
    const ids = async (includeEmpty: boolean, after?: string) =>
      (await backfillPage(h.prisma, { take: 10, includeEmpty, ...(after ? { after } : {}) })).map(
        (r) => r.id
      );
    expect(await ids(false)).toEqual(['r-untraced']);
    expect(await ids(true)).toEqual(['r-untraced', 'r-empty']);
    // The cursor resumes strictly after the request it names.
    expect(await ids(true, 'r-untraced')).toEqual(['r-empty']);
  });

  it('replaces a zero-chat trace in place, and never overwrites a trace with chats', async () => {
    await three();
    const row = (publishRequestId: string) => ({
      publishRequestId,
      slug: 'x',
      userId: 7301,
      conversationIds: ['c-new'],
      snapshots: [{ conversationId: 'c-new', key: 'k' }],
      signals: { themeCustomized: false },
      signalsVersion: 1,
      snapshotError: null,
    });
    expect(await writeReplacingEmptyTrace(h.prisma, row('r-empty'))).toBe('replaced');
    expect(await writeReplacingEmptyTrace(h.prisma, row('r-untraced'))).toBe('created');
    await expect(writeReplacingEmptyTrace(h.prisma, row('r-chats'))).rejects.toThrow();
    await h.recover();
    const { rows } = await h.pg.query<{ publish_request_id: string; conversation_ids: string[] }>(
      'SELECT publish_request_id, conversation_ids FROM app_publish_request_traces ORDER BY 1'
    );
    expect(rows).toEqual([
      { publish_request_id: 'r-chats', conversation_ids: ['c-kept'] },
      { publish_request_id: 'r-empty', conversation_ids: ['c-new'] },
      { publish_request_id: 'r-untraced', conversation_ids: ['c-new'] },
    ]);
  });
});
