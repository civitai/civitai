import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type * as TextScanPrompt from '~/server/services/text-scan/prompt';

const { mockPreview, mockActivePrompts } = vi.hoisted(() => ({
  mockPreview: vi.fn(),
  mockActivePrompts: vi.fn(),
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreview,
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPrompt>()),
  getActiveTextScanPrompts: mockActivePrompts,
}));

const { assertComFaceAllowed, resolveComFaceIntent } = await import(
  '~/server/services/model-sfw-face.service'
);
const { comFaceIntentTextHash } = await import('~/server/services/model-com-face-intent.service');

const MODEL_ID = 41;
const OWNER_ID = 7;
const PROMPT_A = 111;
const PROMPT_B = 112;
const listing = { name: 'Retro Style', description: '<p>A style</p>', triggerWords: ['retro'] };
const textHash = comFaceIntentTextHash(listing);

function storeModel(comFaceIntent: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  dbMock.dbWrite.model.findUnique.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    name: listing.name,
    description: listing.description,
    nsfw: true,
    minor: false,
    poi: false,
    sfwOnly: false,
    lockedProperties: [],
    meta: { comFaceIntent: { textHash, at: '2026-11-01T00:00:00.000Z', ...comFaceIntent } },
    ...extra,
  });
}

const activeIntentPrompt = (id: number) =>
  mockActivePrompts.mockResolvedValue({
    'label:model-com-face-intent': { id, key: 'label:model-com-face-intent', content: 'x' },
  });

const writes = { record: vi.fn(), lock: vi.fn(async () => true), suppress: vi.fn() };
const resolve = () =>
  resolveComFaceIntent({ modelId: MODEL_ID, userId: OWNER_ID, ...listing }, writes);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modActivity.findFirst.mockResolvedValue(null);
  mockPreview.mockResolvedValue({
    status: 'ok',
    output: { detected: true, reason: 'fresh' },
    promptId: PROMPT_B,
  });
});

describe('a stored intent verdict under another prompt version', () => {
  it('re-runs an unruled verdict stored under prompt A once prompt B is active', async () => {
    storeModel({ detected: false, promptId: PROMPT_A });
    activeIntentPrompt(PROMPT_B);
    const verdict = await resolve();
    expect(mockPreview).toHaveBeenCalledTimes(1);
    expect(verdict.status).toBe('detected');
    expect(writes.record).toHaveBeenCalledWith(
      MODEL_ID,
      expect.objectContaining({ detected: true, promptId: PROMPT_B, textHash })
    );
  });

  it('keeps an overturned verdict from prompt A standing under B: no refusal, no re-lock', async () => {
    storeModel(
      { detected: true, promptId: PROMPT_A, overturnedAt: '2026-11-02T00:00:00.000Z' },
      { lockedProperties: [] }
    );
    activeIntentPrompt(PROMPT_B);
    const verdict = await resolve();
    expect(verdict.status).toBe('allowed');
    expect(mockPreview).not.toHaveBeenCalled();
    expect(writes.lock).not.toHaveBeenCalled();
    expect(writes.record).not.toHaveBeenCalled();
  });

  it('reuses a verdict stored under the active prompt (control)', async () => {
    storeModel({ detected: false, promptId: PROMPT_B });
    activeIntentPrompt(PROMPT_B);
    expect((await resolve()).status).toBe('allowed');
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('re-runs a verdict that carries no prompt id', async () => {
    storeModel({ detected: false });
    activeIntentPrompt(PROMPT_B);
    await resolve();
    expect(mockPreview).toHaveBeenCalledTimes(1);
  });

  it('re-runs rather than reuse when the active prompt cannot be read', async () => {
    storeModel({ detected: false });
    mockActivePrompts.mockRejectedValue(new Error('db down'));
    await resolve();
    expect(mockPreview).toHaveBeenCalledTimes(1);
  });
});

describe('an allowed verdict', () => {
  it('writes a log line carrying its promptId', async () => {
    storeModel({ detected: false, promptId: PROMPT_A });
    activeIntentPrompt(PROMPT_B);
    mockPreview.mockResolvedValue({
      status: 'ok',
      output: { detected: false, reason: 'fine' },
      promptId: PROMPT_B,
    });
    await resolve();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'model-com-face-intent',
        message: 'allowed',
        payload: { promptId: PROMPT_B },
      })
    );
  });
});

describe('a lock added for a detection', () => {
  const lockLine = () =>
    loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line.message === 'locked');

  it('writes one log line with its promptId and nothing else about the model', async () => {
    storeModel({ detected: false, promptId: PROMPT_A });
    activeIntentPrompt(PROMPT_B);
    await resolve();
    expect(writes.lock).toHaveBeenCalledTimes(1);
    expect(lockLine()).toEqual([
      {
        type: 'info',
        name: 'model-com-face-intent',
        message: 'locked',
        payload: { promptId: PROMPT_B },
      },
    ]);
  });

  it('writes none when the lock was not added', async () => {
    storeModel({ detected: false, promptId: PROMPT_A });
    activeIntentPrompt(PROMPT_B);
    writes.lock.mockResolvedValueOnce(false);
    await resolve();
    expect(lockLine()).toEqual([]);
  });
});

describe('a refusal at save', () => {
  it('writes one log line with its promptId and nothing else about the model', async () => {
    await expect(assertComFaceAllowed({ ...listing })).rejects.toThrow();
    const lines = loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line.message === 'refused at save');
    expect(lines).toEqual([
      {
        type: 'info',
        name: 'model-com-face-intent',
        message: 'refused at save',
        payload: { promptId: PROMPT_B },
      },
    ]);
  });
});

describe('a stored detection reused under the active prompt', () => {
  const linesFor = (message: string) =>
    loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as Record<string, unknown>)
      .filter((line) => line.message === message);

  it("logs the lock it adds with the stored verdict's promptId", async () => {
    storeModel({ detected: true, promptId: PROMPT_B });
    activeIntentPrompt(PROMPT_B);
    await resolve();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(writes.lock).toHaveBeenCalledTimes(1);
    expect(linesFor('locked')).toEqual([
      expect.objectContaining({ payload: { promptId: PROMPT_B } }),
    ]);
  });

  it("logs a refusal of an intent-locked model with the stored verdict's promptId", async () => {
    const comFaceIntent = { textHash, at: '2026-11-01T00:00:00.000Z', detected: true };
    storeModel(
      {},
      {
        lockedProperties: ['nsfw'],
        meta: {
          comFaceIntent: { ...comFaceIntent, promptId: PROMPT_B },
          systemNsfwLock: { source: 'com-face-intent' },
        },
      }
    );
    activeIntentPrompt(PROMPT_B);
    await expect(
      assertComFaceAllowed({ modelId: MODEL_ID, userId: OWNER_ID, ...listing })
    ).rejects.toThrow();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(linesFor('refused at save')).toEqual([
      expect.objectContaining({ payload: { promptId: PROMPT_B } }),
    ]);
  });
});
