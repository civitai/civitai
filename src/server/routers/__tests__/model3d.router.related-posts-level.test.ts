import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as Model3DService from '~/server/services/model3d.service';
import { NsfwLevel } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The procedure hands the service the viewer's own capped level: a router that dropped it would
// leave every viewer at the service's PG default, and one that passed the input through would
// let a request ask past its cap.

const { related } = vi.hoisted(() => ({
  related: vi.fn(async (..._: unknown[]) => ({ items: [], nextCursor: undefined })),
}));
vi.mock('~/server/services/model3d.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Model3DService>()),
  getModel3DRelatedPosts: related,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({ model3dFeed: true }),
}));

const { model3dRouter } = await import('../model3d.router');

const caller = (
  user: Record<string, unknown> | undefined,
  canViewNsfw: boolean,
  isGreen = !canViewNsfw
) =>
  model3dRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { model3dFeed: true, canViewNsfw, isGreen },
    track: {},
  } as never);

const levelPassed = async (
  user: Record<string, unknown> | undefined,
  canViewNsfw: boolean,
  browsingLevel?: number
) => {
  await caller(user, canViewNsfw).getRelatedPosts({ model3dId: 1, browsingLevel });
  return (related.mock.calls[0][0] as { browsingLevel: number }).browsingLevel;
};

beforeEach(() => related.mockClear());

describe('model3d.getRelatedPosts', () => {
  it('passes a signed-out viewer PG, whatever the request asks', async () => {
    expect(await levelPassed(undefined, true, NsfwLevel.XXX)).toBe(NsfwLevel.PG);
  });

  it('passes a signed-in mature viewer their saved level, or the one they ask for', async () => {
    const user = {
      id: 7,
      isModerator: false,
      showNsfw: true,
      browsingLevel: NsfwLevel.PG | NsfwLevel.R,
    };
    expect(await levelPassed(user, true)).toBe(NsfwLevel.PG | NsfwLevel.R);
    related.mockClear();
    expect(await levelPassed(user, true, NsfwLevel.XXX)).toBe(NsfwLevel.XXX);
  });

  it('lets unrated content through only where the domain serves mature content', async () => {
    const moderator = { id: 1, isModerator: true, showNsfw: true, browsingLevel: NsfwLevel.PG };
    const servesUnrated = async (canViewNsfw: boolean) => {
      related.mockClear();
      await caller(moderator, canViewNsfw).getRelatedPosts({ model3dId: 1 });
      return (related.mock.calls[0][0] as { servesUnrated: boolean }).servesUnrated;
    };
    expect(await servesUnrated(false)).toBe(false);
    expect(await servesUnrated(true)).toBe(true);
  });

  it('decides unrated by the domain, not by the viewer, for any viewer', async () => {
    const viewer = { id: 7, isModerator: false, showNsfw: true, browsingLevel: NsfwLevel.PG };
    const servesUnrated = async (isGreen: boolean) => {
      related.mockClear();
      // A mature-enabled viewer either way: only the domain differs.
      await caller(viewer, true, isGreen).getRelatedPosts({ model3dId: 1 });
      return (related.mock.calls[0][0] as { servesUnrated: boolean }).servesUnrated;
    };
    expect(await servesUnrated(true)).toBe(false);
    expect(await servesUnrated(false)).toBe(true);
  });
});
