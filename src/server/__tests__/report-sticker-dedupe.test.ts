import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';

/**
 * Fixture discipline: every quantity here is distinct, so a value reaching the
 * wrong place cannot pass by colliding with the right one. The two placement ids
 * are the whole point of these tests, so they must never be equal to each other
 * or to the image, the reporters, or the report row.
 */
const IMAGE = 71;
const REPORTER_A = 82;
const REPORTER_B = 93;
const EXISTING_REPORT = 104;
const PLACEMENT_ONE = 115;
const PLACEMENT_TWO = 126;

const reportFindFirst = vi.fn();
const reportCreate = vi.fn();
const reportUpdate = vi.fn();
const placementFindFirst = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: { placement: { findFirst: (...args: unknown[]) => placementFindFirst(...args) } },
  dbWrite: {
    report: {
      findFirst: (...args: unknown[]) => reportFindFirst(...args),
      update: (...args: unknown[]) => reportUpdate(...args),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        report: { create: (...args: unknown[]) => reportCreate(...args) },
        image: { update: vi.fn(), findUnique: vi.fn(async () => null) },
        model: { update: vi.fn() },
      }),
  },
}));

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { createReport } = await import('~/server/services/report.service');

const stickerReport = (placementId: number, userId: number) => ({
  userId,
  id: IMAGE,
  type: ReportEntity.Image,
  reason: ReportReason.StickerPlacement,
  details: { placementId, comment: 'nope' },
});

beforeEach(() => {
  vi.clearAllMocks();
  // The placement exists on the reported image, so the on-entity guard passes
  // and these tests are about the dedupe rather than about that.
  placementFindFirst.mockResolvedValue({ id: PLACEMENT_ONE });
  reportCreate.mockResolvedValue({ id: 137, details: {} });
  reportUpdate.mockResolvedValue({ id: EXISTING_REPORT });
});

describe('a sticker report is deduped by placement, not by image', () => {
  /**
   * The multi-placement case is the only case `placementId` exists for. Deduping
   * on (reason, image) alone folded a report about one sticker into an existing
   * report about a different one and discarded the new details — leaving a
   * moderator to act on the wrong placement, which removes an innocent placer's
   * sticker and keeps their Buzz.
   */
  it('creates a second row when a different placement is reported', async () => {
    reportFindFirst.mockResolvedValue(null);

    await createReport(stickerReport(PLACEMENT_TWO, REPORTER_B));

    // The query must carry the placement, or it would match the existing report
    // about PLACEMENT_ONE and return it instead.
    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where.AND).toContainEqual({
      details: { path: ['placementId'], equals: PLACEMENT_TWO },
    });

    // The row that gets written has to carry the NEW placement. Asserting only
    // that create ran proves nothing here — `findFirst` is mocked to null, so it
    // would run whatever the predicate said.
    const [created] = reportCreate.mock.calls[0] as [{ data: MixedObject }];
    expect(created.data.details).toMatchObject({ placementId: PLACEMENT_TWO });
  });

  it('still folds a second report about the same placement', async () => {
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      alsoReportedBy: [REPORTER_A],
      previouslyReviewedCount: 0,
    });

    await createReport(stickerReport(PLACEMENT_ONE, REPORTER_B));

    expect(reportCreate).not.toHaveBeenCalled();
    expect(reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ alsoReportedBy: [REPORTER_A, REPORTER_B] }),
      })
    );
  });

  /**
   * A sticker and the note hanging off it are separately objectionable, and the
   * discrimination has to run in BOTH directions. Matching on the placement
   * alone for either one is not a weaker filter — it is a fold: the second
   * report is appended to the first as "also reported by", its reason text
   * discarded, and a moderator is shown a complaint about one while the
   * complaint about the other is invisible.
   */
  it('asks for the note and the sticker separately, whichever is reported', async () => {
    reportFindFirst.mockResolvedValue(null);

    await createReport({
      ...stickerReport(PLACEMENT_ONE, REPORTER_A),
      details: { placementId: PLACEMENT_ONE, target: 'comment', comment: 'nope' },
    });
    const [noteQuery] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(noteQuery.where.AND).toContainEqual({
      details: { path: ['target'], equals: 'comment' },
    });

    reportFindFirst.mockClear();
    await createReport(stickerReport(PLACEMENT_ONE, REPORTER_B));
    const [artQuery] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    // Not merely "no comment predicate" — the sticker arm has to assert its own
    // value, or it matches the note report about the same placement.
    expect(artQuery.where.AND).toContainEqual({
      details: { path: ['target'], equals: 'sticker' },
    });
  });

  it('leaves every other reason deduping exactly as it did', async () => {
    // Returns an existing row so this stops at the dedupe rather than running the
    // whole create path — the assertion is about the query, not the write.
    reportFindFirst.mockResolvedValue({
      id: EXISTING_REPORT,
      alsoReportedBy: [REPORTER_B],
      previouslyReviewedCount: 0,
    });

    await createReport({
      userId: REPORTER_A,
      id: IMAGE,
      type: ReportEntity.Image,
      reason: ReportReason.TOSViolation,
      details: { violation: 'Prohibited concepts' },
    });

    // No placement predicate at all — not a null one, not an undefined one. The
    // generic path has to be byte-identical for reasons that carry no placement.
    const [query] = reportFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect('details' in query.where).toBe(false);
  });
});

describe('a report can only name a placement that is on the image it reports', () => {
  it('refuses a placement that is not on this image', async () => {
    placementFindFirst.mockResolvedValue(null);

    await expect(createReport(stickerReport(PLACEMENT_TWO, REPORTER_A))).rejects.toThrow(
      /not on the image being reported/
    );
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('refuses a placement reported through anything but an image', async () => {
    await expect(
      createReport({ ...stickerReport(PLACEMENT_ONE, REPORTER_A), type: ReportEntity.Model })
    ).rejects.toThrow(/only be reported through its image/);
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('scopes the lookup to sticker placements on this image', async () => {
    await createReport(stickerReport(PLACEMENT_ONE, REPORTER_A));

    const [query] = placementFindFirst.mock.calls[0] as [{ where: MixedObject }];
    expect(query.where).toMatchObject({
      id: PLACEMENT_ONE,
      surface: 'sticker',
      targetType: 'image',
      targetId: IMAGE,
    });
  });

  /**
   * The number is guaranteed by `z.coerce.number()` in the report schema — which
   * lives in another file and is connected to this one by nothing. If that ever
   * loosens, degrading to an image-wide match would fold every sticker report on
   * the image into the first one again, and a moderator would act on the wrong
   * person's sticker. Refusing is the failure worth having.
   */
  it('refuses a sticker report whose placement id is not a number', async () => {
    reportFindFirst.mockResolvedValue(null);

    await expect(
      createReport({
        userId: REPORTER_A,
        type: ReportEntity.Image,
        id: IMAGE,
        reason: ReportReason.StickerPlacement,
        details: { placementId: 'not-a-number' } as never,
      })
    ).rejects.toThrow(/must name a placement/);

    expect(reportCreate).not.toHaveBeenCalled();
  });
});
