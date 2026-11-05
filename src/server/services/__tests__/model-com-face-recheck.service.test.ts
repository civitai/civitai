import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Queues from '~/server/redis/queues';
import type * as NsfwLevels from '~/server/services/nsfwLevels.service';
import type * as ModelVersionService from '~/server/services/model-version.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';

const {
  mockAddToQueue,
  mockCheckoutQueue,
  mockPreviewComFaceIntent,
  mockUpdateModelNsfwLevels,
  mockBust,
} = vi.hoisted(() => ({
  mockAddToQueue: vi.fn(),
  mockCheckoutQueue: vi.fn(),
  mockPreviewComFaceIntent: vi.fn(),
  mockUpdateModelNsfwLevels: vi.fn(),
  mockBust: vi.fn(),
}));

vi.mock('~/server/redis/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof Queues>()),
  addToQueue: mockAddToQueue,
  checkoutQueue: mockCheckoutQueue,
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mockPreviewComFaceIntent,
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NsfwLevels>()),
  updateModelNsfwLevels: mockUpdateModelNsfwLevels,
}));
vi.mock('~/server/services/model-version.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionService>()),
  bustPublicModelResponseCache: mockBust,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  COM_FACE_RECHECK_GAVE_UP,
  COM_FACE_RECHECK_MAX_ATTEMPTS,
  processComFaceRechecks,
} from '~/server/services/model-com-face-recheck.service';

const db = dbMock.dbWrite;
const MODEL_ID = 42;
const COVER_ID = 5;
const intent = (detected: boolean) => ({ status: 'ok', output: { detected, reason: 'stub' } });

const withFace = {
  id: MODEL_ID,
  userId: 101,
  name: 'Listing Title',
  description: '<p>Listing description</p>',
  sfwName: 'Retro Style',
  sfwCoverImageId: COVER_ID,
  deletedAt: null,
};

/** Fills the attempt queues: key → model ids. Every other queue is empty. */
const commits: ReturnType<typeof vi.fn>[] = [];
function queued(queues: Record<string, number[]>) {
  commits.length = 0;
  mockCheckoutQueue.mockImplementation(async (key: string) => {
    const commit = vi.fn();
    commits.push(commit);
    return { content: queues[key] ?? [], commit };
  });
}

const coverCleared = () =>
  db.$executeRaw.mock.calls.some((call) =>
    (call[0] as unknown as string[]).join('?').includes('"sfwCoverImageId" = NULL')
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.model.findUnique.mockResolvedValue(withFace as never);
  db.modelVersion.findMany.mockResolvedValue([{ trainedWords: ['trigger'] }] as never);
  db.$executeRaw.mockResolvedValue(1 as never);
  db.modActivity.create.mockResolvedValue({} as never);
});

