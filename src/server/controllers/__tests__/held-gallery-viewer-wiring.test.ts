import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModelService from '~/server/services/model.service';
import type * as CoverageSource from '~/server/services/generation/coverage-source';

const { feed, downloads, audience, updateModel, reindex, bustRest, bustGallery } = vi.hoisted(
  () => ({
    bustGallery: vi.fn(),
    feed: vi.fn(),
    downloads: vi.fn(),
    audience: vi.fn(),
    updateModel: vi.fn(),
    reindex: vi.fn(),
    bustRest: vi.fn(),
  })
);
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions: feed,
  updateModelById: updateModel,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bustPublicModelResponseCache: bustRest,
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  modelsSearchIndex: { queueUpdate: reindex },
}));
vi.mock('~/server/services/creator-gallery-hidden-users.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bustModelGallerySettings: bustGallery,
}));
vi.mock('~/server/services/download.service', () => ({
  getUserDownloads: downloads,
  hideDownload: vi.fn(),
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: audience,
}));

import {
  getModelsInfiniteHandler,
  updateGallerySettingsHandler,
} from '~/server/controllers/model.controller';
import { getUserDownloadsHandler } from '~/server/controllers/download.controller';

const OWNER = 50;
const feedViewer = async (ctx: object) => {
  await getModelsInfiniteHandler({
    input: { limit: 20, browsingLevel: 1 },
    ctx: { features: {}, req: { headers: {} }, cache: { canCache: true }, ...ctx },
  } as never);
  return feed.mock.calls[0][0].heldViewer;
};

beforeEach(() => {
  vi.clearAllMocks();
  feed.mockResolvedValue({ items: [], isPrivate: false });
  downloads.mockResolvedValue({ items: [] });
  audience.mockResolvedValue({ next: false, member: true });
});

describe('who the model feed shows a held model whole', () => {
  it('the signed-in viewer, to be checked against each model owner', async () => {
    expect(await feedViewer({ user: { id: OWNER } })).toEqual({ id: OWNER, isModerator: false });
  });

  it('nobody for an app acting for them', async () => {
    expect(
      await feedViewer({ user: { id: OWNER, isModerator: true }, subject: { type: 'oauth' } })
    ).toBeUndefined();
  });

  it("the viewer as they were when the request began, if the request's session user changes", async () => {
    const user = { id: OWNER, isModerator: false };
    audience.mockImplementation(async () => {
      user.isModerator = true;
      return { next: false, member: true };
    });
    expect(await feedViewer({ user })).toEqual({ id: OWNER, isModerator: false });
  });
});

describe('who download history shows a held model thumbnail whole', () => {
  it('the signed-in viewer, to be checked against each model owner', async () => {
    await getUserDownloadsHandler({ ctx: { user: { id: OWNER } } } as never);
    expect(downloads.mock.calls[0][0].viewer).toEqual({ id: OWNER, isModerator: false });
  });

  it('nobody for a scoped key acting for them', async () => {
    await getUserDownloadsHandler({
      ctx: { user: { id: OWNER }, apiKeyId: 1, apiKeyType: 'User', tokenScope: 1 },
    } as never);
    expect(downloads.mock.calls[0][0].viewer).toBeUndefined();
  });
});

describe("a held model's gallery level change", () => {
  const change = (flags: { minor: boolean; sfwOnly: boolean }, isModerator = false) => {
    updateModel.mockImplementation(async ({ data }: { data: (model: object) => unknown }) => {
      data({ id: 7, userId: OWNER, ...flags });
      return { id: 7 };
    });
    return updateGallerySettingsHandler({
      input: { id: 7, gallerySettings: null },
      ctx: { user: { id: isModerator ? 99 : OWNER, isModerator } },
    } as never);
  };

  it('rebuilds its search document and drops its cached REST body', async () => {
    await change({ minor: false, sfwOnly: true });
    expect(reindex.mock.calls).toEqual([[[{ id: 7, action: 'Update' }]]]);
    expect(bustRest.mock.calls).toEqual([[7]]);
  });

  it("does the same when a moderator changes it, the one change that can widen a held model's level", async () => {
    await change({ minor: true, sfwOnly: true }, true);
    expect(reindex.mock.calls).toEqual([[[{ id: 7, action: 'Update' }]]]);
    expect(bustRest.mock.calls).toEqual([[7]]);
  });

  it('still saves and drops the REST body when the reindex cannot be queued', async () => {
    reindex.mockRejectedValueOnce(new Error('queue down'));
    await expect(change({ minor: true, sfwOnly: false })).resolves.toMatchObject({ id: 7 });
    expect(bustRest.mock.calls).toEqual([[7]]);
  });

  it('still drops the REST body and queues the rewrite when the settings cache cannot be dropped', async () => {
    bustGallery.mockRejectedValueOnce(new Error('redis down'));
    await expect(change({ minor: true, sfwOnly: false })).resolves.toMatchObject({ id: 7 });
    expect(bustRest.mock.calls).toEqual([[7]]);
    expect(reindex.mock.calls).toEqual([[[{ id: 7, action: 'Update' }]]]);
  });

  it('leaves an unheld model to the caches that already follow its gallery', async () => {
    await change({ minor: false, sfwOnly: false });
    expect(reindex).not.toHaveBeenCalled();
    expect(bustRest).not.toHaveBeenCalled();
  });
});
