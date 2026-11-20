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
const queueSearch = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: queueSearch }));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { getTextScanCsamMode } = await import('~/server/services/text-scan/mode');
const { SONG_LYRICS_HOLD } = await import('~/server/common/image-visibility');
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

describe('a csam detection in the lyrics of a song whose audio is clean, with csam scanning on', () => {
  type Hold = { entityType: string; entityId: number; label: string; status: string };
  let holds: Hold[];

  beforeEach(() => {
    holds = [];
    vi.mocked(getTextScanCsamMode).mockResolvedValue('review');
    const w = dbMock.dbWrite;
    // The hold table as the real withCsamHold writes and the adapter reads it.
    w.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      if (!strings.join('?').includes('INSERT INTO "TextScanHold"')) return [];
      holds.push({ entityType: 'TrackLyrics', entityId: SONG, label: 'csam', status: 'Pending' });
      return [{ id: holds.length }];
    }) as never);
    w.textScanHold.findFirst.mockImplementation((async ({ where }: { where: Partial<Hold> }) => {
      const found = holds.find((h) =>
        Object.entries(where).every(([key, value]) => h[key as keyof Hold] === value)
      );
      return found ? { id: holds.indexOf(found) + 1 } : null;
    }) as never);
    const csamParsed = { ...parsed, csam: { detected: true, reason: 'r' } };
    vi.mocked(getWorkflow).mockResolvedValue({
      data: {
        metadata: {
          ...metadata,
          labels: ['nsfw', 'csam'],
          promptIds: { base: 1, nsfw: 2, csam: 3 },
        },
        tags: ['text-scan', 'TrackLyrics', 'active'],
        steps: [
          {
            $type: 'chatCompletion',
            output: {
              choices: [{ message: { content: JSON.stringify(csamParsed) }, finishReason: 'stop' }],
              parsed: csamParsed,
            },
          },
        ],
      },
    } as never);
  });

  it('holds the lyrics for a moderator, takes the song out of search, and still decides it at PG', async () => {
    await handleTextScanCallback({ workflowId: 'wf-lyrics', status: 'succeeded' });

    expect(holds).toEqual([expect.objectContaining({ ...SONG_LYRICS_HOLD, entityId: SONG })]);
    expect(queueSearch).toHaveBeenCalledWith({ ids: [SONG], action: 'Delete' });
    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-audio', fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });
});
