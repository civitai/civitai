import { describe, expect, it, vi } from 'vitest';

/**
 * With no `AGENT_REPORTER_USER_IDS` the feature is off: no queue offers the control (`agentFilter` is
 * null, which is what every filter bar renders it on) and a pasted `?agents=` changes nothing.
 */

delete process.env.AGENT_REPORTER_USER_IDS;

const getReports = vi.fn(async (_params: unknown) => ({
  items: [],
  totalItems: 0,
  page: 1,
  limit: 20,
}));
const getReportStatusCounts = vi.fn(async (_params: unknown) => ({}));
vi.mock('$lib/server/reports.service', () => ({ getReports, getReportStatusCounts }));
const getReportedImageQueue = vi.fn(async (_params: unknown) => ({
  items: [],
  nextCursor: undefined,
}));
vi.mock('$lib/server/image-review.service', () => ({ getReportedImageQueue }));
// What `image-queue` imports for its actions, none of which this reaches.
vi.mock('$lib/server/image-moderation.service', () => ({}));
vi.mock('$lib/server/user-actions.service', () => ({}));
vi.mock('$lib/server/image-nsfw-level', () => ({}));
vi.mock('$lib/server/removal-hold', () => ({}));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/model3d.service', () => ({
  getModel3DsByThumbnailImageIds: vi.fn(async () => ({})),
  unpublishModel3d: vi.fn(),
}));
vi.mock('@civitai/db-queries/image-removal-confirmation', async (orig) => ({
  ...(await orig<object>()),
  getLatestApprovedImageAppeals: vi.fn(async () => new Map()),
}));

const { loadReportQueue } = await import('../report-queue-load');
const { loadImageQueue } = await import('../image-queue');
const { parseAgentReporterIds } = await import('../agent-reporters');

describe('with no agent accounts configured', () => {
  it('the report queues show no agent filter and query unfiltered, whatever the URL says', async () => {
    const q = await loadReportQueue(
      'post' as never,
      new URL('https://mod.example/reports/post?status=Pending&agents=only'),
      { statusCounts: true }
    );
    expect(q.agentFilter).toBeNull();
    expect((getReports.mock.calls[0][0] as { agents?: unknown }).agents).toBeUndefined();
    expect((getReportStatusCounts.mock.calls[0][0] as { agents?: unknown }).agents).toBeUndefined();
  });
});

describe('with no agent accounts configured, the reported image queue', () => {
  it('shows no agent filter and queries unfiltered, whatever the URL says', async () => {
    const q = await loadImageQueue(
      'reported',
      new URL('https://mod.example/reports/image?agents=hide')
    );
    expect(q).toMatchObject({ kind: 'reported', agentFilter: null });
    expect((getReportedImageQueue.mock.calls[0][0] as { agents?: unknown }).agents).toBeUndefined();
  });
});

describe("the reported image queue's Songs only filter (Music T10)", () => {
  const songsOnlyAsked = () =>
    (getReportedImageQueue.mock.lastCall![0] as { songsOnly?: boolean }).songsOnly;

  it('narrows to songs on ?songs=1 and shows the control on', async () => {
    const q = await loadImageQueue(
      'reported',
      new URL('https://mod.example/reports/image?songs=1')
    );
    expect(q).toMatchObject({ kind: 'reported', songsOnly: true });
    expect(songsOnlyAsked()).toBe(true);
  });

  it('shows the control off, and queries every report, without it', async () => {
    const q = await loadImageQueue('reported', new URL('https://mod.example/reports/image'));
    expect(q).toMatchObject({ kind: 'reported', songsOnly: false });
    expect(songsOnlyAsked()).toBe(false);
  });

  it('hides the control and runs unfiltered on a ?report= view', async () => {
    const q = await loadImageQueue(
      'reported',
      new URL('https://mod.example/reports/image?report=5&songs=1')
    );
    expect(q).toMatchObject({ kind: 'reported', songsOnly: null });
    expect(songsOnlyAsked()).toBe(false);
  });
});

describe('parseAgentReporterIds', () => {
  it('reads empty or blank as none', () => {
    expect(parseAgentReporterIds(undefined)).toEqual([]);
    expect(parseAgentReporterIds(' , ')).toEqual([]);
  });

  it('drops junk and repeats instead of failing on them', () => {
    expect(parseAgentReporterIds(' 501, junk,502,,-3, 501, 99999999999')).toEqual([501, 502]);
  });
});
