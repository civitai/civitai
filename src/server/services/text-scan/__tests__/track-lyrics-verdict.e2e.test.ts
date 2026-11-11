import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * A text-scan lyrics verdict, from its callback through the real adapter to the song decision: the
 * callback stores the verdict before the adapter runs, so the decision reads it and the song is
 * decided at once.
 */

const pipeline = vi.hoisted(() => ({
  loadImageForScan: vi.fn(),
  resolveScanOutcome: vi.fn(),
  applyIngestionSideEffects: vi.fn(),
  markImageScanError: vi.fn(),
  sendIngestionSignal: vi.fn(),
}));
vi.mock('~/server/services/image-scan-pipeline', () => ({
  ...pipeline,
  extractFailedSteps: () => [],
}));
vi.mock('~/server/services/job-queue.service', () => ({ removeImageScanJobQueue: vi.fn() }));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { getWorkflow } = await import('@civitai/orchestration-client');
await import('~/server/services/text-scan/profiles/index');

const SONG = 7;
const MARKER = `ts-TrackLyrics-${SONG}-abc-0-0`;
const metadata = {
  entityType: 'TrackLyrics',
  entityId: SONG,
  emEntityType: 'TrackLyrics',
  mode: 'active',
  externalId: MARKER,
  labels: ['nsfw'],
  promptIds: { base: 1, nsfw: 2 },
  model: 'air:test',
  thinking: false,
};
const parsed = { nsfw: { level: 'none', reason: 'Clean.' } };

beforeEach(() => {
  vi.clearAllMocks();
  const w = dbMock.dbWrite;
  // The moderation row as the callback leaves it, read back by the song decision.
  let row: { status: string; blocked: boolean | null } = { status: 'Pending', blocked: null };
  w.entityModeration.updateMany.mockImplementation((async ({ data }: { data: typeof row }) => {
    row = { ...row, ...data };
    return { count: 1 };
  }) as never);
  w.entityModeration.findUnique.mockImplementation((async () => row) as never);
  w.trackLyrics.findMany.mockResolvedValue([
    { imageId: SONG, text: 'la la', image: { userId: 3 } },
  ] as never);
  w.trackLyrics.findUnique.mockResolvedValue({ text: 'la la' } as never);
  w.imageAudioScan.findUnique.mockResolvedValue({
    status: 'Succeeded',
    workflowId: 'wf-audio',
    flagged: false,
    hasAudio: true,
    result: {},
  } as never);
  pipeline.loadImageForScan.mockResolvedValue({ id: SONG, userId: 3, ingestion: 'Pending' });
  pipeline.resolveScanOutcome.mockResolvedValue({ ingestion: 'Scanned', blockedFor: null });
  vi.mocked(getWorkflow).mockResolvedValue({
    data: {
      metadata,
      tags: ['text-scan', 'TrackLyrics', 'active'],
      steps: [
        {
          $type: 'chatCompletion',
          output: {
            choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
            parsed,
          },
        },
      ],
    },
  } as never);
});

describe('a clean text-scan lyrics verdict for a song whose audio is clean', () => {
  it('publishes the song at PG as soon as it lands', async () => {
    await handleTextScanCallback({ workflowId: 'wf-lyrics', status: 'succeeded' });

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-audio', fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });
});
