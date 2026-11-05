import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  COM_FACE_RECHECK_FIRST_DELAY_MS,
  COM_FACE_RECHECK_GAVE_UP,
  COM_FACE_RECHECK_MAX_DELAY_MS,
  COM_FACE_RECHECK_WINDOW_MS,
  processComFaceRechecks,
  queueComFaceRecheck,
} from '~/server/services/model-com-face-recheck.service';

const db = dbMock.dbWrite;
const MODEL_ID = 42;
const COVER_ID = 5;
const KEY = `com-face-recheck:${MODEL_ID}`;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
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

const commit = vi.fn();
/** Fresh edits in the queue, and models already waiting on a retry. */
function arrange({
  fresh = [],
  waiting = [],
}: {
  fresh?: number[];
  waiting?: Record<string, unknown>[];
}) {
  mockCheckoutQueue.mockResolvedValue({ content: fresh, commit });
  db.keyValue.findMany.mockResolvedValue(waiting.map((value) => ({ key: KEY, value })) as never);
}

const coverCleared = () =>
  db.$executeRaw.mock.calls.some(
    (call) =>
      Array.isArray(call[0]) &&
      (call[0] as unknown as string[]).join('?').includes('"sfwCoverImageId" = NULL')
  );
const marker = () => {
  const arg = db.$executeRaw.mock.calls[0]
    .slice(1)
    .find((value) => typeof value === 'string' && value.includes('sfwCoverImageId'));
  return JSON.parse(String(arg));
};
const savedRetry = () =>
  (db.keyValue.upsert.mock.calls[0]?.[0] as { update: { value: Record<string, unknown> } })?.update
    .value;

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock: a run measures its own elapsed time when it schedules a retry.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.model.findUnique.mockResolvedValue(withFace as never);
  db.modelVersion.findMany.mockResolvedValue([{ trainedWords: ['trigger'] }] as never);
  db.$executeRaw.mockResolvedValue(1 as never);
  db.modActivity.create.mockResolvedValue({} as never);
  mockAddToQueue.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the .com face listing re-check', () => {
  it('takes a flagged model off .com, keeping its .com text and the cleared cover id', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));

    const counts = await processComFaceRechecks(NOW);

    expect(counts.removed).toBe(1);
    expect(coverCleared()).toBe(true);
    const sql = (db.$executeRaw.mock.calls[0][0] as unknown as string[]).join('?');
    expect(sql).not.toMatch(/"sfwName"\s*=|"sfwDescription"\s*=/);
    expect(marker()).toMatchObject({ sfwCoverImageId: COVER_ID, reason: 'detected' });
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ activity: 'removeComFace', entityId: MODEL_ID }),
    });
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(mockBust).toHaveBeenCalledWith(MODEL_ID);
  });

  it('checks the current listing: title, description text and trigger words', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    await processComFaceRechecks(NOW);

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
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    const counts = await processComFaceRechecks(NOW);

    expect(counts.allowed).toBe(1);
    expect(coverCleared()).toBe(false);
    expect(db.modActivity.create).not.toHaveBeenCalled();
    expect(db.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('skips a model already off .com without running the check', async () => {
    arrange({ fresh: [MODEL_ID] });
    db.model.findUnique.mockResolvedValue({ ...withFace, sfwCoverImageId: null } as never);

    await processComFaceRechecks(NOW);

    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(coverCleared()).toBe(false);
  });

  it.each([
    [
      'gives no verdict',
      () => mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' }),
    ],
    ['throws', () => mockPreviewComFaceIntent.mockRejectedValue(new Error('down'))],
  ])('keeps the face and schedules a retry when the check %s', async (_, failCheck) => {
    arrange({ fresh: [MODEL_ID] });
    failCheck();

    await processComFaceRechecks(NOW);

    expect(coverCleared()).toBe(false);
    expect(savedRetry()).toEqual({
      since: NOW.toISOString(),
      attempt: 1,
      nextAt: later(COM_FACE_RECHECK_FIRST_DELAY_MS),
    });
  });

  it('doubles the wait after each failure, up to the max', async () => {
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    arrange({ waiting: [{ since: ago(60_000), attempt: 1, nextAt: NOW.toISOString() }] });
    await processComFaceRechecks(NOW);
    expect(savedRetry()).toMatchObject({
      attempt: 2,
      nextAt: later(2 * COM_FACE_RECHECK_FIRST_DELAY_MS),
    });

    vi.clearAllMocks();
    db.model.findUnique.mockResolvedValue(withFace as never);
    arrange({ waiting: [{ since: ago(3_600_000), attempt: 20, nextAt: NOW.toISOString() }] });
    await processComFaceRechecks(NOW);
    expect(savedRetry()).toMatchObject({
      attempt: 21,
      nextAt: later(COM_FACE_RECHECK_MAX_DELAY_MS),
    });
  });

  it('does not run a retry before it is due', async () => {
    arrange({ waiting: [{ since: ago(60_000), attempt: 1, nextAt: later(1) }] });

    await processComFaceRechecks(NOW);

    expect(db.model.findUnique).not.toHaveBeenCalled();
    expect(db.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('keeps the face when a check inside the window finally gets a verdict', async () => {
    arrange({
      waiting: [
        { since: ago(COM_FACE_RECHECK_WINDOW_MS - 1), attempt: 9, nextAt: NOW.toISOString() },
      ],
    });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    const counts = await processComFaceRechecks(NOW);

    expect(counts.allowed).toBe(1);
    expect(coverCleared()).toBe(false);
    expect(db.keyValue.deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
    expect(db.keyValue.upsert).not.toHaveBeenCalled();
  });

  it('takes the face off .com as unverified once the window has passed without a verdict', async () => {
    arrange({
      waiting: [{ since: ago(COM_FACE_RECHECK_WINDOW_MS), attempt: 30, nextAt: NOW.toISOString() }],
    });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await processComFaceRechecks(NOW);

    expect(counts.gaveUp).toBe(1);
    expect(coverCleared()).toBe(true);
    expect(marker()).toMatchObject({ sfwCoverImageId: COVER_ID, reason: 'recheck-unverified' });
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ activity: 'comFaceRecheckGaveUp', entityId: MODEL_ID }),
    });
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(mockBust).toHaveBeenCalledWith(MODEL_ID);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: COM_FACE_RECHECK_GAVE_UP, modelId: MODEL_ID })
    );
    expect(db.keyValue.deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
    expect(db.keyValue.upsert).not.toHaveBeenCalled();
  });

  // Ruled: the deadline belongs to the oldest edit still without a verdict; a later edit never moves it.
  it('keeps the original deadline for a model edited again while waiting, resetting only the backoff', async () => {
    arrange({
      fresh: [MODEL_ID],
      waiting: [{ since: ago(60 * 60_000), attempt: 6, nextAt: later(30 * 60_000) }],
    });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await processComFaceRechecks(NOW);

    expect(mockPreviewComFaceIntent).toHaveBeenCalledTimes(1);
    expect(counts.gaveUp).toBe(0);
    expect(savedRetry()).toEqual({
      since: ago(60 * 60_000),
      attempt: 1,
      nextAt: later(COM_FACE_RECHECK_FIRST_DELAY_MS),
    });
  });

  it('takes the face off as unverified at the window from the first edit, however often it is edited', async () => {
    const start = NOW.getTime();
    const step = 4 * 60 * 60_000;
    let state: Record<string, unknown> | undefined;
    let gaveUpAt: number | undefined;
    for (let at = start; at <= start + COM_FACE_RECHECK_WINDOW_MS; at += step) {
      vi.clearAllMocks();
      vi.setSystemTime(at);
      db.model.findUnique.mockResolvedValue(withFace as never);
      db.$executeRaw.mockResolvedValue(1 as never);
      db.modActivity.create.mockResolvedValue({} as never);
      mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
      arrange({ fresh: [MODEL_ID], waiting: state ? [state] : [] });

      const counts = await processComFaceRechecks(new Date(at));

      if (counts.gaveUp) {
        gaveUpAt = at;
        break;
      }
      state = savedRetry();
    }

    expect(gaveUpAt).toBe(start + COM_FACE_RECHECK_WINDOW_MS);
    expect(coverCleared()).toBe(true);
    expect(marker()).toMatchObject({ reason: 'recheck-unverified' });
  });

  it('writes nothing more when the cover changed after the read', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    db.$executeRaw.mockResolvedValue(0 as never);

    const counts = await processComFaceRechecks(NOW);

    const sql = (db.$executeRaw.mock.calls[0][0] as unknown as string[]).join('?');
    expect(sql).toMatch(/AND "sfwCoverImageId" = \?/);
    expect(counts.skipped).toBe(1);
    expect(db.modActivity.create).not.toHaveBeenCalled();
    expect(mockUpdateModelNsfwLevels).not.toHaveBeenCalled();
  });

  it('finishes a removal whose level recompute failed, on the retry', async () => {
    arrange({ waiting: [{ since: ago(60_000), attempt: 1, nextAt: NOW.toISOString() }] });
    db.model.findUnique.mockResolvedValue({
      ...withFace,
      sfwCoverImageId: null,
      meta: {
        comFaceRemoved: {
          at: '2026-11-05T00:00:00.000Z',
          sfwCoverImageId: COVER_ID,
          reason: 'detected',
        },
      },
    } as never);

    await processComFaceRechecks(NOW);

    expect(mockPreviewComFaceIntent).not.toHaveBeenCalled();
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
    expect(mockBust).toHaveBeenCalledWith(MODEL_ID);
  });

  it('saves the retry before retiring the fresh edit it read', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    await processComFaceRechecks(NOW);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.keyValue.upsert.mock.invocationCallOrder[0]
    );
  });

  it('clears the cover and records the removal in one transaction', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    const tx = { $executeRaw: vi.fn(async () => 1), modActivity: { create: vi.fn() } };
    db.$transaction.mockImplementationOnce((async (fn: (client: typeof tx) => unknown) =>
      fn(tx)) as never);

    await processComFaceRechecks(NOW);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.modActivity.create).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });
  it('finishes an unfinished removal when it gives up, and keeps the retry until it does', async () => {
    const out = { since: ago(COM_FACE_RECHECK_WINDOW_MS), attempt: 30, nextAt: NOW.toISOString() };
    arrange({ waiting: [out] });
    db.model.findUnique.mockResolvedValue({
      ...withFace,
      sfwCoverImageId: null,
      meta: { comFaceRemoved: { at: ago(60_000), sfwCoverImageId: COVER_ID, reason: 'detected' } },
    } as never);
    mockUpdateModelNsfwLevels.mockRejectedValue(new Error('level service down'));

    const failed = await processComFaceRechecks(NOW);

    expect(failed.gaveUp).toBe(0);
    expect(db.keyValue.deleteMany).not.toHaveBeenCalled();

    mockUpdateModelNsfwLevels.mockResolvedValue(undefined);
    const finished = await processComFaceRechecks(NOW);

    expect(finished.skipped).toBe(1);
    expect(db.keyValue.deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
  });

  it('keeps going past a model whose bookkeeping throws, and queues that edit again', async () => {
    const OTHER = 43;
    arrange({ fresh: [MODEL_ID, OTHER] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    db.keyValue.upsert.mockRejectedValueOnce(new Error('db blip'));

    const counts = await processComFaceRechecks(NOW);

    expect(counts.errored).toBe(1);
    expect(db.keyValue.upsert).toHaveBeenCalledTimes(2);
    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck', [MODEL_ID]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('queues again an edit to a model waiting on a retry when its bookkeeping throws', async () => {
    arrange({
      fresh: [MODEL_ID],
      waiting: [{ since: ago(60 * 60_000), attempt: 6, nextAt: later(30 * 60_000) }],
    });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    db.keyValue.upsert.mockRejectedValueOnce(new Error('db blip'));

    const counts = await processComFaceRechecks(NOW);

    expect(counts.errored).toBe(1);
    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck', [MODEL_ID]);
  });

  it.each([
    ['an unreadable start', { since: 'garbage', attempt: 3, nextAt: NOW.toISOString() }],
    ['no state at all', {}],
  ])('treats a retry with %s as due and out of time', async (_, value) => {
    arrange({ waiting: [value] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });

    const counts = await processComFaceRechecks(NOW);

    expect(counts.gaveUp).toBe(1);
    expect(marker()).toMatchObject({ reason: 'recheck-unverified' });
  });

  it('runs due retries before fresh edits', async () => {
    const OTHER = 43;
    arrange({
      fresh: [OTHER],
      waiting: [{ since: ago(COM_FACE_RECHECK_WINDOW_MS), attempt: 30, nextAt: NOW.toISOString() }],
    });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    await processComFaceRechecks(NOW);

    expect(db.model.findUnique.mock.calls.map(([args]) => args.where.id)).toEqual([
      MODEL_ID,
      OTHER,
    ]);
  });

  it('records no give-up when there was no face left to take off', async () => {
    arrange({
      waiting: [{ since: ago(COM_FACE_RECHECK_WINDOW_MS), attempt: 30, nextAt: NOW.toISOString() }],
    });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    db.$executeRaw.mockResolvedValue(0 as never);

    const counts = await processComFaceRechecks(NOW);

    expect(counts.gaveUp).toBe(0);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: COM_FACE_RECHECK_GAVE_UP })
    );
    expect(db.keyValue.deleteMany).toHaveBeenCalledWith({ where: { key: KEY } });
  });
});

