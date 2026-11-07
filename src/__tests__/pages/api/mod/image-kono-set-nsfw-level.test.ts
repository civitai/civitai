import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

const { setImageNsfwLevelFromKnights } = vi.hoisted(() => ({
  setImageNsfwLevelFromKnights: vi.fn<typeof ImageService.setImageNsfwLevelFromKnights>(),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  setImageNsfwLevelFromKnights,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const { default: handler } = await import('~/pages/api/mod/image/kono-set-nsfw-level');

const call = async (method: string, body: Record<string, unknown>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await handler({ method, body } as NextApiRequest, res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  setImageNsfwLevelFromKnights.mockResolvedValue({ applied: true });
});

describe('/api/mod/image/kono-set-nsfw-level', () => {
  it('hands a Knights result to the guarded write and reports it applied', async () => {
    const res = await call('POST', { imageId: '12', nsfwLevel: '4', userId: '9' });

    expect(setImageNsfwLevelFromKnights).toHaveBeenCalledWith({ id: 12, nsfwLevel: 4, userId: 9 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ imageId: 12, outcome: 'applied', nsfwLevel: 4 });
  });

  it.each([
    ['blocked', 32],
    ['locked', 8],
    ['missing', null],
  ] as const)('answers 200 with a skip when the image is %s', async (reason, currentLevel) => {
    setImageNsfwLevelFromKnights.mockResolvedValue({ applied: false, reason, currentLevel });
    const res = await call('POST', { imageId: '12', nsfwLevel: '4', userId: '9' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      imageId: 12,
      outcome: 'skipped',
      reason,
      currentLevel,
    });
  });

  it.each([
    ['a level that is not a rating', { imageId: '12', nsfwLevel: '3', userId: '9' }],
    ['a missing image id', { nsfwLevel: '4', userId: '9' }],
    ['an empty body', {}],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await call('POST', body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(setImageNsfwLevelFromKnights).not.toHaveBeenCalled();
  });

  it.each(['32', '0', '64'])('refuses level %s: a vote never blocks an image', async (level) => {
    const res = await call('POST', { imageId: '12', nsfwLevel: level, userId: '9' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(setImageNsfwLevelFromKnights).not.toHaveBeenCalled();
  });

  it.each(['1', '2', '4', '8', '16'])('accepts the regular level %s', async (level) => {
    await call('POST', { imageId: '12', nsfwLevel: level, userId: '9' });
    expect(setImageNsfwLevelFromKnights).toHaveBeenCalledTimes(1);
  });

  it('only answers POST', async () => {
    const res = await call('GET', {});
    expect(res.status).toHaveBeenCalledWith(405);
    expect(setImageNsfwLevelFromKnights).not.toHaveBeenCalled();
  });
});
