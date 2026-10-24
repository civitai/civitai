import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';

const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { insert: mockInsert },
}));

import { recordImageScanningResult } from '~/server/services/scanner-audit.service';

const detection = (ageBand: string, under18Probability: number, isMinor: boolean) =>
  ({ ageBand, under18Probability, isMinor } as never);

const scan = {
  nsfwLevel: 'r' as const,
  tags: {},
  csam: false,
  // The highest under-18 probability is not the first detection.
  ageDetections: [detection('21-24', 0.1, false), detection('16-17', 0.7, true)],
  minorDetected: true,
  aiRecognition: { label: 'AI', score: 0.9 },
  animeRecognition: { label: 'Real', score: 0.6 },
};

type Row = Record<string, unknown>;
const insertedRows = () => mockInsert.mock.calls[0][0].values as Row[];
const row = (label: string) => insertedRows().find((r) => r.label === label);

describe('recordImageScanningResult', () => {
  beforeEach(() => mockInsert.mockReset().mockResolvedValue(undefined));

  it('writes version 2 rows for the rating, csam, the joint age model and both recognizers', async () => {
    await recordImageScanningResult({ workflowId: 'wf', imageId: 1, scan });

    const rows = insertedRows();
    expect(rows.map((r) => [r.label, r.labelValue, r.score, r.triggered])).toEqual([
      ['r', 'nsfw_level', 1, 1],
      ['csam', '', 0, 0],
      ['minor', '21-24, 16-17', 0.7, 1],
      ['ai', 'ai_recognition', 0.9, 1],
      ['real', 'anime_recognition', 0.6, 1],
    ]);
    expect(rows.every((r) => r.version === '2' && r.modelVersion === '2')).toBe(true);
    expect(rows.every((r) => r.scanner === 'image_ingestion')).toBe(true);
  });

  it('records a positive csam result as triggered', async () => {
    await recordImageScanningResult({
      workflowId: 'wf',
      imageId: 1,
      scan: { ...scan, csam: true },
    });
    expect(row('csam')).toMatchObject({ score: 1, triggered: 1 });
  });

  it('writes no csam row when the scanner did not report one', async () => {
    await recordImageScanningResult({
      workflowId: 'wf',
      imageId: 1,
      scan: { ...scan, csam: null },
    });
    expect(row('csam')).toBeUndefined();
  });

  it('does not trigger the minor row when only adults were detected', async () => {
    await recordImageScanningResult({
      workflowId: 'wf',
      imageId: 1,
      scan: {
        ...scan,
        ageDetections: [detection('21-24', 0.1, false), detection('25+', 0.2, false)],
        minorDetected: false,
      },
    });
    expect(row('minor')).toMatchObject({ labelValue: '21-24, 25+', score: 0.2, triggered: 0 });
  });

  it('writes no minor row when nobody was detected', async () => {
    await recordImageScanningResult({
      workflowId: 'wf',
      imageId: 1,
      scan: { ...scan, ageDetections: [], minorDetected: false },
    });
    expect(row('minor')).toBeUndefined();
  });
});
