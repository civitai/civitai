import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `collection.getEntryCount` through the REAL router: the viewer's moderator status reaches the
 * service, which reads permissions with it. The service is replaced; its rule is covered in
 * `services/__tests__/collection-item-read-permission.test.ts`.
 */

const { getCollectionEntryCount } = vi.hoisted(() => ({ getCollectionEntryCount: vi.fn() }));
vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionEntryCount,
}));

const { collectionRouter } = await import('~/server/routers/collection.router');

const caller = (user: object) =>
  collectionRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
  } as never);

const viewer = { id: 78, muted: false, onboarding: OnboardingSteps.Buzz };

beforeEach(() => {
  vi.clearAllMocks();
  getCollectionEntryCount.mockResolvedValue({ max: 3 });
});

describe('collection.getEntryCount', () => {
  it.each([true, false])('passes the viewer and isModerator: %s to the service', async (isMod) => {
    await caller({ ...viewer, isModerator: isMod }).getEntryCount({ id: 7 });
    expect(getCollectionEntryCount).toHaveBeenCalledWith({
      collectionId: 7,
      userId: 78,
      isModerator: isMod,
    });
  });
});
