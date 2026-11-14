import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IntentService from '~/server/services/model-com-face-intent.service';
import type * as SfwFaceService from '~/server/services/model-sfw-face.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  read: vi.fn(),
  record: vi.fn(),
  lock: vi.fn(),
  resolve: vi.fn(),
  ruled: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewComFaceIntent: mocks.preview,
}));
// Row reads and writes are faked; the hash, reuse and lock decisions are the real ones.
vi.mock('~/server/services/model-com-face-intent.service', async (importOriginal) => ({
  ...(await importOriginal<typeof IntentService>()),
  readComFaceIntentModel: mocks.read,
  recordComFaceIntent: mocks.record,
  lockForComFaceIntent: mocks.lock,
  getOwnTriggerWords: vi.fn(async () => ['tw']),
}));
vi.mock('~/server/services/rating-review.entities', () => ({
  moderatorRuledNsfwSince: mocks.ruled,
}));
// A spy around the real face-save resolver, so the sweep is pinned to it.
vi.mock('~/server/services/model-sfw-face.service', async (importOriginal) => {
  const actual = await importOriginal<typeof SfwFaceService>();
  mocks.resolve.mockImplementation(actual.resolveComFaceIntent);
  return { ...actual, resolveComFaceIntent: mocks.resolve };
});

import '~/__tests__/mocks/db.mock';
import { comFaceIntentTextHash } from '~/server/services/model-com-face-intent.service';
import { type Face, sweep, sweepOne } from '../oneoffs/sweep-com-faces';

const face = (over: Partial<Face> = {}): Face => ({
  id: 7,
  userId: 1,
  name: 'Red Title',
  description: '<p>Red text</p>',
  nsfw: true,
  minor: false,
  poi: false,
  sfwOnly: false,
  lockedProperties: [],
  meta: {},
  touchedBeforeLogging: false,
  ...over,
});
const verdict = (detected: boolean) => ({
  status: 'ok',
  output: { detected, reason: 'stub' },
  promptId: 111,
});
const hash = comFaceIntentTextHash({
  name: 'Red Title',
  description: '<p>Red text</p>',
  triggerWords: ['tw'],
});

describe('sweep-com-faces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue(undefined);
    mocks.lock.mockResolvedValue(true);
    mocks.ruled.mockResolvedValue(false);
  });

  // Decision: a face save looks for a moderator's ruling only after a stored verdict, which no
  // candidate has, so the sweep checks for any ruling ever. Don't drop it as redundant.
  it.each([true, false])(
    'never locks a model a moderator has ruled on (apply %s)',
    async (apply) => {
      mocks.read.mockResolvedValue(face());
      mocks.preview.mockResolvedValue(verdict(true));
      mocks.ruled.mockResolvedValue(true);
      await expect(sweepOne(face(), apply)).resolves.toBe('moderator-ruled');
      expect(mocks.ruled).toHaveBeenCalledWith(7, new Date(0));
      expect(mocks.lock).not.toHaveBeenCalled();
    }
  );

  // Decision: the sweep runs the face-save resolver itself, never a copy, so a change on main to
  // what a face save stores or locks is what the sweep does too. Don't inline it.
  it('goes through the face-save resolver with the owner and stored listing', async () => {
    mocks.read.mockResolvedValue(face());
    mocks.preview.mockResolvedValue(verdict(false));
    await sweepOne(face(), true);
    expect(mocks.resolve).toHaveBeenCalledWith(
      {
        name: 'Red Title',
        description: '<p>Red text</p>',
        triggerWords: ['tw'],
        modelId: 7,
        userId: 1,
      },
      { record: mocks.record, lock: expect.any(Function) }
    );
  });

  // Decision (Mod Lead ruling): a model a moderator acted on before rulings were logged keeps its
  // stored verdict but is listed for moderators instead of locked. Don't fold it into `locked`.
  it.each([true, false])(
    'lists, never locks, a model touched before logging (apply %s)',
    async (apply) => {
      const touched = face({ touchedBeforeLogging: true });
      mocks.read.mockResolvedValue(touched);
      mocks.preview.mockResolvedValue(verdict(true));
      const listed: number[] = [];
      await expect(sweep([touched], apply, 1, (id) => listed.push(id))).resolves.toMatchObject({
        outcomes: { 'moderator-list': 1 },
        ownersLocked: 0,
      });
      expect(listed).toEqual([7]);
      expect(mocks.lock).not.toHaveBeenCalled();
      if (apply)
        expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ detected: true }));
    }
  );

  it('apply: stores the detection and locks an eligible mature model', async () => {
    mocks.read.mockResolvedValue(face());
    mocks.preview.mockResolvedValue(verdict(true));
    await expect(sweepOne(face(), true)).resolves.toBe('locked');
    expect(mocks.record).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ detected: true, textHash: hash })
    );
    expect(mocks.lock).toHaveBeenCalledWith(7, hash);
  });

  it('apply: stores an allowed verdict, so the model stops being a candidate', async () => {
    mocks.read.mockResolvedValue(face());
    mocks.preview.mockResolvedValue(verdict(false));
    await expect(sweepOne(face(), true)).resolves.toBe('allowed');
    expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ detected: false }));
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it('apply: a lock the UPDATE refuses is counted lock-refused', async () => {
    mocks.read.mockResolvedValue(face());
    mocks.preview.mockResolvedValue(verdict(true));
    mocks.lock.mockResolvedValue(false);
    await expect(sweepOne(face(), true)).resolves.toBe('lock-refused');
  });

  it('dry run: writes nothing and reports would-lock', async () => {
    mocks.read.mockResolvedValue(face());
    mocks.preview.mockResolvedValue(verdict(true));
    await expect(sweepOne(face(), false)).resolves.toBe('locked');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it.each([
    ['not-mature', { nsfw: false }],
    ['minor', { minor: true }],
    ['poi', { poi: true }],
    ['sfw-only', { sfwOnly: true }],
    ['already-locked', { lockedProperties: ['nsfw'] }],
    ['relock-suppressed', { meta: { comFaceIntentRelockSuppressed: { textHash: hash, at: 'x' } } }],
  ] as const)('dry run: a detection is not locked when %s', async (reason, over) => {
    mocks.read.mockResolvedValue(face(over));
    mocks.preview.mockResolvedValue(verdict(true));
    await expect(sweepOne(face(over), false)).resolves.toBe(reason);
  });

  it('counts outcomes and the owners who would be locked, with no verdict as unavailable', async () => {
    mocks.read.mockImplementation(async (id: number) => face({ id, userId: id === 3 ? 2 : 1 }));
    mocks.preview
      .mockResolvedValueOnce(verdict(true))
      .mockResolvedValueOnce(verdict(true))
      .mockResolvedValueOnce(verdict(false))
      .mockResolvedValueOnce({ status: 'error' });
    const faces = [1, 2, 3, 4].map((id) => face({ id, userId: id === 3 ? 2 : 1 }));
    const result = await sweep(faces, false, 1);
    expect(result).toEqual({
      outcomes: { locked: 2, allowed: 1, unavailable: 1 },
      ownersLocked: 1,
      failed: {},
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
