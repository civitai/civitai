import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelService from '~/server/services/model.service';
import type * as UserService from '~/server/services/user.service';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const { getModel, amIBlockedByUser } = vi.hoisted(() => ({
  getModel: vi.fn(),
  amIBlockedByUser: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModel,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser,
}));

import { getModelHandler } from '~/server/controllers/model.controller';

/**
 * `model.getById` for a model flagged `poi`: moderators and the owner get it, everyone else a
 * NOT_FOUND. The first read after the visibility checks is the post lookup; reaching it means the
 * model was served, so the test stops there.
 */

const OWNER_ID = 10;
const STOP = new Error('reached the post read');

const VIEWERS = {
  anon: undefined,
  other: { id: 20, isModerator: false },
  owner: { id: OWNER_ID, isModerator: false },
  moderator: { id: 30, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

async function lookup(viewer: ViewerKey, poi: boolean): Promise<'served' | 'not-found'> {
  getModel.mockResolvedValue({
    id: 1,
    poi,
    status: ModelStatus.Published,
    user: { id: OWNER_ID },
    modelVersions: [{ id: 1, status: ModelStatus.Published, publishedAt: new Date(0) }],
  });
  const outcome = await getModelHandler({
    input: { id: 1 },
    ctx: { user: VIEWERS[viewer], features: {} },
  } as never).then(
    () => new Error('handler was expected to stop at the post read'),
    (e: unknown) => e
  );
  if (outcome instanceof TRPCError && outcome.code === 'NOT_FOUND') return 'not-found';
  if (outcome instanceof Error && outcome.message === STOP.message) return 'served';
  throw outcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
  dbMock.dbRead.post.findMany.mockRejectedValue(STOP);
});

describe('getModelHandler, flagged model', () => {
  it.each<[ViewerKey, 'served' | 'not-found']>([
    ['anon', 'not-found'],
    ['other', 'not-found'],
    ['owner', 'served'],
    ['moderator', 'served'],
  ])('%s gets %s', async (viewer, expected) => {
    expect(await lookup(viewer, true)).toBe(expected);
  });

  it.each<ViewerKey>(['anon', 'other'])(
    'control: an unflagged model is served to %s',
    async (v) => {
      expect(await lookup(v, false)).toBe('served');
    }
  );
});
