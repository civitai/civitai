import { describe, expect, test } from 'vitest';
import {
  storylineCeilingImpact,
  storylineChangedPrice,
  storylineDraftPublish,
  storylineDraftPublishCaption,
  storylineExpectedPrice,
  storylineContinuePostOptions,
  storylineWithoutChapters,
  storylineSubmitInput,
  storylinePriceCaption,
  storylinePriceLabel,
  storylineSubmitVerdict,
} from '~/components/Storyline/storyline-ui';
import { NsfwLevel } from '~/server/common/enums';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';
import { STORYLINE_CEILING_LEVELS } from '~/shared/utils/storyline';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const owner = 1;
const contributor = 2;
const story = (
  overrides: Partial<Parameters<typeof storylineSubmitVerdict>[0]['storyline']> = {}
) => ({
  userId: owner,
  status: 'Ongoing' as const,
  maxNsfwLevel: NsfwLevel.PG13,
  ...overrides,
});
const verdict = (
  overrides: Partial<Parameters<typeof storylineSubmitVerdict>[0]> = {}
): ReturnType<typeof storylineSubmitVerdict> =>
  storylineSubmitVerdict({
    postLevel: NsfwLevel.PG,
    viewerId: contributor,
    storyline: story(),
    closedReason: null,
    ...overrides,
  });

describe('storylineSubmitVerdict', () => {
  describe('as the owner adding their own chapter', () => {
    const asOwner = (overrides: Partial<Parameters<typeof storylineSubmitVerdict>[0]> = {}) =>
      verdict({ viewerId: owner, asOwner: true, ...overrides });

    test('the owner may add a rated post, whatever the continue terms say', () => {
      expect(asOwner({ closedReason: 'closed' })).toEqual({ allowed: true, awaitingScan: false });
    });

    test('a post above the ceiling is refused', () => {
      expect(asOwner({ postLevel: NsfwLevel.X })).toEqual({
        allowed: false,
        reason: 'aboveRating',
      });
    });

    test('an unrated post is refused, since nothing reviews it afterwards', () => {
      expect(asOwner({ postLevel: 0 })).toEqual({ allowed: false, reason: 'notRated' });
    });

    test('someone else never gets the owner path', () => {
      expect(asOwner({ viewerId: contributor })).toEqual({
        allowed: false,
        reason: 'ownStoryline',
      });
    });
  });

  test('a post at or under the ceiling may be submitted', () => {
    expect(verdict({ postLevel: NsfwLevel.PG13 })).toEqual({ allowed: true, awaitingScan: false });
  });

  test('a post above the ceiling is refused up front', () => {
    expect(verdict({ postLevel: NsfwLevel.X })).toEqual({ allowed: false, reason: 'aboveRating' });
  });

  test('a post is judged by its most severe image', () => {
    expect(verdict({ postLevel: NsfwLevel.PG | NsfwLevel.R })).toEqual({
      allowed: false,
      reason: 'aboveRating',
    });
  });

  test('an unrated post is not refused: it waits for its rating', () => {
    expect(verdict({ postLevel: 0 })).toEqual({ allowed: true, awaitingScan: true });
  });

  test('the creator cannot continue their own storyline as a contributor', () => {
    expect(verdict({ viewerId: owner })).toEqual({ allowed: false, reason: 'ownStoryline' });
  });

  test('a complete storyline takes no continuations', () => {
    expect(verdict({ storyline: story({ status: 'Complete' }) })).toEqual({
      allowed: false,
      reason: 'complete',
    });
  });

  test("the server's closed reason refuses before any post is judged", () => {
    expect(verdict({ closedReason: 'collaboratorsOnly' })).toEqual({
      allowed: false,
      reason: 'collaboratorsOnly',
    });
    expect(verdict({ closedReason: 'closed', postLevel: NsfwLevel.XXX })).toEqual({
      allowed: false,
      reason: 'closed',
    });
  });

  test('an open storyline still holds everyone to the ceiling', () => {
    expect(verdict({ postLevel: NsfwLevel.XXX })).toEqual({
      allowed: false,
      reason: 'aboveRating',
    });
  });
});

