import { describe, expect, it } from 'vitest';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { NsfwLevel } from '~/server/common/enums';

const OWNER = { id: 1 };
const STRANGER = { id: 2 };
const SYSTEM_HIDDEN_TAG = 500;

type Viewer = { id: number } | null;
type Kind = 'poi' | 'systemTag' | 'unrated';

const prefs = (): HiddenPreferencesState => ({
  hiddenUsers: new Map(),
  hiddenTags: new Map(),
  hiddenModels: new Map(),
  hiddenModel3Ds: new Map(),
  hiddenImages: new Map(),
  hiddenLoading: false,
  moderatedTags: [],
  systemHiddenTags: new Map([[SYSTEM_HIDDEN_TAG, true]]),
});

function run(
  type: Parameters<typeof filterPreferences>[0]['type'],
  data: unknown[],
  viewer: Viewer,
  extra: { showImageless?: boolean } = {}
) {
  return filterPreferences({
    type,
    data: data as never,
    hiddenPreferences: prefs(),
    browsingLevel: NsfwLevel.R,
    currentUser: viewer as never,
    canViewNsfw: true,
    poiDisabled: true,
    ...extra,
  }).items as Record<string, unknown>[];
}

const ids = (items: unknown[] | undefined) => ((items ?? []) as { id: number }[]).map((x) => x.id);

// Each owner-exempt filter, one image per filter. `tagKey` differs by branch: the models
// branch's child images carry `tags`, every other branch `tagIds`.
function exemptImages(userId: number | undefined, tagKey: 'tags' | 'tagIds' = 'tagIds') {
  const owner = userId === undefined ? {} : { userId };
  return [
    { id: 1, nsfwLevel: NsfwLevel.R, poi: true, ...owner },
    { id: 2, nsfwLevel: NsfwLevel.R, [tagKey]: [SYSTEM_HIDDEN_TAG], ...owner },
    { id: 3, nsfwLevel: 0, ...owner },
    // Survives every filter, so the parent row is never dropped for having no images.
    { id: 9, nsfwLevel: NsfwLevel.R },
  ];
}
const ALL_KEPT = [1, 2, 3, 9];
const NONE_KEPT = [9];

const childImageSites = {
  collections: (userId?: number) => ({
    id: 60,
    userId: OWNER.id,
    nsfwLevel: NsfwLevel.R,
    image: null,
    images: exemptImages(userId),
  }),
  bounties: (userId?: number) => ({
    id: 50,
    user: { id: OWNER.id },
    nsfwLevel: NsfwLevel.R,
    images: exemptImages(userId),
  }),
  posts: (userId?: number) => ({
    userId: OWNER.id,
    nsfwLevel: NsfwLevel.R,
    images: exemptImages(userId),
  }),
  models: (userId?: number) => ({
    id: 10,
    user: { id: OWNER.id },
    nsfwLevel: NsfwLevel.R,
    nsfw: false,
    name: 'm',
    images: exemptImages(userId, 'tags'),
  }),
} as const;

const keptChildImages = (
  type: keyof typeof childImageSites,
  userId: number | undefined,
  viewer: Viewer
) => ids(run(type, [childImageSites[type](userId)], viewer)[0]?.images as unknown[]);

