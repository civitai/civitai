import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as NotificationService from '~/server/services/notification.service';

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));

const { setStorylineTakedown, moderateStorylineTitle } = await import(
  '~/server/services/storyline.service'
);
const { applyStorylineTextScan } = await import('~/server/services/text-scan/actions/storyline');

/**
 * A moderator's takedown and the title scan's are held apart (`tosViolationByModerator`,
 * `tosViolationByScan`), and the storyline is down (`tosViolation`) while either holds one. These
 * run the moderator's writes and the scan's against ONE storyline row, each `updateMany`'s `where`
 * evaluated against it, because the property lives in how the writes' predicates interact: a test
 * of any one write's shape passes over a sequence that leaves a flagged title public.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const matches = (row: Row, where: Where): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Where[]).some((w) => matches(row, w));
    if (value && typeof value === 'object' && 'not' in value)
      return row[key] !== (value as { not: unknown }).not;
    return row[key] === value;
  });

const ID = 10;
const TITLE = 'A story';
let row: Row;

const w = dbMock.dbWrite;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: ID,
    userId: 3,
    title: TITLE,
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
    tosViolation: false,
    tosViolationByScan: false,
    tosViolationByModerator: false,
    scanFlagLiftedTextHash: null,
  };
  w.storyline.updateMany.mockReset().mockImplementation((async ({ where, data }: never) => {
    if (!matches(row, where)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  }) as never);
  const read = (async ({ where }: never) =>
    (where as Where).id === ID ? { ...row } : null) as never;
  w.storyline.findUnique.mockReset().mockImplementation(read);
  w.storyline.findUniqueOrThrow.mockReset().mockImplementation(read);
});

const scan = (verdict: { poi: boolean; minor: boolean }) =>
  applyStorylineTextScan({
    entityId: ID,
    workflowId: 'wf-1',
    textHash: 'hash-of-this-title',
    subject: { fields: [], declared: {} },
    outcome: {
      triggeredLabels: [],
      nsfwLevel: NsfwLevel.PG,
      poi: {
        detected: verdict.poi,
        declared: false,
        newlyDetected: verdict.poi,
        names: [],
        reason: 'r',
      },
      minor: {
        detected: verdict.minor,
        declared: false,
        newlyDetected: verdict.minor,
        reason: 'r',
      },
    },
  } as never);
const cleanScan = () => scan({ poi: false, minor: false });
const flaggingScan = () => scan({ poi: true, minor: false });
const takeDown = () => setStorylineTakedown({ id: ID, takenDown: true });
const restore = () => setStorylineTakedown({ id: ID, takenDown: false });

const state = () => ({
  down: row.tosViolation,
  byScan: row.tosViolationByScan,
  byModerator: row.tosViolationByModerator,
});
const UP = { down: false, byScan: false, byModerator: false };

describe('a moderator takedown and the title scan', () => {
  // The controls: each side can lift its own takedown on this fake, so the other side's surviving
  // a lift below is the two being told apart, not the fake doing nothing.
  it('a clean scan lifts a takedown only the scan holds', async () => {
    await flaggingScan();
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
    await cleanScan();
    expect(state()).toEqual(UP);
  });

  it('a restore lifts a takedown only a moderator holds', async () => {
    await takeDown();
    expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
    await expect(restore()).resolves.toMatchObject({ tosViolation: false, changed: true });
    expect(state()).toEqual(UP);
  });

  it("a clean rescan does not lift a moderator's takedown", async () => {
    await takeDown();
    await cleanScan();
    expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
  });

  // A moderator acting on the report of a scan-flagged storyline, then a restore: the scan's
  // takedown must survive, or the flagged title is public without the title review.
  it("scan flags, a moderator takes it down, a restore: still down, on the scan's takedown", async () => {
    await flaggingScan();
    await takeDown();
    await expect(restore()).resolves.toMatchObject({ tosViolation: true, changed: true });
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
  });

  // The owner edits the title while a moderator holds the storyline down. The rescan's verdict
  // must be recorded even though the storyline is already down, or a restore publishes it.
  it('a moderator takes it down, the edited title is flagged, a restore: still down', async () => {
    await takeDown();
    await flaggingScan();
    expect(state()).toEqual({ down: true, byScan: true, byModerator: true });
    await restore();
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
  });

  it('a clean scan while both hold one clears only the scan’s', async () => {
    await flaggingScan();
    await takeDown();
    await cleanScan();
    expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
  });

  it("a moderator lifting the scan's takedown for the reviewed title keeps their own", async () => {
    await flaggingScan();
    await takeDown();
    await moderateStorylineTitle({ id: ID, liftScanTakedown: { reviewedTitle: TITLE } });
    expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
    expect(row.scanFlagLiftedTextHash).toEqual(expect.any(String));
  });

  it('says when there was nothing to change', async () => {
    await expect(restore()).resolves.toMatchObject({ changed: false });
    await takeDown();
    await expect(takeDown()).resolves.toMatchObject({ changed: false });
  });

  it('is not found for a storyline that does not exist', async () => {
    await expect(setStorylineTakedown({ id: 999, takenDown: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
