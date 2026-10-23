import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as CommentsV2Service from '~/server/services/commentsv2.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';

// The real storyline gate runs; only its inputs (the row, the viewer's blocks) are faked.

const getCommentsInfinite = vi.fn(async () => null);
const getCommentsThreadDetails2 = vi.fn(async () => null);
const getCommentCount = vi.fn(async () => 0);
const upsertComment = vi.fn(async () => ({ id: 1 }));
const getComment = vi.fn(async () => ({ id: 5, threadId: 70, user: { id: 9 } }));
const getCommentThreadStorylineId = vi.fn<() => Promise<number | null>>(async () => null);
const getCommentStorylineId = vi.fn<() => Promise<number | null>>(async () => null);

vi.mock('~/server/services/commentsv2.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentsV2Service>()),
  getCommentsInfinite: (...args: unknown[]) => getCommentsInfinite(...(args as [])),
  getCommentsThreadDetails2: (...args: unknown[]) => getCommentsThreadDetails2(...(args as [])),
  getCommentCount: (...args: unknown[]) => getCommentCount(...(args as [])),
  upsertComment: (...args: unknown[]) => upsertComment(...(args as [])),
  getComment: (...args: unknown[]) => getComment(...(args as [])),
  getCommentThreadBounty: vi.fn(async () => null),
  getCommentThreadCrucibleId: vi.fn(async () => null),
  getCommentThreadStorylineId: (...args: unknown[]) => getCommentThreadStorylineId(...(args as [])),
  getCommentStorylineId: (...args: unknown[]) => getCommentStorylineId(...(args as [])),
  isViewerContentOwner: vi.fn(async () => false),
}));

const blockedPair = { ids: [] as number[] };
const hidden = { ids: [] as number[] };
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getBlockedPairIds: vi.fn(async () => blockedPair.ids),
  HiddenUsers: { getCached: vi.fn(async () => hidden.ids.map((id) => ({ id }))) },
  BlockedUsers: { getCached: vi.fn(async () => []) },
  BlockedByUsers: { getCached: vi.fn(async () => []) },
}));

const flags = { storylines: true };
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ storylines: flags.storylines }),
}));

const reader = { level: NsfwLevel.PG };
vi.mock('~/server/utils/storyline-reader-level', () => ({
  storylineReaderLevel: () => reader.level,
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));

const {
  getCommentsInfiniteHandler,
  getCommentsThreadDetailsHandler,
  getCommentCountV2Handler,
  upsertCommentV2Handler,
  getCommentHandler,
} = await import('../commentv2.controller');

const OWNER = 4;
const STRANGER = 9;
const MODERATOR = 1;
const STORYLINE = 17;
const input = { entityType: 'storyline', entityId: STORYLINE, content: '<p>hi</p>' } as never;
const as = (id: number, isModerator = false) =>
  ({ user: { id, isModerator }, features: {} } as never);

const storylineRow = (over: Record<string, unknown> = {}) => ({
  id: STORYLINE,
  userId: OWNER,
  title: 'Night Train',
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  maxNsfwLevel: NsfwLevel.R,
  minorByScan: false,
  tosViolation: false,
  createdAt: new Date(),
  nsfwLevel: NsfwLevel.PG,
  moderatorNsfwLevel: null,
  user: { id: OWNER, username: 'owner', bannedAt: null, deletedAt: null },
  chapters: [{ id: 1, postId: 100, post: { nsfwLevel: NsfwLevel.PG } }],
  ...over,
});

const reset = () => {
  vi.clearAllMocks();
  blockedPair.ids = [];
  hidden.ids = [];
  flags.storylines = true;
  reader.level = NsfwLevel.PG;
  dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow());
};

// Each rule a non-owner, non-moderator reader is refused by, as the page's own gate has it.
const HIDDEN_FROM_READERS: [string, () => void][] = [
  [
    'taken down',
    () =>
      dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow({ tosViolation: true })),
  ],
  [
    'empty (no chapter 1 yet)',
    () => dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow({ chapters: [] })),
  ],
  ['blocked either way with its owner', () => (blockedPair.ids = [OWNER])],
  ['owned by someone the reader hid', () => (hidden.ids = [OWNER])],
  [
    'owned by a banned user',
    () =>
      dbMock.dbRead.storyline.findUnique.mockResolvedValue(
        storylineRow({ user: { id: OWNER, username: 'o', bannedAt: new Date(), deletedAt: null } })
      ),
  ],
  [
    'above the reader’s browsing level',
    () =>
      dbMock.dbRead.storyline.findUnique.mockResolvedValue(
        storylineRow({ chapters: [{ id: 1, postId: 100, post: { nsfwLevel: NsfwLevel.X } }] })
      ),
  ],
  ['behind a storylines flag the reader lacks', () => (flags.storylines = false)],
];