describe('price copy', () => {
  test('zero reads as Free, anything else as Buzz', () => {
    expect(storylinePriceLabel(0)).toBe('Free');
    expect(storylinePriceLabel(1500)).toBe('1,500 Buzz');
  });

  test('the slider caption says Free at zero and warns above the cap', () => {
    expect(storylinePriceCaption(0, 500)).toEqual({ text: 'Free to continue', warning: false });
    expect(storylinePriceCaption(100, 500)).toEqual({
      text: 'Contributors pay 100 Buzz',
      warning: false,
    });
    expect(storylinePriceCaption(600, 500)).toEqual({
      text: 'Contributors pay 500 Buzz',
      warning: true,
    });
  });
});

describe('storylineContinuePostOptions', () => {
  const post = (id: number, userId: number, images: { id: number }[] = []) => ({
    id,
    title: `Post ${id}`,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: null,
    imageCount: images.length,
    user: { id: userId },
    images,
  });

  test("keeps only the viewer's own posts and never the chapter being continued", () => {
    expect(
      storylineContinuePostOptions([post(1, contributor), post(2, 99), post(3, contributor)], {
        viewerId: contributor,
        parentPostId: 3,
      })
    ).toEqual([
      {
        id: 1,
        title: 'Post 1',
        nsfwLevel: NsfwLevel.PG,
        publishedAt: null,
        imageCount: 0,
        cover: null,
      },
    ]);
  });

  test("takes each post's first image as its picture", () => {
    expect(
      storylineContinuePostOptions([post(1, contributor, [{ id: 7 }, { id: 8 }])], {
        viewerId: contributor,
        parentPostId: 3,
      })[0].cover
    ).toEqual({ id: 7 });
  });
});

describe('storylineWithoutChapters', () => {
  test('leaves out the posts that are already chapters, and counts them', () => {
    expect(
      storylineWithoutChapters([{ id: 1 }, { id: 2 }, { id: 3 }], new Set([2, 3, 99]))
    ).toEqual({ posts: [{ id: 1 }], alreadyChapters: 2 });
    expect(storylineWithoutChapters([{ id: 1 }], new Set())).toEqual({
      posts: [{ id: 1 }],
      alreadyChapters: 0,
    });
  });
});

describe('storylineSubmitInput', () => {
  test('sends the price that was shown, and marks an unrated post as waiting for its rating', () => {
    expect(
      storylineSubmitInput({ parentPostId: 9, post: { id: 4, nsfwLevel: 0 }, shownPrice: 40 })
    ).toEqual({ parentPostId: 9, postId: 4, expectedPrice: 40, awaitingScan: true });
    expect(
      storylineSubmitInput({
        parentPostId: 9,
        post: { id: 5, nsfwLevel: NsfwLevel.PG },
        shownPrice: 0,
      })
    ).toEqual({ parentPostId: 9, postId: 5, expectedPrice: 0, awaitingScan: false });
  });
});

