import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as NotificationService from '~/server/services/notification.service';
import type * as ReportService from '~/server/services/report.service';

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));
const { mockResolveEntityAppeal } = vi.hoisted(() => ({ mockResolveEntityAppeal: vi.fn() }));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  resolveEntityAppeal: mockResolveEntityAppeal,
}));

const { setStorylineTakedown, moderateStorylineTitle, resolveStorylineTitleAppeal } = await import(
  '~/server/services/storyline.service'
);
const { applyStorylineTextScan } = await import('~/server/services/text-scan/actions/storyline');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { storylineTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/storyline.profile'
);

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
    if (value && typeof value === 'object' && 'lt' in value)
      return (row[key] as number) < (value as { lt: number }).lt;
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
    minorByScan: false,
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

/** A verdict on `title`, by default the one the storyline has now. */
const scan = (verdict: { poi: boolean; minor: boolean; nsfw?: number }, title = TITLE) =>
  applyStorylineTextScan({
    entityId: ID,
    workflowId: 'wf-1',
    textHash: textScanTextHash(storylineTextScanSubject({ userId: 3, title })),
    subject: { fields: [], declared: {} },
    outcome: {
      triggeredLabels: [],
      nsfwLevel: NsfwLevel.PG,
      ...(verdict.nsfw !== undefined && {
        nsfw: { detectedLevel: verdict.nsfw, declaredLevel: 0, raised: false, reason: 'r' },
      }),
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

  // The owner edits the title while a scan of the old one is in flight. That verdict is about text
  // the title no longer has: it may still restrict, but only a verdict on the current title lifts.
  describe('a verdict on a title the storyline no longer has', () => {
    const OLD = 'An old title';

    it('a clean verdict on the old title lifts nothing; one on the current title does', async () => {
      await flaggingScan();
      await scan({ poi: false, minor: false }, OLD);
      expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
      await cleanScan();
      expect(state()).toEqual(UP);
    });

    it('does not clear the minor flag or lower the rating', async () => {
      row.minorByScan = true;
      row.nsfwLevel = NsfwLevel.R;
      await scan({ poi: false, minor: false, nsfw: NsfwLevel.PG }, OLD);
      expect(row).toMatchObject({ minorByScan: true, nsfwLevel: NsfwLevel.R });
      await scan({ poi: false, minor: false, nsfw: NsfwLevel.PG });
      expect(row).toMatchObject({ minorByScan: false, nsfwLevel: NsfwLevel.PG });
    });

    it('still takes it down, marks a minor and raises the rating: it fails closed', async () => {
      await scan({ poi: false, minor: true, nsfw: NsfwLevel.X }, OLD);
      expect(row).toMatchObject({
        tosViolation: true,
        tosViolationByScan: true,
        minorByScan: true,
        nsfwLevel: NsfwLevel.X,
      });
    });
  });

  // The title is renamed while a clean verdict on the old one is being applied, and the new
  // title's verdict lands first. The old verdict's permissive writes must not undo it.
  it('a clean verdict renamed under mid-apply lifts, clears and lowers nothing', async () => {
    row.nsfwLevel = NsfwLevel.R;
    const realFind = w.storyline.findUnique.getMockImplementation()!;
    w.storyline.findUnique.mockImplementationOnce((async (args: never) => {
      const read = await realFind(args);
      // After the verdict has read the title: the rename, and the new title's own verdict.
      row.title = 'A new title';
      row.tosViolation = true;
      row.tosViolationByScan = true;
      row.minorByScan = true;
      return read;
    }) as never);
    await scan({ poi: false, minor: false, nsfw: NsfwLevel.PG });
    expect(row).toMatchObject({
      tosViolation: true,
      tosViolationByScan: true,
      minorByScan: true,
      nsfwLevel: NsfwLevel.R,
    });
  });

  it('a raise never lowers a higher rating written after the verdict read', async () => {
    const realFind = w.storyline.findUnique.getMockImplementation()!;
    w.storyline.findUnique.mockImplementationOnce((async (args: never) => {
      const read = await realFind(args);
      row.nsfwLevel = NsfwLevel.X; // a fresher verdict's raise, landing mid-apply
      return read;
    }) as never);
    await scan({ poi: false, minor: false, nsfw: NsfwLevel.R });
    expect(row.nsfwLevel).toBe(NsfwLevel.X);
  });
});

/** Closes the one open appeal row, as the real `resolveEntityAppeal` claims only a pending appeal. */
describe('resolving an appeal of a title-scan takedown', () => {
  let appealOpen: boolean;
  beforeEach(() => {
    appealOpen = true;
    w.appeal.findFirst
      .mockReset()
      .mockImplementation((async () => (appealOpen ? { id: 1 } : null)) as never);
    // Reset, not just cleared: a queued once-value a test never consumed would hit the next one.
    mockResolveEntityAppeal.mockReset().mockImplementation(async () => {
      const claimed = appealOpen ? [{ id: 1 }] : [];
      appealOpen = false;
      return claimed;
    });
  });
  const rule = (grant: boolean, reviewedTitle = TITLE) =>
    resolveStorylineTitleAppeal({ id: ID, grant, reviewedTitle, userId: 99 });
  const closedAs = () => mockResolveEntityAppeal.mock.calls.map(([arg]) => arg.status);

  it('a grant lifts the takedown, closes the appeal approved, and a rescan of the title keeps it up', async () => {
    await flaggingScan();
    await rule(true);
    expect(state()).toEqual(UP);
    expect(closedAs()).toEqual(['Approved']);
    expect(mockResolveEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [ID], entityType: 'Storyline', userId: 99 })
    );
    await flaggingScan();
    expect(state()).toEqual(UP);
  });

  it('a denial leaves it down and closes the appeal rejected', async () => {
    await flaggingScan();
    await rule(false);
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
    expect(closedAs()).toEqual(['Rejected']);
  });

  it('a second ruling is refused and changes nothing', async () => {
    await flaggingScan();
    await rule(false);
    await expect(rule(true)).rejects.toThrow(/no open appeal/);
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
    expect(closedAs()).toEqual(['Rejected']);
  });

  it('a grant for a title edited since is refused, and the appeal stays open', async () => {
    await flaggingScan();
    await expect(rule(true, 'The title before the edit')).rejects.toThrow(/title has changed/);
    expect(state()).toEqual({ down: true, byScan: true, byModerator: false });
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
  });

  it("a grant is refused while a moderator's takedown holds, a denial still closes it", async () => {
    await flaggingScan();
    await takeDown();
    await expect(rule(true)).rejects.toThrow(/moderator took this storyline down/);
    expect(state()).toEqual({ down: true, byScan: true, byModerator: true });
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
    await rule(false);
    expect(state()).toEqual({ down: true, byScan: true, byModerator: true });
    expect(closedAs()).toEqual(['Rejected']);
  });

  // The scan's takedown lifted after the appeal was filed, a moderator's still holding.
  it("a denial closes it when only a moderator's takedown is left", async () => {
    await flaggingScan();
    await takeDown();
    await cleanScan();
    await rule(false);
    expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
    expect(closedAs()).toEqual(['Rejected']);
  });

  it('a ruling another moderator closed first reports that, not success', async () => {
    await flaggingScan();
    mockResolveEntityAppeal.mockResolvedValueOnce([]);
    await expect(rule(false)).rejects.toThrow(/ruled on this appeal first/);
  });

  // A grant whose lift landed after a rival ruling closed the appeal says the lift happened.
  it('a grant that lost the race says the takedown was lifted', async () => {
    await flaggingScan();
    mockResolveEntityAppeal.mockResolvedValueOnce([]);
    await expect(rule(true)).rejects.toThrow(/takedown was lifted, but another moderator/);
    expect(state()).toEqual(UP);
  });

  it('with nothing left to lift, a grant closes it and a denial is refused', async () => {
    await expect(rule(false)).rejects.toThrow(/no longer taken down/);
    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
    await rule(true);
    expect(state()).toEqual(UP);
    expect(closedAs()).toEqual(['Approved']);
  });

  describe('a clean rescan that lifts the title-scan takedown', () => {
    it('closes the open appeal approved, marked as a rescan lift and not an appeal review', async () => {
      await flaggingScan();
      await cleanScan();
      expect(state()).toEqual(UP);
      expect(mockResolveEntityAppeal.mock.calls).toEqual([
        [
          expect.objectContaining({
            ids: [ID],
            entityType: 'Storyline',
            status: 'Approved',
            resolvedReason: 'lifted-by-rescan',
            internalNotes: expect.stringContaining('not an appeal review'),
          }),
        ],
      ]);
      expect(appealOpen).toBe(false);
    });

    it("leaves the appeal open while a moderator's takedown still holds the storyline down", async () => {
      await flaggingScan();
      await takeDown();
      await cleanScan();
      expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
      expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
      expect(appealOpen).toBe(true);
    });

    it('leaves the appeal alone when there was no scan takedown to lift', async () => {
      await cleanScan();
      expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
    });

    it('still lifts when closing the appeal fails', async () => {
      await flaggingScan();
      mockResolveEntityAppeal.mockRejectedValueOnce(new Error('db down'));
      await expect(cleanScan()).resolves.toBeUndefined();
      expect(state()).toEqual(UP);
      expect(appealOpen).toBe(true);
    });
  });

  // The moderator's button and `storyline.moderateTitle` both lift through moderateStorylineTitle.
  describe('a direct lift by a moderator', () => {
    const lift = (reviewedTitle = TITLE) =>
      moderateStorylineTitle({ id: ID, liftScanTakedown: { reviewedTitle }, moderatorId: 99 });

    it('closes the open appeal approved, marked as a lift and not an appeal review', async () => {
      await flaggingScan();
      await lift();
      expect(state()).toEqual(UP);
      expect(mockResolveEntityAppeal.mock.calls).toEqual([
        [
          expect.objectContaining({
            ids: [ID],
            entityType: 'Storyline',
            status: 'Approved',
            userId: 99,
            resolvedReason: 'lifted-by-moderator',
            internalNotes: expect.stringContaining('not an appeal review'),
          }),
        ],
      ]);
      expect(appealOpen).toBe(false);
    });

    it("leaves the appeal open while a moderator's takedown still holds the storyline down", async () => {
      await flaggingScan();
      await takeDown();
      await lift();
      expect(state()).toEqual({ down: true, byScan: false, byModerator: true });
      expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
      expect(appealOpen).toBe(true);
    });

    it('refuses a title edited since it was reviewed, and the appeal stays open', async () => {
      await flaggingScan();
      await expect(lift('The title before the edit')).rejects.toThrow(/title has changed/);
      expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
      expect(appealOpen).toBe(true);
    });

    it('leaves the appeal alone when it only sets a rating', async () => {
      await flaggingScan();
      await moderateStorylineTitle({ id: ID, moderatorNsfwLevel: NsfwLevel.PG });
      expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
    });

    it('lifts as before when the storyline has no open appeal', async () => {
      await flaggingScan();
      appealOpen = false;
      await lift();
      expect(state()).toEqual(UP);
    });

    it('still lifts when closing the appeal fails, so a retry is not told it was never taken down', async () => {
      await flaggingScan();
      mockResolveEntityAppeal.mockRejectedValueOnce(new Error('db down'));
      await expect(lift()).resolves.toMatchObject({ tosViolation: false });
      expect(state()).toEqual(UP);
      expect(appealOpen).toBe(true);
    });

    // The grant lifts through the same function, then closes the appeal itself as a reviewed one.
    it('does not close the appeal a second time under an appeal grant', async () => {
      await flaggingScan();
      await rule(true);
      expect(mockResolveEntityAppeal.mock.calls).toEqual([
        [expect.objectContaining({ status: 'Approved', userId: 99 })],
      ]);
      expect(mockResolveEntityAppeal.mock.calls[0][0].resolvedReason).toBeUndefined();
    });
  });
});
