/**
 * The preset tag groups a Knight can hide in Knights settings: an image carrying an enabled tag of a hidden group is not
 * served to them. The topics are the ones the main site lets a viewer hide (`toggleableBrowsingCategories`), kept apart
 * because Knights may offer different ones. Never a browsing level or sexual content: Knights exists for the community to
 * rate mature content, so it must stay served.
 */
export const KNIGHTS_TAG_GROUPS = [
  {
    key: 'anime',
    label: 'Anime',
    tags: [
      { id: 4, name: 'anime' },
      { id: 413, name: 'manga' },
    ],
  },
  {
    key: 'furry',
    label: 'Furry',
    tags: [
      { id: 5139, name: 'anthro' },
      { id: 5140, name: 'furry' },
    ],
  },
  {
    key: 'gore',
    label: 'Gore',
    tags: [
      { id: 1282, name: 'gore' },
      { id: 789, name: 'body horror' },
    ],
  },
  {
    key: 'political',
    label: 'Political',
    tags: [{ id: 2470, name: 'political' }],
  },
] as const;

export type KnightsTagGroupKey = (typeof KNIGHTS_TAG_GROUPS)[number]['key'];

export const isKnightsTagGroupKey = (key: string): key is KnightsTagGroupKey =>
  KNIGHTS_TAG_GROUPS.some((group) => group.key === key);

/** The tag ids of `keys`, in group order; unknown keys add nothing. */
export const tagIdsOfGroups = (keys: readonly string[]): number[] =>
  KNIGHTS_TAG_GROUPS.filter((group) => keys.includes(group.key)).flatMap((group) =>
    group.tags.map((tag) => tag.id)
  );
