import { describe, expect, it } from 'vitest';
import {
  describeDownload,
  summarizeDownloads,
  toDownloadRow,
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

  it('reads a not-yet-queued model as a row with no position', () => {
    expect(toDownloadRow({ status: 'unavailable' })).toEqual({
      queuePosition: undefined,
      sizeBytes: undefined,
    });
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
