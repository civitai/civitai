import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearchSync, mockMetricsSync } = vi.hoisted(() => ({
  mockSearchSync: vi.fn(),
  mockMetricsSync: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  imagesSearchIndex: { updateSync: mockSearchSync },
  imagesMetricsSearchIndex: { updateSync: mockMetricsSync },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  UNRUNNABLE_JOB_CRON: '0 0 31 2 *',
}));

import { reindexRecentScheduledImages } from '~/server/jobs/reindex-recent-scheduled-images';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mockDbRead = dbMock.dbRead;

type JobResult = {
  posts: number;
  images: number;
  beforeAt?: Date;
  beforeId?: number;
  done: boolean;
};
const runJob = (query: Record<string, string> = {}) =>
  (
    reindexRecentScheduledImages as unknown as (ctx: { req?: NextApiRequest }) => Promise<JobResult>
  )({ req: { query } as unknown as NextApiRequest });

const AT = new Date('2026-09-01T10:00:00.000Z');
const postRows = (...pairs: [number, Date][]) =>
  pairs.map(([id, publishedAt]) => ({ id, publishedAt }));
const imageRows = (...ids: number[]) => ids.map((id) => ({ id }));

// Two reads per run, routed on SQL text so adding a read doesn't shift these.
const stubReads = ({
  posts,
  images,
}: {
  posts: { id: number; publishedAt: Date }[];
  images: { id: number }[];
}) => {
  mockDbRead.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = (args[0] as string[]).join(' ');
    if (sql.includes('FROM "Post" p')) return posts;
    if (sql.includes('FROM "Image"')) return images;
    return [];
  });
};

const postQueryCall = () =>
  mockDbRead.$queryRaw.mock.calls.find((args) =>
    (args[0] as string[]).join(' ').includes('FROM "Post" p')
  ) as unknown[];

type SqlFragment = { strings: string[]; values: unknown[] };
const isFragment = (v: unknown): v is SqlFragment =>
  !!v && typeof v === 'object' && Array.isArray((v as SqlFragment).strings);

// The cursor is interpolated as a nested Prisma.sql fragment, so the outer template holds
// it as a VALUE rather than as text. Render both levels or the shape assertions below
// silently pass against SQL that no longer contains what they claim to check.
const postQuerySql = () => {
  const [strings, ...values] = postQueryCall() as [string[], ...unknown[]];
  return strings
    .map((s, i) => s + (isFragment(values[i]) ? values[i].strings.join(' ? ') : ''))
    .join('');
};

const postQueryValues = () => {
  const [, ...values] = postQueryCall() as [string[], ...unknown[]];
  return values.flatMap((v) => (isFragment(v) ? v.values : [v]));
};

beforeEach(() => {
  vi.clearAllMocks();
  stubReads({ posts: postRows([10, AT], [11, AT]), images: imageRows(100, 101) });
});

describe('reindexRecentScheduledImages', () => {
  // images_v6 is the half that was never covered: the metrics index takes every image and
  // filters at query time, so a stale doc is merely mis-sorted there, while images_v6
  // rejects a future-dated post outright and the image is absent from site search.
  it('syncs both image indexes by default', async () => {
    await runJob();
    const data = imageRows(100, 101).map(({ id }) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }));
    expect(mockSearchSync).toHaveBeenCalledWith(data, expect.anything());
    expect(mockMetricsSync).toHaveBeenCalledWith(data, expect.anything());
  });

  it('syncs only the index named in `indexes`', async () => {
    await runJob({ indexes: 'search' });
    expect(mockSearchSync).toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  it('rejects an unknown index rather than silently syncing both', async () => {
    await expect(runJob({ indexes: 'bogus' })).rejects.toThrow();
    expect(mockSearchSync).not.toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  it('returns the last post as the resume cursor', async () => {
    const last = new Date('2026-08-30T09:00:00.000Z');
    stubReads({ posts: postRows([10, AT], [11, last]), images: imageRows(100) });
    const result = await runJob({ limit: '2' });
    expect(result).toEqual({ posts: 2, images: 1, beforeAt: last, beforeId: 11, done: false });
  });

  it('reports done when the page comes back short', async () => {
    stubReads({ posts: postRows([10, AT]), images: imageRows(100) });
    const result = await runJob({ limit: '5' });
    expect(result).toMatchObject({ posts: 1, done: true });
  });

  it('passes the cursor and limit into the post query', async () => {
    const at = new Date('2026-08-20T00:00:00.000Z');
    await runJob({ beforeAt: at.toISOString(), beforeId: '77', limit: '250' });
    const values = postQueryValues();
    expect(values).toContainEqual(at);
    expect(values).toContain(77);
    expect(values).toContain(250);
  });

  it('syncs nothing and stops when the page is empty', async () => {
    stubReads({ posts: [], images: [] });
    const result = await runJob();
    expect(mockSearchSync).not.toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ posts: 0, images: 0, done: true });
  });

  it('does not sync when the page of posts carries no images', async () => {
    stubReads({ posts: postRows([10, AT]), images: [] });
    await runJob();
    expect(mockSearchSync).not.toHaveBeenCalled();
    expect(mockMetricsSync).not.toHaveBeenCalled();
  });

  // Accepting half a cursor would restart from the newest page while the operator believed
  // they were resuming, so they would re-walk everything already done and never notice.
  it('rejects half a cursor rather than silently restarting', async () => {
    await expect(runJob({ beforeId: '77' })).rejects.toThrow();
    await expect(runJob({ beforeAt: AT.toISOString() })).rejects.toThrow();
    expect(mockSearchSync).not.toHaveBeenCalled();
  });
});

// A plan regression is invisible to a suite with a mocked database, so this asserts the
// SHAPE that keeps the plan. Paging on Image.id made the planner walk Image_pkey from the
// low end across 47.5M rows (limit-node cost 1.06e6 vs 4.1e3; no page returned in 180s),
// because every matching post is recent and its images sort last. `Post_feed_covering_idx`
// is btree ("publishedAt" DESC, id DESC), so only this ordering is an Index Cond.
describe('reindexRecentScheduledImages :: query shape that keeps the index', () => {
  it('pages over posts ordered by ("publishedAt", id) DESC', async () => {
    await runJob();
    expect(postQuerySql().replace(/\s+/g, ' ')).toContain(
      'ORDER BY p."publishedAt" DESC, p.id DESC'
    );
  });

  it('compares the cursor as a row, so the id breaks ties on publishedAt', async () => {
    await runJob({ beforeAt: AT.toISOString(), beforeId: '77' });
    expect(postQuerySql().replace(/\s+/g, ' ')).toContain('(p."publishedAt", p.id) <');
  });

  // The alternative was seeding the cursor with a sentinel "greater than every row" — a
  // hardcoded max id and max date, both of which encode an assumption nothing checks.
  // Omitting the clause is what makes those constants unnecessary.
  it('omits the cursor clause entirely on the first page', async () => {
    await runJob();
    expect(postQuerySql()).not.toContain('(p."publishedAt", p.id) <');
    expect(postQueryValues()).not.toContain(2147483647);
  });

  it('never orders or cursors on Image.id', async () => {
    await runJob();
    const sql = postQuerySql().replace(/\s+/g, ' ');
    expect(sql).not.toContain('ORDER BY i.id');
    expect(sql).not.toMatch(/i\.id >/);
  });
});
