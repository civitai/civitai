import type { NsfwLevel } from '@civitai/orchestration-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationGraphStore from '~/store/generation-graph.store';
import { hasMatureSource } from '~/shared/form-graph/generation/video/flux3-mature-source';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { sourceMetadataStore, useSourceMetadataStore } from '~/store/source-metadata.store';

/**
 * Animate opens H3, but the user can switch to Flux 3 Video, which refuses a mature source before
 * Generate. A gallery source is an on-site url with no other rating, so the image's own level has
 * to come along with it, keyed by the url the form actually holds.
 */

const setData = vi.fn();

vi.mock('~/store/generation-graph.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationGraphStore>()),
  generationGraphPanel: { open: vi.fn() },
  generationGraphStore: { setData },
  fetchGenerationData: async () => ({ params: {}, resources: [] }),
  withExternalFetch: async <T>(run: () => Promise<T>) => ({
    result: await run(),
    superseded: false,
  }),
}));

const { startRemix } = await import('../remix.utils');

async function animate(nsfwLevel: number, type: MediaType = MediaType.image) {
  await startRemix({
    kind: 'video',
    image: {
      id: 1,
      url: 'abc-123',
      type,
      ingestion: ImageIngestionStatus.Scanned,
      width: 832,
      height: 1216,
      nsfwLevel,
    },
  });
  const sourceUrl: string = setData.mock.calls[0][0].params.images[0].url;
  return hasMatureSource(
    [sourceUrl],
    (url) => sourceMetadataStore.getMetadata(url)?.nsfwLevel as NsfwLevel | undefined
  );
}

beforeEach(() => {
  setData.mockClear();
  useSourceMetadataStore.getState().clearAll();
});

describe('Animate on a gallery image carries its rating to the source', () => {
  it.each([
    ['R', 4],
    ['X', 8],
    ['XXX', 16],
    ['Blocked', 32],
  ])('a %s image reads as mature', async (_label, nsfwLevel) => {
    expect(await animate(nsfwLevel)).toBe(true);
  });

  it.each([
    ['PG', 1],
    ['PG-13', 2],
    ['unrated', 0],
  ])('a %s image does not', async (_label, nsfwLevel) => {
    expect(await animate(nsfwLevel)).toBe(false);
  });
});

describe('Animate on a video carries its rating to the frame url', () => {
  it.each([
    ['R', 4, 'r'],
    ['PG', 1, 'pg'],
  ])(
    'a %s video: the rating is keyed by the frame, not the mp4',
    async (_label, nsfwLevel, key) => {
      await animate(nsfwLevel, MediaType.video);
      const frameUrl: string = setData.mock.calls[0][0].params.images[0].url;

      expect(frameUrl).toContain('anim=false');
      expect(frameUrl).toMatch(/\.jpeg$/);
      expect(sourceMetadataStore.getMetadata(frameUrl)?.nsfwLevel).toBe(key);
    }
  );
});
