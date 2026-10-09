import { describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * The profile Showcase reads image.getEntitiesCoverImage. Before launch only a flagged viewer sees
 * event hats, and getEntityCoverImage treats a missing viewer as signed out, so the handler has to
 * name the session user or the Showcase shows no hats while the image feed does.
 */

const { covers } = vi.hoisted(() => ({ covers: vi.fn(async () => []) }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getEntityCoverImage: covers,
}));

const { getEntitiesCoverImageHandler } = await import('~/server/controllers/image.controller');

describe('getEntitiesCoverImageHandler', () => {
  it('names the session user as the event decoration viewer', async () => {
    const user = { id: 5 };
    await getEntitiesCoverImageHandler({
      input: { entities: [{ entityType: 'Image', entityId: 1 }] },
      ctx: { user } as never,
    });
    expect(covers).toHaveBeenCalledWith(expect.objectContaining({ eventDecorationViewer: user }));
  });
});
