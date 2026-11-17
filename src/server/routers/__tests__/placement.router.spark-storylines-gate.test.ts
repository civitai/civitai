import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemixGalleryService from '~/server/services/remix-gallery.service';
import { PLACER, placementCaller } from './placement.router.test-utils';

/** Storylines on remix cards are asked for only when the caller has both flags. */

const getRemixGalleryCardSummaries = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGalleryService>()),
  getRemixGalleryCardSummaries,
}));

beforeEach(() => getRemixGalleryCardSummaries.mockClear());

const summaries = (features: Record<string, boolean>) =>
  placementCaller({ features }).getRemixGalleryCardSummaries({ imageIds: [1], browsingLevel: 1 });

const storylinesFor = () =>
  (getRemixGalleryCardSummaries.mock.calls[0] as unknown as [{ storylinesFor?: unknown }])[0]
    .storylinesFor;

describe('remix card summaries: storylines started from an image', () => {
  it('asks for them, for this viewer, when both storylines and remixGallery are on', async () => {
    await summaries({ storylines: true, remixGallery: true });
    expect(storylinesFor()).toEqual({ viewer: { id: PLACER, isModerator: false } });
  });

  it.each([
    ['storylines is off', { storylines: false, remixGallery: true }],
    ['remixGallery is off', { storylines: true, remixGallery: false }],
  ])('does not ask for them when %s', async (_name, features) => {
    await summaries(features);
    expect(getRemixGalleryCardSummaries).toHaveBeenCalledTimes(1);
    expect(storylinesFor()).toBeUndefined();
  });
});
