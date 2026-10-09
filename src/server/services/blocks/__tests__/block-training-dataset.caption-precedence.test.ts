import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUploadModule from '~/server/services/orchestrator/imageUpload';

/**
 * Caption batches and the hard-over-soft rule.
 *
 * `prepareBlockTrainingDataset` audits captions in several batches (each under the audit's
 * length cap). Within ONE audit a hard term anywhere outranks a soft one (`isSoftBlock`); these
 * pin that the same holds ACROSS batches, so which refusal a request gets — and whether it goes
 * through the hard recording path — does not depend on where in the dataset each caption sits.
 *
 * The REAL `auditPromptServer` and `auditPromptEnriched` run here; only the external classifier
 * (not-flagged), the benign-phrase store, the image import and I/O are mocked. The hard recording
 * path is observed at its writer: `addBlockedPrompt` is the only `sysRedis.lPush` caller.
 */

const { mockImageUpload, mockModeratePrompt, mockProhibited, mockApplyPendingReviewMute } =
  vi.hoisted(() => ({
    mockImageUpload: vi.fn(),
    mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
    mockProhibited: vi.fn(),
    mockApplyPendingReviewMute: vi.fn(async () => undefined),
  }));

vi.mock('~/server/services/orchestrator/imageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadModule>()),
  imageUpload: (...a: unknown[]) => mockImageUpload(...a),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: vi.fn(async (text: string | undefined) => text),
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: mockApplyPendingReviewMute,
}));

import {
  packCaptionsForAudit,
  prepareBlockTrainingDataset,
} from '../block-training-dataset.service';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { BLOCK_TRAINING_DATASET_MAX_ITEMS } from '~/server/schema/blocks/workflow.schema';
import { BLOCK_TRAINING_CAPTION_MAX_CHARS } from '~/server/schema/blocks/training-dataset.schema';
import { auditPromptEnriched, isSoftBlock } from '~/utils/metadata/audit';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const SOFT = 'a photo of my daughter at the park';
const SOFT_2 = 'a dog peeing on a tree in the park';
const HARD = '13 year old, revealing outfit';

const FILLER = 'landscape photo of a mountain lake at sunrise, pine trees, mist, ';
const filler = () =>
  FILLER.repeat(Math.ceil(BLOCK_TRAINING_CAPTION_MAX_CHARS / FILLER.length)).slice(
    0,
    BLOCK_TRAINING_CAPTION_MAX_CHARS - 1
  ) + '.';

/** A full schema-maximum dataset of benign captions with the given overrides. */
function dataset(overrides: Record<number, string>) {
  const captions = Array.from({ length: BLOCK_TRAINING_DATASET_MAX_ITEMS }, filler);
  for (const [i, c] of Object.entries(overrides)) captions[Number(i)] = c;
  return captions;
}

/** Which batch (0-based) caption `index` lands in. */
function batchOf(captions: string[], index: number) {
  const batches = packCaptionsForAudit(captions);
  return batches.findIndex((b) => b.split('\n').includes(captions[index]));
}

const audited: string[] = [];
const auditCaptions = vi.fn(async (text: string) => {
  audited.push(text);
  await auditPromptServer({
    prompt: text,
    userId: 5,
    isGreen: false,
    isModerator: false,
    track: { prohibitedRequest: mockProhibited, userActivity: vi.fn(async () => undefined) },
  } as never);
});

async function prepare(captions: string[]) {
  dbMock.dbRead.$queryRaw.mockResolvedValue(
    captions.map((_, i) => ({
      id: i + 1,
      url: `k${i + 1}`,
      type: 'image',
      nsfwLevel: 1,
      ingestion: 'Scanned',
      needsReview: null,
      poi: false,
      minor: false,
      tosViolation: false,
      acceptableMinor: false,
      blockedFor: null,
    }))
  );
  return prepareBlockTrainingDataset({
    actor: {
      userId: 5,
      appBlockId: 'apb_1',
      blockInstanceId: 'page_apb_1',
      browsingLevel: 1 | 2,
      allowMatureContent: false,
    },
    items: captions.map((c, i) => ({ imageId: i + 1, caption: c })),
    token: 'tok',
    auditCaptions,
  });
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as Error & { cause?: { softBlock?: boolean } };
  }
  throw new Error('expected a refusal, got none');
}

/**
 * The blocked-prompt entries the hard path wrote (addBlockedPrompt → lPush). A cold counter
 * key is first seeded with a `__RESET__` marker, which is not an entry.
 */
