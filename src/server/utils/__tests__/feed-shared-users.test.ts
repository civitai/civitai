import { parse as devalueParse, stringify as devalueStringify } from 'devalue';
import superjson from 'superjson';
import { describe, expect, it, vi } from 'vitest';
import { isSameFeedUser, shareFeedUsers } from '~/server/utils/feed-shared-users';

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {
    IMAGE_FEED_SHARED_USERS: 'image-feed-shared-users',
    TRPC_FAST_SUPERJSON_SHARED_REFS: 'trpc-fast-superjson-shared-refs',
  },
  isFliptSync: () => null,
}));

/**
 * `shareFeedUsers` must leave every value a client reads exactly as it was — only object identity
 * changes — and must make the devalue response smaller. The expectations compare against the
 * UNSHARED input decoded through the real serializers, never against the function's own output.
 */

// Built per image, as `getAllImages` / `getAllImagesIndex` do: equal content, distinct objects.
function makeUser(id: number, cosmetics: unknown[], profilePicture: unknown) {
  return {
    id,
    username: `creator-${id}`,
    image: `avatar-${id}`,
    deletedAt: null,
    cosmetics,
    profilePicture,
  };
}

function makeImage(id: number, postId: number, user: ReturnType<typeof makeUser>) {
  return {
    id,
    postId,
    url: `url-${id}`,
    hash: `hash-${id}`,
    nsfwLevel: 1,
    width: 832,
    height: 1216,
    sortAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id % 60)),
    user,
    stats: { likeCountAllTime: id % 7, commentCountAllTime: id % 3 },
    tagIds: [id, id + 1, id + 2],
  };
}

/** An `image.getImagesAsPostsInfinite`-shaped page: posts of 1–8 images, one creator each. */
function asPostsPage() {
  let imageId = 1000;
  // One fetch looks each creator's cosmetics and profile picture up ONCE, so every image of a
  // creator holds the same `cosmetics` array and `profilePicture` object, whichever post it is in.
  const lookups = new Map<number, { cosmetics: unknown[]; profilePicture: unknown }>();
  const lookup = (creatorId: number) => {
    let found = lookups.get(creatorId);
    if (!found) {
      found = {
        cosmetics:
          creatorId % 3 === 0
            ? [{ cosmetic: { id: creatorId, name: `badge-${creatorId}` }, data: {} }]
            : [],
        profilePicture:
          creatorId % 2 === 0 ? { id: 9000 + creatorId, url: `pp-${creatorId}` } : null,
      };
      lookups.set(creatorId, found);
    }
    return found;
  };
  const items = Array.from({ length: 12 }, (_, p) => {
    const creatorId = 500 + (p % 9); // some creators own two posts on the page
    const { cosmetics, profilePicture } = lookup(creatorId);
    const images = Array.from({ length: 1 + (p % 8) }, () =>
      makeImage(imageId++, 70 + p, makeUser(creatorId, cosmetics, profilePicture))
    );
    return {
      postId: 70 + p,
      pinned: false,
      sortAt: images[0].sortAt,
      // The handler hands the post the first image's `user` object, as today.
      user: images[0].user,
      images,
      review: undefined,
    };
  });
  return { nextCursor: 'c|1', items };
}

/** An `image.getInfinite`-shaped page: a flat list of images. */
function infinitePage() {
  const items = Array.from({ length: 40 }, (_, i) =>
    makeImage(2000 + i, 80 + i, makeUser(600 + (i % 6), [], null))
  );
  return { nextCursor: 42, items };
}

