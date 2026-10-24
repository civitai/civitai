import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as NotificationService from '~/server/services/notification.service';

// The site's "Remove as TOS Violation" is where moderators re-removed images approved on appeal. A
// removal for the reason the appeal overturned is held for a second moderator before anything
// changes: the image, its reports and its owner are left alone.

const findFirst = dbMock.dbRead.image.findFirst;
const updateMany = dbMock.dbWrite.image.updateMany;

const { holdRemovals, canConfirmReRemoval, reportsActioned, notify } = vi.hoisted(() => ({
  holdRemovals: vi.fn(),
  canConfirmReRemoval: vi.fn(),
  reportsActioned: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getOpenImageReportIds: vi.fn(async () => [70, 71]),
  updateImageReportStatusByReason: reportsActioned,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: notify,
}));
vi.mock('~/server/services/image-removal-hold.service', () => ({
  holdRemovals,
  canConfirmReRemoval,
  heldRemovalSummary: (held: { imageId: number; created: boolean }[]) =>
    held.map(({ imageId, created }) => ({
      imageId,
      created,
      approvedAt: '2026-10-14T16:59:45.000Z',
      approvedByUsername: 'appr',
    })),
}));

import { setTosViolationHandler } from '../image.controller';

const ctx = {
  user: { id: 2, isModerator: true, roles: ['moderator:mod'] },
  ip: '1.2.3.4',
  track: { images: vi.fn() },
} as unknown as ProtectedContext;

const input = { id: 50, violationType: 'animatedMinorNsfw', violationDetails: 'again' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ nsfwLevel: 4, userId: 9, postId: 3, pHash: null, post: null });
  // A sentinel: reached only if the handler went past the hold into the removal itself.
  reportsActioned.mockRejectedValue(new Error('removal proceeded'));
});

describe('setTosViolationHandler re-removal hold', () => {
  it('holds a same-reason removal before changing anything', async () => {
    canConfirmReRemoval.mockResolvedValue(false);
    holdRemovals.mockResolvedValue({ held: [{ imageId: 50, created: true }], proceed: [] });

    const result = await setTosViolationHandler({ input, ctx });

    expect(holdRemovals).toHaveBeenCalledExactlyOnceWith(
      [
        {
          imageId: 50,
          violationType: 'animatedMinorNsfw',
          violationDetails: 'again',
          reportIds: [70, 71],
        },
      ],
      2,
      'site.setTosViolation'
    );
    expect(result.held).toEqual(expect.objectContaining({ imageId: 50, created: true }));
    expect(reportsActioned).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('removes when the hold lets it through', async () => {
    canConfirmReRemoval.mockResolvedValue(false);
    holdRemovals.mockResolvedValue({ held: [], proceed: [50] });

    await expect(setTosViolationHandler({ input, ctx })).rejects.toThrow();
    expect(reportsActioned).toHaveBeenCalledTimes(1);
    // The moderator is recorded on the reports, so the moderator app can see the queue was worked.
    expect(reportsActioned).toHaveBeenCalledWith(expect.objectContaining({ actorId: 2 }));
  });

  it('does not hold a moderator who may confirm re-removals', async () => {
    canConfirmReRemoval.mockResolvedValue(true);

    await expect(setTosViolationHandler({ input, ctx })).rejects.toThrow();
    expect(holdRemovals).not.toHaveBeenCalled();
    expect(reportsActioned).toHaveBeenCalledTimes(1);
  });
});
