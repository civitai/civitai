import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Backfill from '~/server/services/comment-v3-backfill.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockImplementation(async () => undefined);

const notifyModAlert = vi.fn(async () => 'delivered' as const);
const upsert = dbMock.dbWrite.keyValue.upsert;
const reports = {
  unmirrored: {} as Record<string, unknown>,
  parity: {} as Record<string, unknown>,
  fail: undefined as string | undefined,
};

vi.mock('~/server/common/mod-alert', () => ({ notifyModAlert }));
// The pgDb mock parity guard requires every pgDb export in the inline factory.
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbReadLong: {}, pgDbWrite: {} }));
vi.mock('@civitai/telemetry/client', () => ({
  registerGauge: () => ({ set: () => undefined }),
  registerGaugeWithLabels: () => ({ set: () => undefined }),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: unknown) => ({ name, cron, run: fn }),
}));
vi.mock('~/server/services/comment-v3-backfill.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Backfill>()),
  unmirroredReport: async () => {
    if (reports.fail) throw new Error(reports.fail);
    return reports.unmirrored;
  },
  parityReport: async () => reports.parity,
  rowTotals: async () => ({ CommentV2: 1 }),
}));

const { commentV3ParityJob } = await import('~/server/jobs/comment-v3-parity');
const run = () =>
  (
    commentV3ParityJob as unknown as {
      run: (ctx: { checkIfCanceled: () => void }) => Promise<Record<string, unknown>>;
    }
  ).run({
    checkIfCanceled: () => undefined,
  });
const zero = { count: 0, sample: [] as number[] };
const blank = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, zero]));
const UNMIRRORED = [
  'v2_pending',
  'v2_no_thread',
  'v2_dead_parent',
  'v2_unresolved_entity',
  'v2_no_topic',
  'v2_pending_unexplained',
  'v1_pending',
  'v1_dead_parent',
  'v1_no_topic',
  'v1_pending_unexplained',
  'v2_reactions_pending',
  'v1_reactions_pending',
  'v2_reports_pending',
  'v1_reports_pending',
  'mutes_pending',
];
const PARITY = [
  'v2_ghosts',
  'v1_ghosts',
  'resurrected',
  'tombstones_childless',
  'thread_count_mismatch',
  'model_v1_count_mismatch',
  'topic_count_mismatch',
  'reaction_count_mismatch',
  'v2_reactions_extra',
  'v1_reactions_extra',
  'reports_extra',
  'topic_lock_mismatch',
  'comment_lock_mismatch',
  'v2_column_drift',
  'v1_column_drift',
  'v1_parent_mismatch',
  'mutes_extra',
  'topic_mutes_orphaned',
];

beforeEach(() => {
  notifyModAlert.mockClear();
  upsert.mockClear();
  upsert.mockResolvedValue(undefined);
  reports.unmirrored = blank(UNMIRRORED);
  reports.parity = blank(PARITY);
  reports.fail = undefined;
});

describe('comment-v3-parity job', () => {
  it('records a clean day without paging', async () => {
    const result = await run();
    expect(notifyModAlert).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ healthy: true, pages: [], rows: { CommentV2: 1 } });
  });

  it('pages once with the drift when a finding is nonzero', async () => {
    reports.parity = { ...blank(PARITY), v2_ghosts: { count: 2, sample: [5000, 5001] } };
    const result = await run();
    expect(notifyModAlert).toHaveBeenCalledTimes(1);
    expect(notifyModAlert.mock.calls[0]?.[1]).toContain('v2_ghosts: 2 (e.g. 5000, 5001)');
    expect(result).toMatchObject({ healthy: false, paged: true });
  });

  it('reports an undelivered page as not paged, without throwing', async () => {
    reports.parity = { ...blank(PARITY), v2_ghosts: { count: 1, sample: [1] } };
    notifyModAlert.mockResolvedValueOnce('unconfigured' as never);
    expect(await run()).toMatchObject({ healthy: false, paged: false });
  });

  it('does not page on a day with only the expected residue, but records it', async () => {
    reports.parity = { ...blank(PARITY), tombstones_childless: { count: 5, sample: [1, 2] } };
    reports.unmirrored = { ...blank(UNMIRRORED), v2_no_thread: { count: 8531, sample: [1857994] } };
    const result = await run();
    expect(notifyModAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      healthy: true,
      findings: { tombstones_childless: { count: 5 }, v2_no_thread: { count: 8531 } },
    });
    expect(result.expected).toEqual(
      expect.arrayContaining([expect.stringContaining('tombstones_childless')])
    );
  });

  it('fails the run when the notifier is down, before writing the record', async () => {
    reports.parity = { ...blank(PARITY), v2_ghosts: { count: 1, sample: [1] } };
    notifyModAlert.mockRejectedValueOnce(new Error('webhook 503'));
    await expect(run()).rejects.toThrow('webhook 503');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('pages that it failed when a report cannot run, and still fails', async () => {
    reports.fail = 'canceling statement due to conflict with recovery';
    await expect(run()).rejects.toThrow('conflict with recovery');
    expect(notifyModAlert).toHaveBeenCalledTimes(1);
    expect(notifyModAlert.mock.calls[0]?.[0]).toContain('job failed');
    expect(upsert).not.toHaveBeenCalled();
  });
});
