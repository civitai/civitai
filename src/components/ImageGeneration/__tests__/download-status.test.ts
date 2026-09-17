import { beforeEach, describe, expect, it } from 'vitest';
import { Air } from '@civitai/client';
import {
  describeDownload,
  mergeDownloadRow,
  summarizeDownloads,
  toDownloadRow,
  versionIdFromAir,
} from '~/components/ImageGeneration/download-status';

describe('toDownloadRow', () => {
  it.each([
    [{ status: 'available', workers: 1 }],
    [{ status: 'unsupported' }],
    [{ status: 'unknown' }],
  ] as const)('has no row for %o', (availability) => {
    expect(toDownloadRow(availability)).toBeUndefined();
  });

  it('keeps a queued model’s lane, cap and boosted ETA', () => {
    expect(
      toDownloadRow(
        {
          status: 'queued',
          queuePosition: 2,
          lane: 'low',
          etaSeconds: 600,
          boostedEtaSeconds: 60,
          rateLimitBytesPerSecond: 5_625_000,
        },
        100
      )
    ).toEqual({
      lane: 'low',
      queuePosition: 2,
      etaSeconds: 600,
      boostedEtaSeconds: 60,
      rateLimitBytesPerSecond: 5_625_000,
      sizeBytes: 100,
    });
  });

  it('keeps a transferring model’s progress', () => {
    expect(
      toDownloadRow({ status: 'loading', progress: 0.4, workers: 1, lane: 'low', etaSeconds: 30 })
    ).toMatchObject({ progress: 0.4, lane: 'low', etaSeconds: 30 });
  });

  it('keeps the position of a model queued in the pre-beta.105 shape', () => {
    expect(toDownloadRow({ status: 'unavailable', queuePosition: 3 })).toMatchObject({
      queuePosition: 3,
    });
  });

  it('reads a not-yet-queued model as a row with no position', () => {
    const row = toDownloadRow({ status: 'unavailable' });
    expect(row).toBeDefined();
    expect(row?.queuePosition).toBeUndefined();
  });
});

describe('summarizeDownloads', () => {
  it('is undefined when nothing is downloading', () => {
    expect(summarizeDownloads([])).toBeUndefined();
  });

  // The generation starts only when its last download does, so a fast model must not set the ETA.
  it('reads the generation through its slowest download', () => {
    const summary = summarizeDownloads([
      { lane: 'low', queuePosition: 0, etaSeconds: 60, rateLimitBytesPerSecond: 1, sizeBytes: 10 },
      {
        lane: 'low',
        queuePosition: 4,
        etaSeconds: 900,
        boostedEtaSeconds: 90,
        rateLimitBytesPerSecond: 2,
        sizeBytes: 20,
      },
    ]);

    expect(summary).toEqual({
      lane: 'low',
      transferring: false,
      queuePosition: 4,
      etaSeconds: 900,
      boostedEtaSeconds: 90,
      rateLimitBytesPerSecond: 2,
      totalBytes: 30,
      count: 2,
    });
  });

  it('finds the slowest download wherever it sits, and the largest boosted ETA across all', () => {
    const summary = summarizeDownloads([
      { lane: 'low', queuePosition: 5, etaSeconds: 900, boostedEtaSeconds: 60 },
      { lane: 'low', queuePosition: 1, etaSeconds: 100, boostedEtaSeconds: 120 },
    ]);
    expect(summary).toMatchObject({ queuePosition: 5, etaSeconds: 900, boostedEtaSeconds: 120 });
  });

  it('reads a transferring download as position 0', () => {
    expect(summarizeDownloads([{ lane: 'low', progress: 0.4, etaSeconds: 30 }])).toMatchObject({
      transferring: true,
      queuePosition: 0,
    });
  });

  it('prefers a model already in a lane when no ETA is known', () => {
    expect(summarizeDownloads([{}, { lane: 'normal', queuePosition: 1 }])).toMatchObject({
      lane: 'normal',
      queuePosition: 1,
    });
  });

  it('has no position before the download is queued', () => {
    expect(summarizeDownloads([{}])).toMatchObject({ lane: undefined, queuePosition: null });
  });
});

