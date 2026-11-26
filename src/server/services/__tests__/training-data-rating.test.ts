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
  it('counts a blocked entry as unrated, even with an SFW level', async () => {
    const rating = await extractionRating(
      {
        entries: [
          { mediaType: 'image', blob: { nsfwLevel: 'pg' } },
          { mediaType: 'image', blob: { nsfwLevel: 'pg', blockedReason: 'tos' } },
        ],
      },
      'wf-1'
    );
    expect(rating).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: false });
    expect(mockHeadBlob).not.toHaveBeenCalled();
  });

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

// The rating probe as a fixture (synthetic): the extraction step's output for a zip holding an
// image named 04.txt, a real caption, and an image the orchestrator could not level. Civitai reads
// the step's typing; this pins what it does with each kind.
describe('extractionRating over a captioned zip', () => {
  afterEach(() => mockHeadBlob.mockReset());

  const image04 = {
    air: 'urn:air:other:other:orchestrator:blob@04.txt',
    mediaType: 'image',
    blob: { nsfwLevel: 'pg' },
  };
  const caption = { air: 'urn:air:other:other:orchestrator:blob@01.txt', mediaType: 'text' };
  const unleveled = { air: 'urn:air:other:other:orchestrator:blob@02.png', mediaType: 'image' };

  it('rates the caption-named image and skips the real caption: fully rated', async () => {
    expect(await extractionRating({ entries: [image04, caption] }, 'wf-1')).toEqual({
      nsfwLevel: NsfwLevel.PG,
      fullyRated: true,
    });
    expect(mockHeadBlob).not.toHaveBeenCalled();
  });

  it('counts an image with no level, from the output or its header, as unrated', async () => {
    mockHeadBlob.mockResolvedValue({ response: new Response(null) });
    expect(await extractionRating({ entries: [image04, caption, unleveled] }, 'wf-1')).toEqual({
      nsfwLevel: NsfwLevel.PG,
      fullyRated: false,
    });
    expect(mockHeadBlob).toHaveBeenCalledTimes(1);
  });

  it('rates a text-typed entry that carries a level as media; one with no level stays a caption', async () => {
    const leveledText = { ...caption, blob: { nsfwLevel: 'r' } };
    expect(await extractionRating({ entries: [image04, leveledText] }, 'wf-1')).toEqual({
      nsfwLevel: NsfwLevel.PG | NsfwLevel.R,
      fullyRated: true,
    });
    // Control: a text entry with no level is skipped, not read as an unrated image.
    expect(
      await extractionRating(
        { entries: [image04, { ...caption, blob: { nsfwLevel: null } }] },
        'wf-1'
      )
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: true });
    expect(mockHeadBlob).not.toHaveBeenCalled();
  });

  it('counts a blocked text-typed entry as unrated media, level or not', async () => {
    for (const blob of [{ blockedReason: 'tos' }, { blockedReason: 'tos', nsfwLevel: 'pg' }])
      expect(await extractionRating({ entries: [image04, { ...caption, blob }] }, 'wf-1')).toEqual({
        nsfwLevel: NsfwLevel.PG,
        fullyRated: false,
      });
  });

  it('counts an image as unrated when its header read fails or is refused, without throwing', async () => {
    const unleveled2 = { ...unleveled, air: 'urn:air:other:other:orchestrator:blob@03.png' };
    mockHeadBlob
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ response: new Response(null, { status: 503 }) });
    expect(await extractionRating({ entries: [image04, unleveled, unleveled2] }, 'wf-1')).toEqual({
      nsfwLevel: NsfwLevel.PG,
      fullyRated: false,
    });
    expect(mockHeadBlob).toHaveBeenCalledTimes(2);
  });

  it('counts a rejected entry as unrated', async () => {
    expect(
      await extractionRating({ entries: [image04, caption], rejected: [{ air: 'x' }] }, 'wf-1')
    ).toEqual({ nsfwLevel: NsfwLevel.PG, fullyRated: false });
  });
});
