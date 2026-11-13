import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticService from '~/server/services/cosmetic.service';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';
import type * as MediaVisibility from '~/server/utils/image-media-visibility';

/**
 * The image detail opened on its own (`/images/[id]`, no feed to seed it) reads its image from
 * image.get, so image.get carries the image's event hat for this viewer. To whoever changes this:
 * before launch only a flagged viewer sees hats and the lookup is gated on the viewer it is given,
 * so it must be the request's viewer (eventViewerOf: a scoped or OAuth token never counts as a
 * moderator), the route must stay uncached per URL, and an image whose media the viewer may not see
 * carries no hat either.
 */
const { getImage, decorations, canSee } = vi.hoisted(() => ({
  getImage: vi.fn(async () => ({
    id: 1,
    postId: 30,
    url: 'key',
    nsfwLevel: 1,
    metadata: null,
    user: { id: 7 },
  })),
  decorations: vi.fn(),
  canSee: vi.fn(async () => true),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImage,
}));
vi.mock('~/server/services/cosmetic.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticService>()),
  getEventDecorationsForEntity: decorations,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: async () => false,
}));
vi.mock('~/server/utils/image-media-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaVisibility>()),
  viewerCanSeeImageMedia: canSee,
}));

const { getImageHandler } = await import('~/server/controllers/image.controller');

type HandlerCtx = Parameters<typeof getImageHandler>[0]['ctx'];
const hat = { id: 9, data: { type: 'hat', event: 'birthday2026', url: 'hat.png' } };
const ctxFor = (extra: Record<string, unknown>) =>
  ({ req: { headers: {} }, features: {}, ...extra } as unknown as HandlerCtx);

beforeEach(() => {
  vi.clearAllMocks();
  decorations.mockResolvedValue({ 1: hat });
  canSee.mockResolvedValue(true);
});

describe('getImageHandler event hat', () => {
  it('fails open: a failed hat lookup still returns the image, with no hat', async () => {
    decorations.mockRejectedValue(new Error('cache down'));
    const result = await getImageHandler({
      input: { id: 1 },
      ctx: ctxFor({ user: { id: 5 } }),
    });
    expect(result.id).toBe(1);
    expect(result.url).toBe('key');
    expect(result.eventDecoration).toBeNull();
  });

  it("carries the image's hat, looked up for this one id as this viewer", async () => {
    const result = await getImageHandler({
      input: { id: 1 },
      ctx: ctxFor({ user: { id: 5, isModerator: true } }),
    });
    expect(result.eventDecoration).toEqual(hat);
    expect(decorations).toHaveBeenCalledTimes(1);
    expect(decorations).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: [1],
        entity: 'Image',
        viewer: { id: 5, isModerator: true },
      })
    );
  });

  it('a moderator on an OAuth token is looked up as the user alone', async () => {
    await getImageHandler({
      input: { id: 1 },
      ctx: ctxFor({ user: { id: 5, isModerator: true }, subject: 'oauth-client' }),
    });
    expect(decorations.mock.calls[0][0]).toMatchObject({ viewer: { id: 5, isModerator: false } });
  });

  it('gate: no hat when the lookup returns none for this viewer', async () => {
    decorations.mockResolvedValue({});
    const result = await getImageHandler({ input: { id: 1 }, ctx: ctxFor({}) });
    expect(result.eventDecoration).toBeNull();
    expect(decorations.mock.calls[0][0]).toMatchObject({ viewer: { id: undefined } });
  });

  it('no hat on an image whose media the viewer may not see', async () => {
    canSee.mockResolvedValue(false);
    const result = await getImageHandler({
      input: { id: 1 },
      ctx: ctxFor({ user: { id: 5 } }),
    });
    expect(result.url).toBeNull();
    expect(result.eventDecoration).toBeNull();
  });
});

describe('image.get stays per-viewer', () => {
  it('has no cache middleware', () => {
    const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
    const start = router.indexOf('\n  get: ');
    expect(start, 'image.get procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getImageHandler)', start);
    expect(end).toBeGreaterThan(start);
    const route = router.slice(start, end);
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    expect(route).not.toMatch(/\.use\(/);
  });
});
