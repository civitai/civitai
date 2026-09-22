import { describe, expect, it } from 'vitest';
import {
  buildDownloadRows,
  describeDownload,
  downloadPollIds,
  isWorthBoosting,
  mergeDownloadRow,
  summarizeDownloads,
  toDownloadRow,
} from '~/components/ImageGeneration/download-status';
import { ETA_FLOOR_SECONDS } from '~/components/ResourceLoad/download-eta';
import { DOWNLOAD_STATUS_MAX_IDS } from '~/server/schema/resource-load.schema';

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
    // Its own ETA is not believed yet, but the progress is real and worth showing.
    [{ progress: 0.005, etaSeconds: 7_200 }, 'Downloading 1%'],
  ])('%o reads as "%s"', (row, expected) => {
    expect(describeDownload(row)).toBe(expected);
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

describe('summarizeDownloads — warm-up', () => {
  it('reports no ETA while the only transfer is still ramping up', () => {
    expect(summarizeDownloads([{ lane: 'low', progress: 0.001, etaSeconds: 7_200 }])).toMatchObject(
      {
        transferring: true,
        etaSeconds: null,
      }
    );
  });

  it('is told by a settled resource rather than a warming one', () => {
    expect(
      summarizeDownloads([
        { lane: 'low', progress: 0.001, sizeBytes: 1_000, etaSeconds: 7_200 },
        { lane: 'low', queuePosition: 2, etaSeconds: 600 },
      ])
      // Gating moved to the queued row, but a transfer IS under way — reporting a queue position
      // here put '#3 in queue' three lines above 'Downloading 1%' on the same card.
    ).toMatchObject({ etaSeconds: 600, transferring: true, queuePosition: 0 });
  });

  it('withholds the boosted ETA too while the only transfer is warming', () => {
    expect(
      summarizeDownloads([
        {
          lane: 'low',
          progress: 0.001,
          sizeBytes: 1_000,
          etaSeconds: 7_200,
          boostedEtaSeconds: 60,
        },
      ])
    ).toMatchObject({ etaSeconds: null, boostedEtaSeconds: null });
  });
});

describe('isWorthBoosting', () => {
  it('offers a boost that reads as faster', () => {
    expect(
      isWorthBoosting(summarizeDownloads([{ etaSeconds: 3_900, boostedEtaSeconds: 300 }]))
    ).toBe(true);
  });

  it('withholds one the floor has collapsed', () => {
    expect(
      isWorthBoosting(
        summarizeDownloads([{ etaSeconds: ETA_FLOOR_SECONDS - 1, boostedEtaSeconds: 1 }])
      )
    ).toBe(false);
  });

  it('withholds one with no summary at all', () => {
    expect(isWorthBoosting(summarizeDownloads([]))).toBe(false);
  });

  it('withholds one with no boosted ETA', () => {
    expect(isWorthBoosting(summarizeDownloads([{ etaSeconds: 600 }]))).toBe(false);
  });
});

describe('buildDownloadRows', () => {
  const resources = [{ id: 7 }];
  const cachedMidDownload = [
    {
      modelVersionId: 7,
      availability: { status: 'loading' as const, progress: 0.93, workers: 1, lane: 'low' },
      size: 6_620_000_000,
    },
  ];

  it('reports a download while the workflow is still waiting on it', () => {
    const rows = buildDownloadRows({
      resources,
      preparation: undefined,
      preparing: true,
      live: cachedMidDownload,
    });
    expect(rows.map((r) => r.row.progress)).toEqual([0.93]);
  });

  it('keeps reporting while a preparation is still on the step', () => {
    const rows = buildDownloadRows({
      resources,
      preparation: {
        resources: [{ resource: 'urn:air:sdxl:checkpoint:civitai:1@7', lane: 'low' }],
      },
      preparing: false,
      live: cachedMidDownload,
    });
    expect(rows.map((r) => r.row.progress)).toEqual([0.93]);
  });

  // The poll keeps its last "93%" after it is disabled; building rows from it froze the row there.
  it('reports nothing once the workflow has stopped waiting, whatever the poll last said', () => {
    const rows = buildDownloadRows({
      resources,
      preparation: undefined,
      preparing: false,
      live: cachedMidDownload,
    });
    expect(rows).toEqual([]);
  });
});

describe('downloadPollIds', () => {
  const air = (version: number) => `urn:air:sdxl:checkpoint:civitai:1@${version}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('polls only what the preparation says the workflow is waiting on', () => {
    expect(
      downloadPollIds([1, 2, 3, 4], { resources: [{ resource: air(3) }, { resource: air(4) }] })
    ).toEqual([3, 4]);
  });

  it('polls every resource before the orchestrator has said which', () => {
    expect(downloadPollIds([1, 2, 3], undefined)).toEqual([1, 2, 3]);
  });

  // Over the cap the request 400s, so the card loses every row rather than the extras.
  it.each([
    ['every resource', many(14), undefined],
    ['the preparation', [], { resources: many(14).map((v) => ({ resource: air(v) })) }],
  ])('never asks for more than the status endpoint accepts, from %s', (_, ids, preparation) => {
    expect(downloadPollIds(ids, preparation)).toHaveLength(DOWNLOAD_STATUS_MAX_IDS);
  });
});
