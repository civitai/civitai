import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IntentService from '~/server/services/model-com-face-intent.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';

const { mockPreviewComFaceIntent, mockRead, mockRecord, mockLock } = vi.hoisted(() => ({
  mockPreviewComFaceIntent: vi.fn(),
  mockRead: vi.fn(),
  mockRecord: vi.fn(),
  mockLock: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreviewComFaceIntent,
}));
// The row reads and writes are faked; the hash and reuse rules are the real ones.
vi.mock('~/server/services/model-com-face-intent.service', async (importOriginal) => ({
  ...(await importOriginal<typeof IntentService>()),
  readComFaceIntentModel: mockRead,
  recordComFaceIntent: mockRecord,
  lockForComFaceIntent: mockLock,
}));

import { comFaceIntentTextHash } from '~/server/services/model-com-face-intent.service';
import {
  assertComFaceAllowed,
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_MESSAGE,
} from '~/server/services/model-sfw-face.service';

const stored = { name: 'Red Title', description: '<p>Red text</p>', triggerWords: ['tw'] };
const model = (meta: unknown = {}) => ({
  id: 7,
  userId: 1,
  name: stored.name,
  description: stored.description,
  nsfw: true,
  minor: false,
  poi: false,
  sfwOnly: false,
  lockedProperties: [],
  meta,
});
const intent = (detected: boolean) => ({
  status: 'ok',
  output: { detected, reason: 'stub' },
  promptId: 42,
});
const hash = comFaceIntentTextHash(stored);

describe('assertComFaceAllowed, with a stored verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecord.mockResolvedValue(undefined);
    mockLock.mockResolvedValue(true);
  });

  it('reuses an allowed verdict for unchanged text without asking the classifier', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: false, textHash: hash, at: 'x' } })
    );
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).resolves.toBe(
      undefined
    );
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
  });

  it('refuses again on a stored detection for unchanged text, without re-judging or re-locking', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: true, textHash: hash, at: 'x' } })
    );
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_MESSAGE
    );
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('lets an overturned detection through for the text it was ruled on', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: true, textHash: hash, at: 'x', overturnedAt: 'y' } })
    );
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).resolves.toBe(
      undefined
    );
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
  });

  it('re-judges edited text, stores the verdict, and locks on a detection of the stored listing', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: false, textHash: 'old', at: 'x' } })
    );
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_MESSAGE
    );
    expect(mockRecord).toHaveBeenCalledWith(7, {
      detected: true,
      textHash: hash,
      reason: 'stub',
      promptId: 42,
    });
    expect(mockLock).toHaveBeenCalledWith(7, hash);
  });

  it('stores but never locks on a detection of an unsaved edit', async () => {
    mockRead.mockResolvedValue(model());
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(
      assertComFaceAllowed({ ...stored, name: 'New unsaved title', modelId: 7, userId: 1 })
    ).rejects.toThrow(COM_FACE_REFUSED_MESSAGE);
    expect(mockRecord).toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('stores nothing when the check gives no verdict, and refuses as unavailable', async () => {
    mockRead.mockResolvedValue(model());
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_CHECK_UNAVAILABLE_MESSAGE
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("neither reuses nor writes a verdict on someone else's model", async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: false, textHash: hash, at: 'x' } })
    );
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 2 })).rejects.toThrow(
      COM_FACE_REFUSED_MESSAGE
    );
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });
});
