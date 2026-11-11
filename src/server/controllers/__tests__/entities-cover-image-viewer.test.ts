import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The profile Showcase reads image.getEntitiesCoverImage. Before launch only a flagged viewer sees
 * event hats, and getEntityCoverImage treats a missing viewer as signed out, so the handler has to
 * name the viewer (eventViewerOf: a moderator counts only on a session or a full-access key) or the
 * Showcase shows no hats while the image feed does.
 */

const { covers } = vi.hoisted(() => ({ covers: vi.fn(async () => []) }));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getEntityCoverImage: covers,
}));

const { getEntitiesCoverImageHandler } = await import('~/server/controllers/image.controller');

describe('getEntitiesCoverImageHandler', () => {
  const moderator = { id: 5, isModerator: true };
  const scopedKey = {
    apiKeyId: 9,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey', id: 9 },
    tokenScope: TokenScope.MediaRead,
  };

  it.each([
    ['a session', {}, true],
    ['a scoped token', scopedKey, false],
  ])(
    'names the viewer as the event decoration viewer (moderator on %s)',
    async (_label, credential, isModerator) => {
      await getEntitiesCoverImageHandler({
        input: { entities: [{ entityType: 'Image', entityId: 1 }] },
        ctx: { user: moderator, ...credential } as never,
      });
      expect(covers).toHaveBeenLastCalledWith(
        expect.objectContaining({ eventDecorationViewer: { id: 5, isModerator } })
      );
    }
  );

  it('resolves covers as the session user, so owners and moderators keep hidden covers', async () => {
    const user = { id: 5, isModerator: true };
    await getEntitiesCoverImageHandler({
      input: { entities: [{ entityType: 'Image', entityId: 1 }] },
      ctx: { user } as never,
    });
    expect(covers).toHaveBeenCalledWith(expect.objectContaining({ viewer: user }));
  });
});

/**
 * Deliberate: this route answers with the VIEWER's hats, so it must never be cached for others.
 * Only signed-out responses get an edge TTL today (createContext). edgeCacheIt overrides that for
 * signed-in users and cacheIt shares one answer across viewers, so either would publish a flagged
 * viewer's pre-launch hats. If you want this route cached, drop the viewer first.
 */
describe('image.getEntitiesCoverImage stays per-viewer', () => {
  it('has no cache or other middleware', () => {
    const router = readFileSync(join(process.cwd(), 'src/server/routers/image.router.ts'), 'utf8');
    const start = router.indexOf('getEntitiesCoverImage: publicProcedure');
    expect(start, 'getEntitiesCoverImage procedure not found').toBeGreaterThan(-1);
    const end = router.indexOf('.query(getEntitiesCoverImageHandler)', start);
    expect(end, 'getEntitiesCoverImage handler not found after the procedure').toBeGreaterThan(
      start
    );
    const route = router.slice(start, end);
    expect(route).not.toMatch(/edgeCacheIt|cacheIt/);
    // Any middleware here could set a shared cache under another name; add one only after
    // checking it keeps responses per-viewer, then widen this.
    expect(route).not.toMatch(/\.use\(/);
  });
});
