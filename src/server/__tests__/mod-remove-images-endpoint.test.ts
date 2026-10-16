import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleBlockImages, trackImages, holdRemovals } = vi.hoisted(() => ({
  handleBlockImages: vi.fn(),
  trackImages: vi.fn(),
  holdRemovals: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/image.service', () => ({ handleBlockImages }));
vi.mock('~/server/services/image-removal-hold.service', () => ({
  holdRemovals,
  heldRemovalSummary: (held: { imageId: number }[]) => held.map(({ imageId }) => ({ imageId })),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    images = trackImages;
  },
}));

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

const call = async (body: unknown) => {
  const { default: handler } = await import('~/pages/api/mod/remove-images');
  const res = mockRes();
  await handler({ method: 'POST', body } as never, res as never);
  return res;
};

beforeEach(() => {
  handleBlockImages.mockReset();
  trackImages.mockReset();
  holdRemovals.mockReset();
  holdRemovals.mockImplementation(async (requests: { imageId: number }[]) => ({
    held: [],
    proceed: requests.map((r) => r.imageId),
  }));
});

// The moderator app releases separately and posts its own copy of the violation list here. A value
// this build does not know yet must come back as a fast 400: a status with no body leaves the
// request open until the caller's 2-minute timeout, which the moderator reads as "may have gone
// through" and retries.
describe('/api/mod/remove-images responses', () => {
  it('refuses an unknown violationType with a 400 and removes nothing', async () => {
    const res = await call({ imageIds: [1], violationType: 'notAViolation' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(handleBlockImages).not.toHaveBeenCalled();
  });

  it('ends the response when the removal itself throws', async () => {
    handleBlockImages.mockRejectedValue(new Error('db down'));

    const res = await call({ imageIds: [1], violationType: 'minorViolence' });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
  });

  it('files a minorViolence removal under that violation in the DeleteTOS event', async () => {
    handleBlockImages.mockResolvedValue([{ id: 1, userId: 2, nsfwLevel: 1 }]);

    const res = await call({ imageIds: [1], violationType: 'minorViolence' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(trackImages).toHaveBeenCalledTimes(1);
    expect(trackImages).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'DeleteTOS', imageId: 1, violationType: 'minorViolence' }),
    ]);
  });
});

// A moderator removing an image for the reason its approved appeal overturned is held for a second
// moderator (`holdRemovals`); the rest of the batch goes through.
describe('/api/mod/remove-images re-removal hold', () => {
  it('removes only the images the hold lets through and reports the held ones', async () => {
    holdRemovals.mockResolvedValue({ held: [{ imageId: 2 }], proceed: [1] });
    handleBlockImages.mockResolvedValue([{ id: 1, userId: 5, nsfwLevel: 1 }]);

    const res = await call({ imageIds: [1, 2], moderatorId: 9, violationType: 'gore' });

    expect(holdRemovals).toHaveBeenCalledWith(
      [
        { imageId: 1, violationType: 'gore', violationDetails: undefined },
        { imageId: 2, violationType: 'gore', violationDetails: undefined },
      ],
      9,
      'api.removeImages'
    );
    expect(handleBlockImages).toHaveBeenCalledWith({ ids: [1], userId: undefined, moderatorId: 9 });
    expect(res.json).toHaveBeenCalledWith({ images: 1, held: [{ imageId: 2 }] });
  });

  it('removes nothing when every image is held', async () => {
    holdRemovals.mockResolvedValue({ held: [{ imageId: 2 }], proceed: [] });

    const res = await call({ imageIds: [2], moderatorId: 9, violationType: 'gore' });

    expect(handleBlockImages).not.toHaveBeenCalled();
    expect(trackImages).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ images: 0, held: [{ imageId: 2 }] });
  });

  it('holds a removal that names no moderator, as an unnamed caller', async () => {
    holdRemovals.mockResolvedValue({ held: [{ imageId: 2 }], proceed: [] });

    await call({ imageIds: [2], violationType: 'gore' });

    expect(holdRemovals).toHaveBeenCalledWith(expect.any(Array), 0, 'api.removeImages');
    expect(handleBlockImages).not.toHaveBeenCalled();
  });

  it('holds nothing for a moderator who may confirm re-removals, or for an account-wide removal', async () => {
    handleBlockImages.mockResolvedValue([]);

    await call({ imageIds: [1], moderatorId: 9, canConfirmReRemoval: true });
    await call({ userId: 5, moderatorId: 9 });

    expect(holdRemovals).not.toHaveBeenCalled();
    expect(handleBlockImages).toHaveBeenCalledTimes(2);
  });
});
