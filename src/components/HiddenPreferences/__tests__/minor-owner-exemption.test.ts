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

function run<T extends 'models' | 'images' | 'collections' | 'posts' | 'bounties' | 'model3d'>(
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

  const ownersMinorImage = () => [
    { id: 90, userId: OWNER.id, nsfwLevel: NsfwLevel.R, minor: true },
  ];
  const keptImageIds = (items: unknown[]) =>
    (items as { images?: { id: number }[] }[]).flatMap((x) => ids(x.images ?? []));
  it.each([
    [
      'models',
      () => ({
        id: 11,
        user: { id: OWNER.id },
        nsfwLevel: NsfwLevel.R,
        nsfw: false,
        name: 'm',
        images: ownersMinorImage(),
      }),
    ],
    ['posts', () => ({ userId: OWNER.id, nsfwLevel: NsfwLevel.R, images: ownersMinorImage() })],
    [
      'bounties',
      () => ({
        id: 51,
        user: { id: OWNER.id },
        nsfwLevel: NsfwLevel.R,
        images: ownersMinorImage(),
      }),
    ],
  ] as const)('%s: only the owner keeps their own minor-flagged child image', (type, make) => {
    expect(keptImageIds(run(type, [make()], OWNER).items)).toEqual([90]);
    expect(keptImageIds(run(type, [make()], STRANGER).items)).toEqual([]);
  });

  it('model3d: only the owner keeps their own minor-flagged row', () => {
    const row = () => ({ id: 70, user: { id: OWNER.id }, nsfwLevel: NsfwLevel.R, minor: true });
    expect(ids(run('model3d', [row()], OWNER).items)).toEqual([70]);
    expect(ids(run('model3d', [row()], STRANGER).items)).toEqual([]);
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

  const unownedImages = () => [
    { id: 40, nsfwLevel: NsfwLevel.R, minor: true },
    { id: 41, nsfwLevel: NsfwLevel.R },
  ];
  it.each([
    ['posts', () => ({ nsfwLevel: NsfwLevel.R, images: unownedImages() })],
    [
      'bounties',
      () => ({ id: 50, user: { id: OWNER.id }, nsfwLevel: NsfwLevel.R, images: unownedImages() }),
    ],
    [
      'collections',
      () => ({
        id: 60,
        userId: OWNER.id,
        nsfwLevel: NsfwLevel.R,
        image: null,
        images: unownedImages(),
      }),
    ],
  ] as const)('%s: a signed-out viewer does not own an image with no user id', (type, make) => {
    const [kept] = run(type, [make()], null).items as { images: { id: number }[] }[];
    expect(ids(kept.images)).toEqual([41]);
  });
});