describe('describeDownload', () => {
  it.each([
    [{ progress: 0.42, etaSeconds: 180 }, 'Downloading 42% · ~3 min'],
    [{ queuePosition: 0, etaSeconds: 600 }, '#1 in queue · ~10 min'],
    [{ queuePosition: 2 }, '#3 in queue'],
    [{}, 'Waiting to start'],
  ])('%o reads as "%s"', (row, expected) => {
    expect(describeDownload(row)).toBe(expected);
  });
});

describe('versionIdFromAir', () => {
  /** The global `@civitai/client` stub has no `Air.parseSafe`, so without a real one every AIR here
   * would read as "no version" and every assertion below would pass for the wrong reason. */
  beforeEach(() => {
    (Air as unknown as Record<string, unknown>).parseSafe = (identifier: string) => {
      const match =
        /^urn:air:([^:]+):([^:]+):([^:]+):([^@]+)(?:@([^+.]+))?(?:\+(\d+))?(?:\.([\w-]+))?$/.exec(
          identifier
        );
      if (!match) return null;
      const [, ecosystem, type, source, id, version, modelFileId, format] = match;
      return { ecosystem, type, source, id, version, modelFileId, format };
    };
  });

  it.each([
    ['urn:air:sdxl:checkpoint:civitai:1@2', 2],
    ['urn:air:flux1:checkpoint:civitai:2938492@3326598+3212388', 3326598],
    // The format suffix `stringifyAIR` can emit — a hand-rolled `@(\d+)$` regex drops this model
    // out of the card's list entirely.
    ['urn:air:sdxl:checkpoint:civitai:1@2.safetensor', 2],
    ['urn:air:other:other:civitai-b2:civitai-media-uploads@25ef105a-22f4', undefined],
    ['urn:air:sdxl:checkpoint:civitai:1', undefined],
  ])('%s → %s', (air, expected) => {
    expect(versionIdFromAir(air)).toBe(expected);
  });
});

describe('mergeDownloadRow', () => {
  const prepared = {
    lane: 'low',
    queuePosition: 2,
    etaSeconds: 600,
    boostedEtaSeconds: 60,
    rateLimitBytesPerSecond: 1,
    sizeBytes: 50,
  };

  it('uses the workflow’s preparation until live status answers', () => {
    expect(mergeDownloadRow(prepared, undefined)).toBe(prepared);
  });

  // A download is shared, so its live lane is whoever asked highest — a member's generation put
  // this card in "Priority" while the workflow itself was in the low lane.
  it('keeps the workflow’s lane, cap and position over the shared download’s', () => {
    const row = mergeDownloadRow(prepared, {
      availability: {
        status: 'queued',
        queuePosition: 0,
        lane: 'normal',
        etaSeconds: 300,
        rateLimitBytesPerSecond: 9,
      },
    });
    expect(row).toMatchObject({
      lane: 'low',
      queuePosition: 2,
      rateLimitBytesPerSecond: 1,
      boostedEtaSeconds: 60,
      etaSeconds: 300,
    });
  });

  it('takes transfer progress from live status', () => {
    expect(
      mergeDownloadRow(prepared, {
        availability: { status: 'loading', progress: 0.5, workers: 1, lane: 'normal' },
      })
    ).toMatchObject({ progress: 0.5, lane: 'low', etaSeconds: 600 });
  });

  it('drops a model once live status says it has landed', () => {
    expect(
      mergeDownloadRow(prepared, { availability: { status: 'available', workers: 1 } })
    ).toBeUndefined();
  });

  // Everything a shared download reports — lane, position, ETA, the boosted ETA that drives the paid
  // offer — describes whoever asked highest. Without preparation, only progress and size survive.
  it('keeps nothing lane-specific for a model the workflow’s preparation does not cover', () => {
    const row = mergeDownloadRow(undefined, {
      availability: {
        status: 'queued',
        queuePosition: 1,
        lane: 'normal',
        etaSeconds: 300,
        boostedEtaSeconds: 30,
        rateLimitBytesPerSecond: 9,
      },
      size: 10,
    });
    expect(row).toMatchObject({ sizeBytes: 10 });
    expect(row?.lane).toBeUndefined();
    expect(row?.rateLimitBytesPerSecond).toBeUndefined();
    expect(row?.queuePosition).toBeUndefined();
    expect(row?.etaSeconds).toBeUndefined();
    // The one that costs money: this is what makes the Boost offer appear and fills its comparison.
    expect(row?.boostedEtaSeconds).toBeUndefined();
  });
});
