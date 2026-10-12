import { describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as ImageService from '~/server/services/image.service';

/**
 * `image.get` is public and its result is dehydrated into `/images/[id]`, so the route itself has
 * to hold back media the viewer's gate would not show. The service stays unfiltered for its
 * server-side callers.
 */

const { image } = vi.hoisted(() => ({ image: vi.fn() }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImage: image,
}));

const { getImageHandler } = await import('~/server/controllers/image.controller');

const rated = (nsfwLevel: number) => ({
  id: 1,
  url: 'media-key',
  nsfwLevel,
  metadata: null,
  user: { id: 7 },
});

const signedOut = (canViewNsfw: boolean) =>
  ({ features: { canViewNsfw }, req: { headers: {} }, cache: null } as never);

describe('getImageHandler', () => {
  it.each([
    ['SFW', false],
    ['mature', true],
  ])('sends a signed-out viewer on the %s domain no media above PG', async (_, canViewNsfw) => {
    image.mockResolvedValueOnce(rated(NsfwLevel.R));
    const withheld = await getImageHandler({ input: { id: 1 }, ctx: signedOut(canViewNsfw) });
    expect(withheld.url).toBeNull();

    image.mockResolvedValueOnce(rated(NsfwLevel.PG));
    const shown = await getImageHandler({ input: { id: 1 }, ctx: signedOut(canViewNsfw) });
    expect(shown.url).toBe('media-key');
  });
});