describe('the .com face listing re-check', () => {
  it('takes a flagged model off .com, keeping its .com text and the cleared cover id', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));

    const counts = await processComFaceRechecks();

    expect(counts.removed).toBe(1);
    expect(coverCleared()).toBe(true);
    const sql = (db.$executeRaw.mock.calls[0][0] as unknown as string[]).join('?');
    expect(sql).not.toMatch(/"sfwName"\s*=|"sfwDescription"\s*=/);
    const markerArg = db.$executeRaw.mock.calls[0]
      .slice(1)
      .find((value) => typeof value === 'string' && value.includes('sfwCoverImageId'));
    const marker = JSON.parse(String(markerArg));
    expect(marker.sfwCoverImageId).toBe(COVER_ID);
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ activity: 'removeComFace', entityId: MODEL_ID }),
    });
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
  });

  it('checks the current listing: title, description text and trigger words', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    await processComFaceRechecks();

    const text = (
      mockPreviewComFaceIntent.mock.calls[0][0] as { fields: { text: string }[] }
    ).fields
      .map((field) => field.text)
      .join(' ');
    expect(text).toContain('Listing Title');
    expect(text).toContain('Listing description');
    expect(text).toContain('trigger');
  });

  it('leaves a model the check passes on .com', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    const counts = await processComFaceRechecks();

    expect(counts.allowed).toBe(1);
    expect(coverCleared()).toBe(false);
    expect(db.modActivity.create).not.toHaveBeenCalled();
    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('skips a model already off .com without running the check', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    db.model.findUnique.mockResolvedValue({ ...withFace, sfwCoverImageId: null } as never);

    await processComFaceRechecks();

    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(coverCleared()).toBe(false);
  });

  it.each([
    [
      'gives no verdict',
      () => mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' }),
    ],
    ['throws', () => mockPreviewComFaceIntent.mockRejectedValue(new Error('down'))],
  ])('keeps the face and requeues when the check %s', async (_, arrange) => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    arrange();

    await processComFaceRechecks();

    expect(coverCleared()).toBe(false);
    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck:retry1', [MODEL_ID]);
  });

  it(`stops after ${COM_FACE_RECHECK_MAX_ATTEMPTS} unavailable attempts and logs the model`, async () => {
    const last = COM_FACE_RECHECK_MAX_ATTEMPTS - 1;
    queued({ [`com-face-recheck:retry${last}`]: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await processComFaceRechecks();

    expect(counts.gaveUp).toBe(1);
    expect(mockAddToQueue).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: COM_FACE_RECHECK_GAVE_UP, modelId: MODEL_ID })
    );
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ activity: 'comFaceRecheckGaveUp', entityId: MODEL_ID }),
    });
  });

  it('starts the count again for a model edited again since it last failed', async () => {
    const last = COM_FACE_RECHECK_MAX_ATTEMPTS - 1;
    queued({ 'com-face-recheck': [MODEL_ID], [`com-face-recheck:retry${last}`]: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await processComFaceRechecks();

    expect(mockPreviewComFaceIntent).toHaveBeenCalledTimes(1);
    expect(counts.gaveUp).toBe(0);
    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck:retry1', [MODEL_ID]);
  });

  it('ends the retries once a later attempt gets a verdict', async () => {
    queued({ 'com-face-recheck:retry2': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    await processComFaceRechecks();

    expect(mockAddToQueue).not.toHaveBeenCalled();
  });

  it('writes nothing more when the cover changed after the read', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    db.$executeRaw.mockResolvedValue(0 as never);

    const counts = await processComFaceRechecks();

    const sql = (db.$executeRaw.mock.calls[0][0] as unknown as string[]).join('?');
    expect(sql).toMatch(/AND "sfwCoverImageId" = \?/);
    expect(counts.skipped).toBe(1);
    expect(db.modActivity.create).not.toHaveBeenCalled();
    expect(mockUpdateModelNsfwLevels).not.toHaveBeenCalled();
  });

  it('finishes a removal whose level recompute failed, on the retry', async () => {
    queued({ 'com-face-recheck:retry1': [MODEL_ID] });
    db.model.findUnique.mockResolvedValue({
      ...withFace,
      sfwCoverImageId: null,
      meta: { comFaceRemoved: { at: '2026-11-05T00:00:00.000Z', sfwCoverImageId: COVER_ID } },
    } as never);

    await processComFaceRechecks();

    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
  });

  it('writes retries before retiring any queue it read', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    await processComFaceRechecks();

    expect(commits).toHaveLength(COM_FACE_RECHECK_MAX_ATTEMPTS);
    const requeuedAt = mockAddToQueue.mock.invocationCallOrder[0];
    for (const commit of commits) {
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(requeuedAt);
    }
  });

  it('clears the cover and records the removal in one transaction', async () => {
    queued({ 'com-face-recheck': [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    const tx = { $executeRaw: vi.fn(async () => 1), modActivity: { create: vi.fn() } };
    db.$transaction.mockImplementationOnce((async (fn: (client: typeof tx) => unknown) =>
      fn(tx)) as never);

    await processComFaceRechecks();

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.modActivity.create).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });
});
