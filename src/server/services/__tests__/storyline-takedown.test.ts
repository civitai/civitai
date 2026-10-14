import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as NotificationService from '~/server/services/notification.service';

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));

const { setStorylineTakedown } = await import('~/server/services/storyline.service');
const { applyStorylineTextScan } = await import('~/server/services/text-scan/actions/storyline');

/**
 * A moderator's takedown and the title scan's write the same flag, and the scan lifts a takedown
 * on a clean verdict. These run both against ONE storyline row, with each `updateMany`'s `where`
 * evaluated against it, because the property is in how the two writes' predicates interact: a
 * test of either write's shape alone passes with a takedown the next clean scan quietly lifts.
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
let row: Row;

const w = dbMock.dbWrite;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: ID,
    userId: 3,
    title: 'A story',
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
    tosViolation: false,
    tosViolationByScan: false,
    scanFlagLiftedTextHash: null,
  };
  w.storyline.updateMany.mockReset().mockImplementation((async ({ where, data }: never) => {
    if (!matches(row, where)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  }) as never);
  w.storyline.findUnique
    .mockReset()
    .mockImplementation((async ({ where }: never) =>
      (where as Where).id === ID ? { ...row } : null) as never);
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

const state = () => ({ tosViolation: row.tosViolation, byScan: row.tosViolationByScan });

describe('a moderator takedown and the title scan', () => {
  // The control for every case below: the fake lifts a scan's takedown on a clean verdict, so a
  // moderator's takedown surviving one is the fake telling them apart, not the fake doing nothing.
  it('a clean scan lifts a takedown the scan made', async () => {
    await flaggingScan();
    expect(state()).toEqual({ tosViolation: true, byScan: true });
    await cleanScan();
    expect(state()).toEqual({ tosViolation: false, byScan: false });
  });

  it("a clean rescan does not lift a moderator's takedown", async () => {
    await setStorylineTakedown({ id: ID, takenDown: true });
    expect(state()).toEqual({ tosViolation: true, byScan: false });
    await cleanScan();
    expect(state()).toEqual({ tosViolation: true, byScan: false });
  });

  it("a moderator confirming the scan's takedown makes it theirs, so a clean rescan keeps it", async () => {
    await flaggingScan();
    await setStorylineTakedown({ id: ID, takenDown: true });
    await cleanScan();
    expect(state()).toEqual({ tosViolation: true, byScan: false });
  });

  it("a moderator's restore lifts their own takedown", async () => {
    await setStorylineTakedown({ id: ID, takenDown: true });
    await expect(setStorylineTakedown({ id: ID, takenDown: false })).resolves.toMatchObject({
      tosViolation: false,
      tosViolationByScan: false,
    });
  });

  // A scan's takedown is lifted for the title a moderator reviewed (`moderateTitle`), which records
  // that text so the same verdict does not take it down again. A plain restore would skip both.
  it("a restore leaves the scan's takedown in place, and says so", async () => {
    await flaggingScan();
    await expect(setStorylineTakedown({ id: ID, takenDown: false })).resolves.toMatchObject({
      tosViolation: true,
      tosViolationByScan: true,
    });
  });

  it('is not found for a storyline that does not exist', async () => {
    await expect(setStorylineTakedown({ id: 999, takenDown: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
