import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `post.getResources` reads a post's resources by post id alone, so it answers only when `post.get`
 * would: `getPostDetail` admits the viewer, then the owner's block is checked. `getPostDetail` is
 * stubbed with its contract (NOT_FOUND unless published and not Private, or the viewer owns it or
 * moderates); its predicate against a real database is pinned in hot-reads-6.kysely-parity.test.ts.
 */

const { mockGetPostDetail, mockGetPostResources, mockAmIBlockedByUser } = vi.hoisted(() => ({
  mockGetPostDetail: vi.fn(),
  mockGetPostResources: vi.fn(),
  mockAmIBlockedByUser: vi.fn(),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostDetail: mockGetPostDetail,
  getPostResources: mockGetPostResources,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  amIBlockedByUser: mockAmIBlockedByUser,
}));

import { getPostResourcesHandler } from '~/server/controllers/post.controller';
import { dbRead } from '~/server/db/client';

const POST_ID = 9;
const OWNER = 5;

type User = { id: number; isModerator?: boolean } | undefined;
const ANON: User = undefined;
const STRANGER: User = { id: 77 };
const SELF: User = { id: OWNER };
const MOD: User = { id: 77, isModerator: true };

const ROWS = [
  { postId: POST_ID, modelVersionId: 1, name: 'lora' },
  { postId: POST_ID, modelVersionId: 2, name: 'vae' },
];
// A row with no model has no model owner.
const LORA = { ...ROWS[0], modelUserId: null };

function postIs(state: { published?: boolean; private?: boolean }) {
  const { published = true, private: isPrivate = false } = state;
  mockGetPostDetail.mockImplementation(async ({ id, user }: { id: number; user?: User }) => {
    const visible = (published && !isPrivate) || user?.id === OWNER || user?.isModerator === true;
    if (id !== POST_ID || !visible) throw new TRPCError({ code: 'NOT_FOUND' });
    return { id, user: { id: OWNER } };
  });
}

async function resourcesFor(user: User) {
  try {
    return await getPostResourcesHandler({
      input: { id: POST_ID },
      ctx: { user } as never,
    });
  } catch (e) {
    if ((e as TRPCError).code === 'NOT_FOUND') return 'NOT_FOUND';
    throw e;
  }
}

beforeEach(() => {
  mockGetPostDetail.mockReset();
  mockGetPostResources.mockReset().mockResolvedValue(ROWS);
  mockAmIBlockedByUser.mockReset().mockResolvedValue(false);
});

describe('post.getResources visibility', () => {
  it('a published post returns its rows, without the vae, to anyone', async () => {
    postIs({});
    expect(await resourcesFor(ANON)).toEqual([LORA]);
    expect(await resourcesFor(STRANGER)).toEqual([LORA]);
  });

  it('carries no cover image: covers are served only to the post owner by post.getResourceCovers', async () => {
    postIs({});
    expect(await resourcesFor(ANON)).toEqual([LORA]);
  });

  it.each([
    ['unpublished', { published: false }],
    ['Private', { private: true }],
  ])('a %s post is NOT_FOUND to a stranger and signed out', async (_, state) => {
    postIs(state);
    expect(await resourcesFor(STRANGER)).toBe('NOT_FOUND');
    expect(await resourcesFor(ANON)).toBe('NOT_FOUND');
    expect(mockGetPostResources).not.toHaveBeenCalled();
  });

  it.each([
    ['unpublished', { published: false }],
    ['Private', { private: true }],
  ])('a %s post still returns rows to its owner and a moderator', async (_, state) => {
    postIs(state);
    expect(await resourcesFor(SELF)).toEqual([LORA]);
    expect(await resourcesFor(MOD)).toEqual([LORA]);
    // The service filters rows by the images this viewer may open, so it must be told who asks.
    expect(mockGetPostResources).toHaveBeenCalledWith({
      id: POST_ID,
      userId: OWNER,
      isModerator: undefined,
    });
    expect(mockGetPostResources).toHaveBeenCalledWith({
      id: POST_ID,
      userId: MOD!.id,
      isModerator: true,
    });
  });

  it('a stranger the owner blocked gets NOT_FOUND; a moderator is not block-checked', async () => {
    postIs({});
    mockAmIBlockedByUser.mockResolvedValue(true);
    expect(await resourcesFor(STRANGER)).toBe('NOT_FOUND');
    expect(mockAmIBlockedByUser).toHaveBeenCalledWith({
      userId: STRANGER!.id,
      targetUserId: OWNER,
    });
    expect(mockGetPostResources).not.toHaveBeenCalled();
    expect(await resourcesFor(MOD)).toEqual([LORA]);
  });

  it("names each row's model owner, so the post editor can skip the owner's own models", async () => {
    postIs({});
    mockGetPostResources.mockResolvedValue([
      { postId: POST_ID, modelVersionId: 1, modelId: 10, name: 'lora' },
      { postId: POST_ID, modelVersionId: 3, modelId: 30, name: 'checkpoint' },
    ]);
    const findMany = vi
      .spyOn(dbRead.model, 'findMany')
      .mockResolvedValue([{ id: 10, userId: OWNER }] as never);
    expect(await resourcesFor(SELF)).toEqual([
      expect.objectContaining({ modelVersionId: 1, modelUserId: OWNER }),
      expect.objectContaining({ modelVersionId: 3, modelUserId: null }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [10, 30] } } })
    );
    findMany.mockRestore();
  });
});
