import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { handleBlockImages, trackImages, holdRemovals, getOpenImageReportIdsByImage } = vi.hoisted(
  () => ({
    getOpenImageReportIdsByImage: vi.fn(),
    handleBlockImages: vi.fn(),
    trackImages: vi.fn(),
    holdRemovals: vi.fn(),
  })
);

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/image.service', () => ({
  handleBlockImages,
  getOpenImageReportIdsByImage,
}));
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
  const { default: handler } = await import('~/server/api-routes/mod/remove-images');
  const res = mockRes();
  await handler({ method: 'POST', body } as never, res as never);
  return res;
};

beforeEach(() => {
  handleBlockImages.mockReset();
  trackImages.mockReset();
  holdRemovals.mockReset();
  getOpenImageReportIdsByImage.mockReset();
  getOpenImageReportIdsByImage.mockResolvedValue(new Map());
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

  it('refuses an account-wide removal of the feedback capture account, removing nothing', async () => {
    const res = await call({ userId: -2, moderatorId: 9 });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/feedback page captures/),
    });
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
        { imageId: 1, violationType: 'gore', violationDetails: undefined, reportIds: [] },
        { imageId: 2, violationType: 'gore', violationDetails: undefined, reportIds: [] },
      ],
      9,
      'api.removeImages'
    );
    expect(handleBlockImages).toHaveBeenCalledWith({ ids: [1], userId: undefined, moderatorId: 9 });
    expect(res.json).toHaveBeenCalledWith({ images: 1, held: [{ imageId: 2 }] });
  });

  it("carries each image's open TOS reports on the hold, so a confirm actions them", async () => {
    getOpenImageReportIdsByImage.mockResolvedValue(new Map([[1, [70, 71]]]));
    holdRemovals.mockResolvedValue({ held: [{ imageId: 1 }, { imageId: 2 }], proceed: [] });

    await call({ imageIds: [1, 2], moderatorId: 9, violationType: 'gore' });

    expect(getOpenImageReportIdsByImage).toHaveBeenCalledWith([1, 2], 'TOSViolation');
    expect(holdRemovals.mock.calls[0][0]).toEqual([
      { imageId: 1, violationType: 'gore', violationDetails: undefined, reportIds: [70, 71] },
      { imageId: 2, violationType: 'gore', violationDetails: undefined, reportIds: [] },
    ]);
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
    expect(getOpenImageReportIdsByImage).not.toHaveBeenCalled();
    expect(handleBlockImages).toHaveBeenCalledTimes(2);
  });
});

// The appeal-decision-records sweep deletes the appeal training copies of an image by this row.
describe('/api/mod/remove-images likeness requests', () => {
  beforeEach(() => vi.mocked(dbMock.dbWrite.$executeRaw).mockClear());

  const likenessMarks = () =>
    vi
      .mocked(dbMock.dbWrite.$executeRaw)
      .mock.calls.map(([strings, ...values]) =>
        Prisma.sql(strings as unknown as readonly string[], ...values)
      )
      .filter(
        (sql) => sql.text.includes('"ModActivity"') && sql.values.includes('likenessRequest')
      );

  it('marks each removed image, and not one held for a second moderator', async () => {
    holdRemovals.mockResolvedValue({ held: [{ imageId: 12 }], proceed: [11, 13] });
    handleBlockImages.mockResolvedValue([
      { id: 11, userId: 3, nsfwLevel: 1 },
      { id: 13, userId: 3, nsfwLevel: 1 },
    ]);

    await call({ imageIds: [11, 12, 13], moderatorId: 9, violationType: 'likenessRequest' });

    const [mark, ...more] = likenessMarks();
    expect(more).toEqual([]);
    expect(mark.values).toEqual(expect.arrayContaining([9, 'image', [11, 13]]));
  });

  it('still sends the removal events and succeeds when the mark fails', async () => {
    handleBlockImages.mockResolvedValue([{ id: 11, userId: 3, nsfwLevel: 1 }]);
    vi.mocked(dbMock.dbWrite.$executeRaw).mockRejectedValueOnce(new Error('db down'));

    const res = await call({ imageIds: [11], moderatorId: 9, violationType: 'likenessRequest' });

    expect(likenessMarks()).toHaveLength(1);
    expect(trackImages).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('marks nothing for any other reason', async () => {
    handleBlockImages.mockResolvedValue([{ id: 11, userId: 3, nsfwLevel: 1 }]);

    await call({ imageIds: [11], moderatorId: 9, violationType: 'realPerson' });

    expect(likenessMarks()).toEqual([]);
  });
});
