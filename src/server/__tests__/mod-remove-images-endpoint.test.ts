import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleBlockImages, trackImages } = vi.hoisted(() => ({
  handleBlockImages: vi.fn(),
  trackImages: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/image.service', () => ({ handleBlockImages }));
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
