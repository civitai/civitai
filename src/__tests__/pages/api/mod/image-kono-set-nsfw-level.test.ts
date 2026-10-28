import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

const { updateImageNsfwLevel } = vi.hoisted(() => ({
  updateImageNsfwLevel: vi.fn(async () => 4),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  updateImageNsfwLevel,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

const { default: handler } = await import('~/pages/api/mod/image/kono-set-nsfw-level');

const call = (method: string, body: Record<string, unknown>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const done = handler({ method, body } as NextApiRequest, res as unknown as NextApiResponse);
  return { res, done };
};

beforeEach(() => vi.clearAllMocks());

describe('/api/mod/image/kono-set-nsfw-level', () => {
  it('records a Knights result, not a moderator ruling', async () => {
    const { done } = call('POST', { imageId: '12', nsfwLevel: '4', userId: '9' });
    await done;

    expect(updateImageNsfwLevel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 12,
        nsfwLevel: 4,
        userId: 9,
        isModerator: true,
        activity: 'setNsfwLevelKono',
      })
    );
  });

  it('refuses a level that is not a rating', async () => {
    await expect(
      call('POST', { imageId: '12', nsfwLevel: '3', userId: '9' }).done
    ).rejects.toThrow();
    expect(updateImageNsfwLevel).not.toHaveBeenCalled();
  });

  it.each(['32', '0', '64'])('refuses level %s: a vote never blocks an image', async (level) => {
    await expect(
      call('POST', { imageId: '12', nsfwLevel: level, userId: '9' }).done
    ).rejects.toThrow();
    expect(updateImageNsfwLevel).not.toHaveBeenCalled();
  });

  it.each(['1', '2', '4', '8', '16'])('accepts the regular level %s', async (level) => {
    await call('POST', { imageId: '12', nsfwLevel: level, userId: '9' }).done;
    expect(updateImageNsfwLevel).toHaveBeenCalledTimes(1);
  });

  it('only answers POST', async () => {
    const { res, done } = call('GET', {});
    await done;
    expect(res.status).toHaveBeenCalledWith(405);
    expect(updateImageNsfwLevel).not.toHaveBeenCalled();
  });
});
