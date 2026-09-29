import { describe, expect, it } from 'vitest';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { NsfwLevel } from '~/server/common/enums';

const OWNER = { id: 1 };
const STRANGER = { id: 2 };

const emptyPrefs = (): HiddenPreferencesState => ({
  hiddenUsers: new Map(),
  hiddenTags: new Map(),
  hiddenModels: new Map(),
  hiddenModel3Ds: new Map(),
  hiddenImages: new Map(),
  hiddenLoading: false,
  moderatedTags: [],
  systemHiddenTags: new Map(),
});

function run<T extends 'models' | 'images' | 'collections' | 'posts'>(
  type: T,
  data: unknown[],
  viewer: { id: number } | null,
  minorDisabled = true
) {
  return filterPreferences({
    type,
    data: data as never,
    hiddenPreferences: emptyPrefs(),
    browsingLevel: NsfwLevel.R,
    currentUser: viewer as never,
    canViewNsfw: true,
    minorDisabled,
  });
}

const minorModel = () => ({
  id: 10,
  user: { id: OWNER.id },
  nsfwLevel: NsfwLevel.R,
  nsfw: false,
  name: 'm',
  minor: true,
  images: [{ id: 100, userId: OWNER.id, nsfwLevel: NsfwLevel.R }],
});
const minorImage = () => ({ id: 20, userId: OWNER.id, nsfwLevel: NsfwLevel.R, minor: true });

const ids = (items: unknown[]) => (items as { id: number }[]).map((x) => x.id);

describe('minor exclusion owner exemption', () => {
  it.each([
    ['models', minorModel, 10],
    ['images', minorImage, 20],
  ] as const)('%s: the owner keeps their own minor-flagged row', (type, make, id) => {
    expect(ids(run(type, [make()], OWNER).items)).toEqual([id]);
  });

  it.each([
    ['models', minorModel],
    ['images', minorImage],
  ] as const)('%s: another viewer and a signed-out viewer still lose it', (type, make) => {
    expect(ids(run(type, [make()], STRANGER).items)).toEqual([]);
    expect(ids(run(type, [make()], null).items)).toEqual([]);
  });

  it('keeps the exclusion off entirely when the addon is off', () => {
    expect(ids(run('images', [minorImage()], STRANGER, false).items)).toEqual([20]);
  });

  it("exempts a collection's cover only when the viewer owns the image, not the collection", () => {
    const collection = {
      id: 30,
      userId: OWNER.id,
      nsfwLevel: NsfwLevel.R,
      image: { id: 300, userId: STRANGER.id, nsfwLevel: NsfwLevel.R, minor: true },
      images: [],
    };
    expect(ids(run('collections', [collection], OWNER).items)).toEqual([]);
    expect(ids(run('collections', [collection], STRANGER).items)).toEqual([30]);
  });

  /**
   * 🔴 The posts branch's `isOwner` is `image.userId === currentUser?.id`, which is
   * `undefined === undefined` for a signed-out viewer and an image without a user id. Reusing it
   * for the minor check would exempt every such image for every signed-out viewer.
   */
  it('does not treat a signed-out viewer as the owner of an image with no user id', () => {
    const post = {
      nsfwLevel: NsfwLevel.R,
      images: [
        { id: 40, nsfwLevel: NsfwLevel.R, minor: true },
        { id: 41, nsfwLevel: NsfwLevel.R },
      ],
    };
    const [kept] = run('posts', [post], null).items as { images: { id: number }[] }[];
    expect(ids(kept.images)).toEqual([41]);
  });
});