describe('shareFeedUsers — the decoded response is unchanged', () => {
  it.each([
    ['image.getImagesAsPostsInfinite', asPostsPage],
    ['image.getInfinite', infinitePage],
  ])('%s: devalue and superjson decode to the same values as before', (_label, build) => {
    const before = build();
    const after = shareFeedUsers(build());
    expect(devalueParse(devalueStringify(after))).toStrictEqual(
      devalueParse(devalueStringify(before))
    );
    expect(superjson.deserialize(superjson.serialize(after))).toStrictEqual(
      superjson.deserialize(superjson.serialize(before))
    );
    // And to the input itself (devalue's round trip is lossless for these shapes).
    expect(devalueParse(devalueStringify(after))).toStrictEqual(before);
  });

  it('keeps every consumer-facing user field on every image', () => {
    const after = shareFeedUsers(asPostsPage());
    for (const post of after.items) {
      expect(post.user).toMatchObject({ id: expect.any(Number), username: expect.any(String) });
      for (const image of post.images) {
        expect(image.user.id).toBe(post.user.id);
        expect(image.user.username).toBe(`creator-${post.user.id}`);
        expect(image.user.image).toBe(`avatar-${post.user.id}`);
        expect(image.user).toHaveProperty('cosmetics');
        expect(image.user).toHaveProperty('profilePicture');
        expect(image.user).toHaveProperty('deletedAt', null);
      }
    }
  });

  it('does not mutate its input', () => {
    const input = asPostsPage();
    const snapshot = input.items.map((post) => post.images.map((image) => image.user));
    shareFeedUsers(input);
    expect(input.items.map((post) => post.images.map((image) => image.user))).toStrictEqual(
      snapshot
    );
    input.items.forEach((post, p) =>
      post.images.forEach((image, i) => expect(image.user).toBe(snapshot[p][i]))
    );
  });
});

describe('shareFeedUsers — users are shared', () => {
  it('gives every image of one creator the same user object, post-level included', () => {
    const after = shareFeedUsers(asPostsPage());
    const byId = new Map<number, unknown>();
    for (const post of after.items) {
      for (const user of [post.user, ...post.images.map((image) => image.user)]) {
        const seen = byId.get(user.id);
        if (seen) expect(user).toBe(seen);
        else byId.set(user.id, user);
      }
    }
    // Positive control: the page really has creators with several images.
    expect(byId.size).toBeLessThan(after.items.flatMap((post) => post.images).length);
  });

  it('leaves a user that differs in any field unshared', () => {
    const a = makeUser(1, [], null);
    const b = { ...makeUser(1, [], null), username: 'renamed' };
    const c = makeUser(1, [{ cosmetic: { id: 1 } }], null);
    const d = { ...makeUser(1, [], null), deletedAt: new Date(5) };
    const e = { ...makeUser(1, [], null), extra: true };
    const f = makeUser(1, [], null);
    const out = shareFeedUsers({
      items: [a, b, c, d, e, f].map((user, i) => ({ id: i, user })),
    });
    // Control: an equal one IS shared.
    expect(out.items[5].user).toBe(a);
    expect(out.items[1].user).toBe(b);
    expect(out.items[2].user).toBe(c);
    expect(out.items[3].user).toBe(d);
    expect(out.items[4].user).toBe(e);
  });

  it('treats equal Dates and two empty arrays as equal, and nothing else', () => {
    expect(
      isSameFeedUser(
        { id: 1, deletedAt: new Date(3), cosmetics: [] },
        { id: 1, deletedAt: new Date(3), cosmetics: [] }
      )
    ).toBe(true);
    expect(isSameFeedUser({ id: 1, cosmetics: [1] }, { id: 1, cosmetics: [1] })).toBe(false);
    expect(isSameFeedUser({ id: 1, pp: { id: 2 } }, { id: 1, pp: { id: 2 } })).toBe(false);
    expect(isSameFeedUser({ id: 1, a: undefined }, { id: 1, b: undefined })).toBe(false);
    expect(isSameFeedUser({ id: 1 }, { id: 2 })).toBe(false);
  });

  it('passes through shapes it does not know', () => {
    const odd = { items: [null, 3, { noUser: true }] };
    expect(shareFeedUsers(odd)).toBe(odd);
    expect(shareFeedUsers(undefined)).toBeUndefined();
    const noItems = { nextCursor: 1 };
    expect(shareFeedUsers(noItems)).toBe(noItems);
  });
});

describe('shareFeedUsers — payload size (devalue)', () => {
  it.each([
    ['image.getImagesAsPostsInfinite', asPostsPage],
    ['image.getInfinite', infinitePage],
  ])('%s: the devalue body is smaller', (_label, build) => {
    const before = devalueStringify(build()).length;
    const after = devalueStringify(shareFeedUsers(build())).length;
    // Each image beyond a creator's first saves its `user` object's own entry (its six keys).
    expect(after).toBeLessThan(before);
  });
});