describe('storylineCeilingImpact', () => {
  const levels = {
    rootNsfwLevel: NsfwLevel.PG13,
    chapterLevels: [NsfwLevel.PG, NsfwLevel.R, NsfwLevel.X, 0],
  };

  test('counts the later chapters a ceiling would hide, ignoring unrated ones', () => {
    expect(storylineCeilingImpact(NsfwLevel.XXX, levels)).toEqual({ allowed: true, hidden: 0 });
    expect(storylineCeilingImpact(NsfwLevel.R, levels)).toEqual({ allowed: true, hidden: 1 });
    expect(storylineCeilingImpact(NsfwLevel.PG13, levels)).toEqual({ allowed: true, hidden: 2 });
  });

  test('refuses a ceiling below chapter 1, judged by its most severe image', () => {
    expect(storylineCeilingImpact(NsfwLevel.PG, levels).allowed).toBe(false);
    expect(
      storylineCeilingImpact(NsfwLevel.PG13, {
        rootNsfwLevel: NsfwLevel.PG | NsfwLevel.R,
        chapterLevels: [],
      }).allowed
    ).toBe(false);
  });

  // Must agree with the server, or the picker offers a ceiling the server refuses:
  // assertCeilingKeepsFirstChapter refuses when firstChapterFloor (the root's highest bit,
  // module-private) is above the ceiling, and getStorylineChapterLevels sends null wherever that
  // floor is null.
  test('agrees with the server floor for every ceiling and root level', () => {
    const roots = [
      NsfwLevel.PG,
      NsfwLevel.PG13,
      NsfwLevel.R,
      NsfwLevel.X,
      NsfwLevel.XXX,
      NsfwLevel.PG | NsfwLevel.R,
      NsfwLevel.PG13 | NsfwLevel.XXX,
    ];
    for (const root of roots)
      for (const ceiling of STORYLINE_CEILING_LEVELS) {
        const serverRefuses = getHighestBrowsingLevelBit(root) > ceiling;
        expect(
          storylineCeilingImpact(ceiling, { rootNsfwLevel: root, chapterLevels: [] }).allowed,
          `root ${root}, ceiling ${ceiling}`
        ).toBe(!serverRefuses);
      }
  });

  test('puts no floor under a storyline whose chapter 1 cannot be read', () => {
    expect(
      storylineCeilingImpact(NsfwLevel.PG, { rootNsfwLevel: null, chapterLevels: [] }).allowed
    ).toBe(true);
  });
});

describe('the publish plan for a storyline draft', () => {
  const open = (price: number) => ({ open: true, price, closedReason: null });
  const plan = (overrides: Partial<Parameters<typeof storylineDraftPublish>[0]> = {}) =>
    storylineDraftPublish({
      asOwner: false,
      chapterNumber: 5,
      terms: open(50),
      termsPending: false,
      ...overrides,
    });

  test('a contributor sees and sends one price', () => {
    for (const price of [0, 1, 50, 12_345]) {
      const p = plan({ terms: open(price) });
      expect(p).toMatchObject({ kind: 'contributor', expectedPrice: price });
      expect('label' in p && p.label).toBe(`Publish and submit · ${storylinePriceLabel(price)}`);
      expect(storylineExpectedPrice(p)).toBe(price);
    }
  });

  test('the owner publishes the chapter by number and sends no price', () => {
    const p = plan({ asOwner: true, terms: open(50) });
    expect([p, storylineExpectedPrice(p)]).toEqual([
      { kind: 'owner', label: 'Publish chapter 5' },
      undefined,
    ]);
  });

  test('sends nothing until the terms are read, or when they close', () => {
    for (const p of [
      plan({ termsPending: true }),
      plan({ terms: null }),
      plan({ terms: { open: false, price: 50, closedReason: 'closed' } }),
      null,
    ])
      expect(storylineExpectedPrice(p)).toBeUndefined();
  });

  test('says what a closed storyline means for the publish', () => {
    const caption = (closedReason: 'closed' | 'collaboratorsOnly' | null) =>
      storylineDraftPublishCaption({ kind: 'closed', reason: closedReason });
    expect([caption('closed'), caption('collaboratorsOnly'), caption(null)]).toEqual([
      'This storyline is closed to new chapters, so publishing posts it on its own.',
      'Only collaborators can continue this storyline, so publishing posts it on its own.',
      'This post cannot be added to the storyline, so publishing posts it on its own.',
    ]);
  });

  test('reads the new price out of a price-changed refusal', () => {
    expect(storylineChangedPrice(`${STORYLINE_REFUSALS.priceChanged}: now 60 Buzz`)).toBe(60);
    expect(storylineChangedPrice(`${STORYLINE_REFUSALS.priceChanged}: now 0 Buzz`)).toBe(0);
    expect(storylineChangedPrice(STORYLINE_REFUSALS.priceChanged)).toBeNull();
  });
});