describe('the owner exemption needs a signed-in viewer whose id matches', () => {
  describe.each(Object.keys(childImageSites) as (keyof typeof childImageSites)[])(
    '%s child images',
    (type) => {
      it('a signed-out viewer does not own an image with no user id', () => {
        expect(keptChildImages(type, undefined, null)).toEqual(NONE_KEPT);
      });

      it('a viewer with another id does not own an image with no user id', () => {
        expect(keptChildImages(type, undefined, STRANGER)).toEqual(NONE_KEPT);
      });

      it("the image's owner keeps every exempt image", () => {
        expect(keptChildImages(type, OWNER.id, OWNER)).toEqual(ALL_KEPT);
      });
    }
  );

  it('images feed: only a signed-in owner is exempt', () => {
    expect(ids(run('images', exemptImages(undefined), null))).toEqual(NONE_KEPT);
    expect(ids(run('images', exemptImages(OWNER.id), OWNER))).toEqual(ALL_KEPT);
  });

  // Row types declare `user.id` required, but a row that arrives without it must not make a
  // signed-out viewer its owner either.
  const userOf = (ownerId?: number) => (ownerId === undefined ? {} : { id: ownerId });
  const userIdOf = (ownerId?: number) => (ownerId === undefined ? {} : { userId: ownerId });
  const rowSites = {
    models: (kind: Kind, ownerId?: number) => ({
      id: 11,
      user: userOf(ownerId),
      nsfw: false,
      name: 'm',
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      tags: kind === 'systemTag' ? [SYSTEM_HIDDEN_TAG] : [],
      images: [{ id: 9, nsfwLevel: NsfwLevel.R }],
    }),
    articles: (kind: Kind, ownerId?: number) => ({
      id: 12,
      user: userOf(ownerId),
      userNsfwLevel: 0,
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      tags: kind === 'systemTag' ? [{ id: SYSTEM_HIDDEN_TAG }] : [],
      coverImage:
        kind === 'poi' ? { id: 120, nsfwLevel: NsfwLevel.R, tags: [], poi: true } : undefined,
    }),
    bounties: (kind: Kind, ownerId?: number) => ({
      id: 13,
      user: userOf(ownerId),
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      tags: kind === 'systemTag' ? [SYSTEM_HIDDEN_TAG] : [],
      images: [{ id: 9, nsfwLevel: NsfwLevel.R }],
    }),
    crucibles: (kind: Kind, ownerId?: number) => ({
      id: 14,
      user: userOf(ownerId),
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      tags: kind === 'systemTag' ? [SYSTEM_HIDDEN_TAG] : [],
    }),
    model3d: (kind: Kind, ownerId?: number) => ({
      id: 15,
      user: userOf(ownerId),
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      tags: kind === 'systemTag' ? [SYSTEM_HIDDEN_TAG] : [],
      poi: kind === 'poi',
    }),
    collections: (kind: Kind, ownerId?: number) => ({
      id: 17,
      ...userIdOf(ownerId),
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      image: kind === 'poi' ? { id: 170, nsfwLevel: NsfwLevel.R, poi: true } : null,
      images: [{ id: 9, nsfwLevel: NsfwLevel.R }],
    }),
    posts: (kind: Kind, ownerId?: number) => ({
      ...userIdOf(ownerId),
      nsfwLevel: kind === 'unrated' ? 0 : NsfwLevel.R,
      title: 'p',
    }),
  } as const;

  // The row-level gates each branch actually has; a gate missing here lives on child images.
  const rowKinds: Record<keyof typeof rowSites, Kind[]> = {
    models: ['systemTag', 'unrated'],
    articles: ['poi', 'systemTag', 'unrated'],
    bounties: ['systemTag', 'unrated'],
    crucibles: ['systemTag', 'unrated'],
    model3d: ['poi', 'systemTag', 'unrated'],
    collections: ['poi', 'unrated'],
    posts: ['unrated'],
  };
  const rowCases = (Object.keys(rowKinds) as (keyof typeof rowSites)[]).flatMap((type) =>
    rowKinds[type].map((kind) => [type, kind] as const)
  );

  it.each(rowCases)('%s row (%s): only a signed-in owner is exempt', (type, kind) => {
    const make = rowSites[type];
    expect(run(type, [make(kind)], null)).toHaveLength(0);
    expect(run(type, [make(kind)], STRANGER)).toHaveLength(0);
    expect(run(type, [make(kind, OWNER.id)], OWNER)).toHaveLength(1);
  });

  it('models: showImageless keeps an imageless model only for its signed-in owner', () => {
    const imageless = (ownerId?: number) => ({ ...rowSites.models('poi', ownerId), images: [] });
    expect(run('models', [imageless()], null, { showImageless: true })).toHaveLength(0);
    expect(run('models', [imageless(OWNER.id)], OWNER, { showImageless: true })).toHaveLength(1);
  });

  it('challenges: a signed-out viewer does not own a challenge with no creator id', () => {
    const challenge = (createdById?: number) => ({
      id: 16,
      nsfwLevel: NsfwLevel.X,
      allowedNsfwLevel: NsfwLevel.X,
      coverImage: null,
      ...(createdById === undefined ? {} : { createdById }),
    });
    expect(run('challenges', [challenge()], null)).toHaveLength(0);
    expect(run('challenges', [challenge(OWNER.id)], OWNER)).toHaveLength(1);
  });
});
