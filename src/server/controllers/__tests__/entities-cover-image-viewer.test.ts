import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Deliberate: this route answers with the VIEWER's hats, so it must never be cached for others.
 * Only signed-out responses get an edge TTL today (createContext). edgeCacheIt overrides that for
 * signed-in users and cacheIt shares one answer across viewers, so either would publish a flagged
 * viewer's pre-launch hats. If you want this route cached, drop the viewer first.
 */
describe('image.getEntitiesCoverImage stays per-viewer', () => {
  it('has no edgeCacheIt or cacheIt', () => {
    const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
    const start = router.indexOf('getEntitiesCoverImage: publicProcedure');
    expect(start, 'getEntitiesCoverImage procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getEntitiesCoverImageHandler)', start);
    expect(end, 'getEntitiesCoverImage handler not found after the procedure').toBeGreaterThan(
      start
    );
    expect(router.slice(start, end)).not.toMatch(/edgeCacheIt|cacheIt/);
  });
});
