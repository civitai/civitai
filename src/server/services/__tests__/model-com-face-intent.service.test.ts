import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IntentService from '~/server/services/model-com-face-intent.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';

const { mockPreviewComFaceIntent, mockRead, mockRecord, mockLock, mockSuppress } = vi.hoisted(
  () => ({
    mockPreviewComFaceIntent: vi.fn(),
    mockRead: vi.fn(),
    mockRecord: vi.fn(),
    mockLock: vi.fn(),
    mockSuppress: vi.fn(),
  })
);

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
  suppressComFaceIntentRelock: mockSuppress,
}));

import { comFaceIntentTextHash } from '~/server/services/model-com-face-intent.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  assertComFaceAllowed,
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_EDIT_MESSAGE,
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

  it('refuses again on a stored detection for unchanged text without re-judging, and locks a model since marked mature', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: true, textHash: hash, at: '2026-01-01T00:00:00Z' } })
    );
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_MESSAGE
    );
    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(mockLock).toHaveBeenCalledWith(7, hash);
  });

  it('does not re-apply a stored detection a moderator has ruled past, and offers no dispute', async () => {
    mockRead.mockResolvedValue(
      model({ comFaceIntent: { detected: true, textHash: hash, at: '2026-01-01T00:00:00Z' } })
    );
    dbMock.dbWrite.modActivity.findFirst.mockResolvedValueOnce({ id: 1 } as never);
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_EDIT_MESSAGE
    );
    expect(mockLock).not.toHaveBeenCalled();
  });

  it('offers no dispute on a model that is not mature, which is refused but not locked', async () => {
    mockRead.mockResolvedValue({ ...model(), nsfw: false });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_EDIT_MESSAGE
    );
    expect(mockLock).not.toHaveBeenCalled();
  });

  it("offers the dispute when the lock is already the intent check's", async () => {
    mockRead.mockResolvedValue({
      ...model({
        comFaceIntent: { detected: true, textHash: hash, at: 'x' },
        systemNsfwLock: { source: 'com-face-intent', at: 'x' },
      }),
      lockedProperties: ['nsfw'],
    });
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_MESSAGE
    );
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

  // Decision: a fresh verdict on edited text is not locked over a moderator's nsfw ruling made since
  // the previous stored verdict (of any text). With no previous verdict there is nothing to count
  // back to, so it locks as before. The face is refused either way.
  it.each([
    ['a ruling since the previous verdict: refused, not locked', true, true, false],
    ['a ruling older than the previous verdict: refused and locked', true, false, true],
    ['no previous verdict: refused and locked, no ruling read', false, false, true],
  ] as const)('re-judged edited text with %s', async (_, previous, ruledSince, locks) => {
    mockRead.mockResolvedValue(
      model(
        previous
          ? { comFaceIntent: { detected: false, textHash: 'old', at: '2026-01-01T00:00:00Z' } }
          : {}
      )
    );
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    const findRuling = dbMock.dbWrite.modActivity.findFirst;
    if (ruledSince) findRuling.mockResolvedValueOnce({ id: 1 } as never);
    await expect(assertComFaceAllowed({ ...stored, modelId: 7, userId: 1 })).rejects.toThrow(
      locks ? COM_FACE_REFUSED_MESSAGE : COM_FACE_REFUSED_EDIT_MESSAGE
    );
    expect(mockRecord).toHaveBeenCalledWith(7, expect.objectContaining({ detected: true }));
    if (locks) expect(mockLock).toHaveBeenCalledWith(7, hash);
    else expect(mockLock).not.toHaveBeenCalled();
    // The fresh verdict outdates the ruling, so without this the next save of this text would lock.
    if (locks) expect(mockSuppress).not.toHaveBeenCalled();
    else expect(mockSuppress).toHaveBeenCalledWith(7, hash);
    if (previous)
      expect(findRuling).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: { gt: new Date('2026-01-01T00:00:00Z') } }),
        })
      );
    else expect(findRuling).not.toHaveBeenCalled();
  });

  // The stored verdict is the stored listing's: a draft's would replace one a moderator ruled on.
  it('neither stores nor locks on a detection of an unsaved edit', async () => {
    mockRead.mockResolvedValue(model());
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(
      assertComFaceAllowed({ ...stored, name: 'New unsaved title', modelId: 7, userId: 1 })
    ).rejects.toThrow(COM_FACE_REFUSED_EDIT_MESSAGE);
    expect(mockRecord).not.toHaveBeenCalled();
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
      COM_FACE_REFUSED_EDIT_MESSAGE
    );
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockLock).not.toHaveBeenCalled();
  });
});
