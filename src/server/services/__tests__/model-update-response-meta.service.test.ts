import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// updateModelById hands the written row back to many callers, so the moderation records stored in its
// meta must not reach them, while the owner's own settings must.

const { modelsSearchIndex } = await import('~/server/search-index');
const { updateModelById } = await import('~/server/services/model.service');

const MODEL = 1;
const OWNER = 5;
const STORED_META = {
  commentsLocked: true,
  declinedReason: 'duplicate',
  minorFlagSnapshot: { source: 'auto', prevMinorImageIds: [1] },
  textScanFlags: { minor: { open: true } },
  textModeration: { policy: 'x' },
  profanityMatches: ['x'],
  systemNsfwLock: { source: 's', at: '2026-01-01T00:00:00.000Z' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(modelsSearchIndex, 'queueUpdate').mockResolvedValue(undefined as never);
  const row = () => ({
    id: MODEL,
    userId: OWNER,
    status: 'Published',
    mode: null,
    meta: STORED_META,
  });
  for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
    db.model.findUnique.mockImplementation((async () => row()) as never);
    db.model.findFirst.mockImplementation((async () => row()) as never);
    db.$queryRaw.mockImplementation((async () => []) as never);
  }
  dbMock.dbWrite.model.update.mockImplementation((async ({ data }: { data: object }) => ({
    ...row(),
    ...data,
  })) as never);
});

describe('updateModelById — the returned model', () => {
  it.each([
    ['a plain write', () => updateModelById({ id: MODEL, data: { name: 'Renamed' } })],
    [
      'a locked meta write',
      () =>
        updateModelById({
          id: MODEL,
          data: {},
          meta: (stored) => stored ?? (STORED_META as never),
        }),
    ],
  ])('leaves moderator-only meta out after %s', async (_, write) => {
    const result = (await write()) as { meta: object };

    for (const key of [
      'minorFlagSnapshot',
      'textScanFlags',
      'textModeration',
      'profanityMatches',
      'systemNsfwLock',
    ])
      expect(result.meta).not.toHaveProperty(key);
    expect(result.meta).toMatchObject({ commentsLocked: true, declinedReason: 'duplicate' });
  });
});