const HANDLERS = [
  ['getInfinite', getCommentsInfiniteHandler, getCommentsInfinite],
  ['getThreadDetails', getCommentsThreadDetailsHandler, getCommentsThreadDetails2],
  ['getCount', getCommentCountV2Handler, getCommentCount],
  ['upsert', upsertCommentV2Handler, upsertComment],
] as unknown as Array<
  [string, (a: { ctx: never; input: never }) => Promise<unknown>, { mock: { calls: unknown[] } }]
>;

describe.each(HANDLERS)('storyline thread visibility: %s', (_name, handler, service) => {
  beforeEach(reset);
  const call = (ctx: never, i: never = input) => handler({ ctx, input: i });

  it('serves the thread of a storyline the reader can open', async () => {
    await call(as(STRANGER));
    expect(service.mock.calls.length).toBe(1);
  });

  it('refuses a storyline that does not exist', async () => {
    dbMock.dbRead.storyline.findUnique.mockResolvedValue(null);
    await expect(call(as(STRANGER))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(HIDDEN_FROM_READERS)('refuses a reader when the storyline is %s', async (_l, arrange) => {
    arrange();
    await expect(call(as(STRANGER))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.mock.calls.length).toBe(0);
  });

  it('gates a reply (entity `comment`) by the storyline its parent comment is on', async () => {
    getCommentStorylineId.mockResolvedValue(STORYLINE);
    dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow({ chapters: [] }));
    await expect(
      call(as(STRANGER), { entityType: 'comment', entityId: 55, content: '<p>re</p>' } as never)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getCommentStorylineId).toHaveBeenCalledWith(55);
  });
});

describe.each(HANDLERS.slice(0, 3))(
  'storyline thread reads by owner and moderator: %s',
  (_n, handler) => {
    beforeEach(reset);

    it.each([
      ['taken down', { tosViolation: true }],
      ['empty', { chapters: [] }],
    ])('the owner and a moderator still read a storyline that is %s', async (_l, over) => {
      dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow(over));
      await expect(handler({ ctx: as(OWNER), input })).resolves.not.toThrow();
      await expect(handler({ ctx: as(MODERATOR, true), input })).resolves.not.toThrow();
    });
  }
);

describe('writing in a taken-down storyline', () => {
  beforeEach(() => {
    reset();
    dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow({ tosViolation: true }));
  });

  it('refuses the owner', async () => {
    await expect(upsertCommentV2Handler({ ctx: as(OWNER), input })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(upsertComment).not.toHaveBeenCalled();
  });

  it('lets a moderator write', async () => {
    await upsertCommentV2Handler({ ctx: as(MODERATOR, true), input });
    expect(upsertComment).toHaveBeenCalledTimes(1);
  });

  it('refuses an edit that names another entity type, by the comment’s own thread', async () => {
    getCommentStorylineId.mockImplementation(async () => STORYLINE);
    await expect(
      upsertCommentV2Handler({
        ctx: as(OWNER),
        input: { id: 77, entityType: 'image', entityId: 3, content: '<p>x</p>' } as never,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getCommentStorylineId).toHaveBeenCalledWith(77);
    expect(upsertComment).not.toHaveBeenCalled();
  });
});

describe('getCommentHandler on a storyline comment', () => {
  beforeEach(() => {
    reset();
    getCommentThreadStorylineId.mockResolvedValue(STORYLINE);
  });
  const read = (ctx: never) => getCommentHandler({ ctx, input: { id: 5 } as never });

  it('serves it to a reader who can open the storyline', async () => {
    await expect(read(as(STRANGER))).resolves.toBeTruthy();
    expect(getCommentThreadStorylineId).toHaveBeenCalledWith(70);
  });

  it.each(HIDDEN_FROM_READERS)('refuses it when the storyline is %s', async (_l, arrange) => {
    arrange();
    await expect(read(as(STRANGER))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets a moderator read it without resolving the storyline', async () => {
    dbMock.dbRead.storyline.findUnique.mockResolvedValue(storylineRow({ tosViolation: true }));
    await expect(read(as(MODERATOR, true))).resolves.toBeTruthy();
    expect(getCommentThreadStorylineId).not.toHaveBeenCalled();
  });
});
