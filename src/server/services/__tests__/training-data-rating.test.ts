import { afterEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/env.mock';

const { mockHeadBlob } = vi.hoisted(() => ({ mockHeadBlob: vi.fn() }));
vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  headBlob: mockHeadBlob,
}));
import {
  datasetRating,
  extractionRating,
  HEADER_PASS_DEADLINE_MS,
} from '~/server/services/training-data-rating';
import { NsfwLevel } from '~/server/common/enums';

describe('datasetRating', () => {
  it('ORs the levels of the media entries and is fully rated when each has one', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'image', nsfwLevel: 'r' },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG | NsfwLevel.R, fullyRated: true });
  });

  it('ignores caption entries, so a captioned PG zip is fully rated', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'text', nsfwLevel: null },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: true });
  });

  it('is not fully rated when one media entry has no level', () => {
    expect(
      datasetRating([
        { mediaType: 'image', nsfwLevel: 'pg' },
        { mediaType: 'image', nsfwLevel: null },
      ])
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: false });
  });

  it('is not fully rated with no media entries at all', () => {
    expect(datasetRating([{ mediaType: 'text' }])).toEqual({
      nsfwLevel: undefined,
      fullyRated: false,
    });
  });

  it('treats an unknown level as unrated', () => {
    expect(datasetRating([{ mediaType: 'image', nsfwLevel: 'unknown' }])).toEqual({
      nsfwLevel: undefined,
      fullyRated: false,
    });
  });
});

describe('extractionRating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockHeadBlob.mockReset();
  });

  it('counts the entries left when the header pass runs out of time as unrated', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const entries = Array.from({ length: 16 }, (_, i) => ({
      air: `urn:air:other:other:orchestrator:blob@k${i}`,
      mediaType: 'image',
    }));
    // The first batch of 8 is read; then the deadline passes.
    mockHeadBlob.mockImplementation(async () => {
      await null;
      now = HEADER_PASS_DEADLINE_MS + 1;
      return { response: new Response(null, { headers: { 'x-nsfw-level': 'pg' } }) };
    });
    const rating = await extractionRating({ entries }, 'wf-1');
    expect(mockHeadBlob).toHaveBeenCalledTimes(8);
    expect(mockHeadBlob.mock.calls[0][0]).toMatchObject({
      path: { blobId: 'k0' },
      query: { workflowId: 'wf-1' },
    });
    expect(rating).toEqual({ nsfwLevel: 1, fullyRated: false });
  });
});
