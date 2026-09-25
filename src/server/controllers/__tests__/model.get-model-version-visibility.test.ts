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
 * Which versions of a model the model page shows to which viewer. The rule is shared with the
 * resource-attach and post-create paths, so this matrix pins the model page's half of it.
 *
 * The handler's first read keyed on the visible version ids is the post lookup; the test records
 * those ids there and stops the handler, so nothing downstream needs faking.
 */

const OWNER_ID = 10;
const OTHER_ID = 20;
const MOD_ID = 30;
const DAY = 24 * 60 * 60 * 1000;

const VERSIONS = {
  publishedPast: { status: ModelStatus.Published, publishedAt: new Date(Date.now() - DAY) },
  publishedUndated: { status: ModelStatus.Published, publishedAt: null },
  publishedFuture: { status: ModelStatus.Published, publishedAt: new Date(Date.now() + DAY) },
  draft: { status: ModelStatus.Draft, publishedAt: null },
  scheduled: { status: ModelStatus.Scheduled, publishedAt: new Date(Date.now() + DAY) },
  unpublished: { status: ModelStatus.Unpublished, publishedAt: new Date(Date.now() - DAY) },
} as const;
type VersionKey = keyof typeof VERSIONS;
const ALL = Object.keys(VERSIONS) as VersionKey[];
const idOf = (key: VersionKey) => ALL.indexOf(key) + 1;

const VIEWERS = {
  anon: undefined,
  other: { id: OTHER_ID, isModerator: false },
  owner: { id: OWNER_ID, isModerator: false },
  moderator: { id: MOD_ID, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

const STOP = new Error('stop after the visible-version read');

function arrange(modelStatus: ModelStatus) {
  getModel.mockResolvedValue({
    id: 1,
    status: modelStatus,
    user: { id: OWNER_ID },
    modelVersions: ALL.map((key) => ({ id: idOf(key), ...VERSIONS[key] })),
  });
  amIBlockedByUser.mockResolvedValue(false);
  dbMock.dbRead.post.findMany.mockRejectedValue(STOP);
}

async function visibleVersions(viewer: ViewerKey): Promise<VersionKey[] | 'not-found'> {
  const result = await getModelHandler({
    input: { id: 1 },
    ctx: { user: VIEWERS[viewer], features: {} },
  } as never).then(
    () => {
      throw new Error('handler was expected to stop at the post read');
    },
    (e: unknown) => e
  );
  if (result instanceof TRPCError && result.code === 'NOT_FOUND') return 'not-found';
  if (!(result instanceof Error) || result.message !== STOP.message) throw result;
  expect(dbMock.dbRead.post.findMany).toHaveBeenCalledTimes(1);
  const ids: number[] = dbMock.dbRead.post.findMany.mock.calls[0][0].where.modelVersionId.in;
  return ids.map((id) => ALL[id - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getModelHandler version visibility', () => {
  const PUBLIC_VIEW: VersionKey[] = ['publishedPast', 'publishedUndated'];

  it.each<[ViewerKey, VersionKey[]]>([
    ['anon', PUBLIC_VIEW],
    ['other', PUBLIC_VIEW],
    ['owner', ALL],
    ['moderator', ALL],
  ])('published model: %s sees exactly %j', async (viewer, expected) => {
    arrange(ModelStatus.Published);
    expect(await visibleVersions(viewer)).toEqual(expected);
  });

  it.each<[ViewerKey, VersionKey[] | 'not-found']>([
    ['anon', 'not-found'],
    ['other', 'not-found'],
    ['owner', ALL],
    ['moderator', ALL],
  ])('draft model: %s gets %j', async (viewer, expected) => {
    arrange(ModelStatus.Draft);
    expect(await visibleVersions(viewer)).toEqual(expected);
  });
});
