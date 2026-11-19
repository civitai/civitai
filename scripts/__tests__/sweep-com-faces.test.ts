import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IntentService from '~/server/services/model-com-face-intent.service';
import type * as SfwFaceService from '~/server/services/model-sfw-face.service';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type * as TextScanPrompt from '~/server/services/text-scan/prompt';

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
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPrompt>()),
  getActiveTextScanPrompts: vi.fn(async () => ({
    'label:model-com-face-intent': { id: 111, key: 'label:model-com-face-intent', content: 'x' },
  })),
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

import { dbMock } from '~/__tests__/mocks/db.mock';
import { comFaceIntentTextHash } from '~/server/services/model-com-face-intent.service';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { type Face, openIdOut, sweep, sweepOne } from '../oneoffs/sweep-com-faces';

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

// A held-back detection is stored only behind the re-lock suppression, or the owner's next face
// save would reuse it and lock. The pglite test shows the suppression stops that lock.
function expectRelockSuppressedBeforeRecord() {
  const execute = vi.mocked(dbMock.dbWrite.$executeRaw);
  const call = execute.mock.calls.findIndex(([sql]) =>
    String((sql as { sql?: string }).sql).includes('comFaceIntentRelockSuppressed')
  );
  expect(call).toBeGreaterThanOrEqual(0);
  expect(mocks.record).toHaveBeenCalledWith(7, expect.objectContaining({ detected: true }));
  expect(execute.mock.invocationCallOrder[call]).toBeLessThan(
    mocks.record.mock.invocationCallOrder[0]
  );
}

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
      if (apply) expectRelockSuppressedBeforeRecord();
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
      { record: mocks.record, lock: expect.any(Function), suppress: expect.any(Function) }
    );
  });

  // Decision: a model a moderator acted on before rulings were logged keeps its
  // stored verdict but is listed for moderators instead of locked. Don't fold it into `locked`.
  it.each([true, false])(
    'lists, never locks, a model touched before logging (apply %s)',
    async (apply) => {
      const touched = face({ touchedBeforeLogging: true });
      mocks.read.mockResolvedValue(touched);
      mocks.preview.mockResolvedValue(verdict(true));
      const listed: [string, number][] = [];
      await expect(
        sweep([touched], apply, 1, (outcome, id) => listed.push([outcome, id]))
      ).resolves.toMatchObject({
        outcomes: { 'moderator-list': 1 },
        ownersLocked: 0,
      });
      expect(listed).toEqual([['moderator-list', 7]]);
      expect(mocks.lock).not.toHaveBeenCalled();
      if (apply) expectRelockSuppressedBeforeRecord();
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

  // A lock that errors may have committed (the lag flag runs after the transaction), so it counts
  // against --max-locks and is reported apart from a refusal. Concurrency 1: see the cap test below.
  it('apply: a lock error is counted lock-error and against --max-locks', async () => {
    mocks.read.mockImplementation(async (id: number) => face({ id }));
    mocks.preview.mockResolvedValue(verdict(true));
    mocks.lock.mockRejectedValueOnce(new Error('redis down'));
    const faces = [1, 2, 3].map((id) => face({ id }));
    const ids: [string, number][] = [];
    await expect(
      sweep(faces, true, 1, (outcome, id) => ids.push([outcome, id]), 2)
    ).resolves.toMatchObject({ outcomes: { 'lock-error': 1, locked: 1 }, unchecked: 1 });
    // Both ids reach the private list, so a lock can be reversed and an error re-checked by id.
    expect(ids).toEqual([
      ['lock-error', 1],
      ['locked', 2],
    ]);
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
      unchecked: 0,
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  // Decision: an apply that would lock more than the ceiling stops, so a person decides. Faces in
  // flight count against it, so concurrency never carries locks past it.
  // Run as a dry run: concurrent `await import()`s of a vi.mock'd module sometimes resolve to the
  // real one, so an apply here would hit the db mock. A would-lock counts against the cap the same.
  it('stops before a lock past --max-locks, at any concurrency', async () => {
    mocks.read.mockImplementation(async (id: number) => face({ id }));
    mocks.preview.mockResolvedValue(verdict(true));
    const faces = [1, 2, 3, 4, 5].map((id) => face({ id }));
    await expect(sweep(faces, false, 4, undefined, 2)).resolves.toEqual({
      outcomes: { locked: 2 },
      ownersLocked: 1,
      failed: {},
      unchecked: 3,
    });
  });

  // The list is the only way a lock is reversed or a listed model reviewed by id.
  it('writes the id list to a new owner-only file, one outcome and id per line', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sweep-')), 'ids.tsv');
    const write = openIdOut(file);
    write('locked', 1);
    write('moderator-list', 2);
    expect(readFileSync(file, 'utf8')).toBe('locked\t1\nmoderator-list\t2\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => openIdOut(file)).toThrow();
  });
});
