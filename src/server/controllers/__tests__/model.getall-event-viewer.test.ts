import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelService from '~/server/services/model.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * model.getAll decorates each card with its event hat, gated on the viewer it is given. Before
 * launch only a flagged viewer sees hats, and a moderator is in every flag audience, so the viewer
 * must be eventViewerOf(ctx): a moderator counts only on a session or a full-access personal key.
 */
const { getModelsWithImagesAndModelVersions } = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
}));

import { getModelsInfiniteHandler } from '~/server/controllers/model.controller';

const moderator = { id: 5, isModerator: true };
const scopedKey = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope: TokenScope.ModelsRead,
};

beforeEach(() => {
  getModelsWithImagesAndModelVersions.mockReset();
  getModelsWithImagesAndModelVersions.mockResolvedValue({ items: [], isPrivate: false });
});

describe('model.getAll event decoration viewer', () => {
  it.each([
    ['a session', {}, true],
    ['a scoped token', scopedKey, false],
  ])('asks the hat gate about a moderator on %s', async (_label, credential, isModerator) => {
    await getModelsInfiniteHandler({
      input: { limit: 20, browsingLevel: 1 },
      ctx: {
        user: moderator,
        ...credential,
        features: {},
        req: { headers: {} },
        cache: { canCache: true },
      },
    } as never);
    const [arg] = getModelsWithImagesAndModelVersions.mock.calls.at(-1)!;
    expect((arg as { eventDecorationViewer?: unknown }).eventDecorationViewer).toEqual({
      id: 5,
      isModerator,
    });
  });
});

describe('model.getAll held-showcase viewer', () => {
  it.each([
    ['a session', {}, true],
    ['a scoped token', scopedKey, false],
  ])('exempts a moderator from the hold only on %s', async (_label, credential, heldViewer) => {
    await getModelsInfiniteHandler({
      input: { limit: 20, browsingLevel: 1 },
      ctx: {
        user: moderator,
        ...credential,
        features: {},
        req: { headers: {} },
        cache: { canCache: true },
      },
    } as never);
    const [arg] = getModelsWithImagesAndModelVersions.mock.calls.at(-1)!;
    expect((arg as { heldViewer?: boolean }).heldViewer).toBe(heldViewer);
  });
});
