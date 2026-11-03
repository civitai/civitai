import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

// The comics procedures sit behind `comicCreator`; a chapter's comment section, read through the
// comment routers, must answer the same way to a reader without it.

const flags = { comicCreator: true };
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: flags.comicCreator }),
}));

const { assertCommentEntityVisible } = await import('~/server/controllers/commentv2.controller');

const ctx = { user: { id: 9, isModerator: false }, features: {}, req: undefined } as never;

beforeEach(() => {
  flags.comicCreator = true;
});

describe('a comic chapter section and the comicCreator flag', () => {
  it('is refused as not found to a reader without the flag', async () => {
    flags.comicCreator = false;
    await expect(
      assertCommentEntityVisible({ entityType: 'comicChapter', entityId: 3 }, ctx)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is open to a reader with the flag', async () => {
    await expect(
      assertCommentEntityVisible({ entityType: 'comicChapter', entityId: 3 }, ctx)
    ).resolves.toBeUndefined();
  });

  // The control: without it the first case passes for a gate that refuses every surface.
  it('does not gate another surface on the flag', async () => {
    flags.comicCreator = false;
    await expect(
      assertCommentEntityVisible({ entityType: 'image', entityId: 3 }, ctx)
    ).resolves.toBeUndefined();
  });
});