describe('queueing a re-check when the queue is unavailable', () => {
  /** The retry-row write, as the Prisma.Sql object the service hands `$executeRaw`. */
  const retryRowWrite = () =>
    db.$executeRaw.mock.calls
      .map((call) => call[0] as unknown as { sql?: string; values?: unknown[] })
      .find((sql) => sql.sql?.includes('INSERT INTO "KeyValue"'));

  it.each([
    ['reports a missed enqueue', () => mockAddToQueue.mockResolvedValueOnce(false)],
    ['throws', () => mockAddToQueue.mockRejectedValueOnce(new Error('redis down'))],
  ])('writes a due retry row when the queue %s, which the next run checks', async (_, fail) => {
    fail();

    await queueComFaceRecheck(MODEL_ID);

    const write = retryRowWrite();
    expect(write?.values?.[0]).toBe(KEY);
    const row = JSON.parse(String(write?.values?.[1]));
    expect(row).toEqual({ since: NOW.toISOString(), attempt: 0, nextAt: '' });
    expect(coverCleared()).toBe(false);

    vi.clearAllMocks();
    db.model.findUnique.mockResolvedValue(withFace as never);
    db.modelVersion.findMany.mockResolvedValue([{ trainedWords: ['trigger'] }] as never);
    arrange({ waiting: [row] });
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));

    const counts = await processComFaceRechecks(NOW);

    expect(mockPreviewComFaceIntent).toHaveBeenCalledTimes(1);
    expect(counts.allowed).toBe(1);
  });

  it('writes no retry row when the enqueue lands', async () => {
    await queueComFaceRecheck(MODEL_ID);

    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck', MODEL_ID);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes a due retry row for an edit the job could not queue again', async () => {
    arrange({ fresh: [MODEL_ID] });
    mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' });
    db.keyValue.upsert.mockRejectedValueOnce(new Error('bookkeeping failed'));
    mockAddToQueue.mockResolvedValueOnce(false);

    await processComFaceRechecks(NOW);

    expect(mockAddToQueue).toHaveBeenCalledWith('com-face-recheck', [MODEL_ID]);
    expect(retryRowWrite()?.values?.[0]).toBe(KEY);
  });

  it('takes the face off .com when the retry row cannot be written either', async () => {
    mockAddToQueue.mockResolvedValueOnce(false);
    db.$executeRaw.mockRejectedValueOnce(new Error('db down'));

    await queueComFaceRecheck(MODEL_ID);

    expect(coverCleared()).toBe(true);
    const removal = db.$executeRaw.mock.calls.find(
      (call) =>
        Array.isArray(call[0]) &&
        (call[0] as unknown as string[]).join('?').includes('"sfwCoverImageId" = NULL')
    );
    const removalMarker = removal
      ?.slice(1)
      .find((value) => typeof value === 'string' && value.includes('sfwCoverImageId'));
    expect(JSON.parse(String(removalMarker)).reason).toBe('recheck-unverified');
    expect(mockUpdateModelNsfwLevels).toHaveBeenCalledWith([MODEL_ID]);
  });
});