const recordedEntries = () =>
  redisMock.sysRedis.lPush.mock.calls
    .map((c) => c[1] as string)
    .filter((v) => v !== '__RESET__')
    .map((v) => JSON.parse(v) as { prompt: string; category: string });

beforeEach(() => {
  vi.clearAllMocks();
  audited.length = 0;
  mockModeratePrompt.mockImplementation(async () => ({ flagged: false, categories: [] }));
  mockImageUpload.mockImplementation(async ({ sourceImage }: { sourceImage: string }) => ({
    blob: {
      id: 'b',
      available: true,
      url: `https://orch.example/v2/consumer/blobs/${sourceImage.split('/').at(-3)}.jpeg`,
    },
  }));
});

describe('fixtures are what they claim (or every case below proves nothing)', () => {
  it.each([
    ['SOFT', SOFT, true],
    ['SOFT_2', SOFT_2, true],
    ['HARD', HARD, false],
  ])('%s is refused, soft=%s', (_l, text, soft) => {
    const r = auditPromptEnriched(text, undefined, false);
    expect(r.success).toBe(false);
    expect(isSoftBlock(r.triggers)).toBe(soft);
  });

  it('a 50 × 1000 dataset packs into 3 batches; index 0 is in the first, 48 in the last', () => {
    const c = dataset({ 0: SOFT, 48: HARD });
    expect(packCaptionsForAudit(c)).toHaveLength(3);
    expect(batchOf(c, 0)).toBe(0);
    expect(batchOf(c, 48)).toBe(2);
  });
});

describe('prepareBlockTrainingDataset — a hard refusal in any batch wins over a soft one', () => {
  it('soft in batch 1 + hard in batch 3 → the HARD refusal, through the hard recording path', async () => {
    const err = await refusalOf(prepare(dataset({ 0: SOFT, 48: HARD })));

    expect(err.cause?.softBlock).toBeUndefined();
    expect(auditCaptions).toHaveBeenCalledTimes(3);
    // Recorded exactly as a single-batch hard refusal is: one blocked-prompt entry, for the
    // batch holding the hard caption, counted toward the auto-mute.
    const entries = recordedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].prompt).toContain(HARD);
    expect(entries[0].prompt).not.toContain(SOFT);
    expect(mockImageUpload).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('control: soft and hard in ONE batch → hard, the single-audit rule', async () => {
    const err = await refusalOf(prepare([SOFT, HARD]));
    expect(err.cause?.softBlock).toBeUndefined();
    expect(auditCaptions).toHaveBeenCalledTimes(1);
    expect(recordedEntries()).toHaveLength(1);
  });

  it('soft-only across batches → the FIRST soft refusal, after every batch is audited', async () => {
    const captions = dataset({ 0: SOFT, 48: SOFT_2 });
    const batches = packCaptionsForAudit(captions);
    const err = await refusalOf(prepare(captions));

    expect(err.cause?.softBlock).toBe(true);
    expect(err.message).toContain('daughter');
    expect(err.message).not.toMatch(/pee/);
    expect(audited).toEqual(batches);
    // A soft refusal never writes the counter.
    expect(redisMock.sysRedis.lPush).not.toHaveBeenCalled();
    expect(mockImageUpload).not.toHaveBeenCalled();
  });

  it('hard in batch 1 → stops at once; later batches are never audited', async () => {
    const err = await refusalOf(prepare(dataset({ 0: HARD, 48: SOFT })));
    expect(err.cause?.softBlock).toBeUndefined();
    expect(auditCaptions).toHaveBeenCalledTimes(1);
    expect(recordedEntries()).toHaveLength(1);
    expect(mockImageUpload).not.toHaveBeenCalled();
  });

  it('a clean dataset is not refused, and every batch is audited', async () => {
    const captions = dataset({});
    const out = await prepare(captions);
    expect(out.count).toBe(BLOCK_TRAINING_DATASET_MAX_ITEMS);
    expect(audited).toEqual(packCaptionsForAudit(captions));
    expect(redisMock.sysRedis.lPush).not.toHaveBeenCalled();
  });

  it('a non-moderation failure in a batch is not held as soft — it propagates at once', async () => {
    auditCaptions.mockImplementationOnce(async (text: string) => {
      audited.push(text);
      throw new Error('classifier infrastructure down');
    });
    await expect(prepare(dataset({}))).rejects.toThrow('classifier infrastructure down');
    expect(audited).toHaveLength(1);
  });
});
