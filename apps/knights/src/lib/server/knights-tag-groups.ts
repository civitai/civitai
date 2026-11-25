/**
 * Tag groups a Knights player can hide in Knights settings: an image carrying an enabled tag of a hidden group is not
 * served to them, and stays open for everyone else. Chosen from the open queue's tags and the players' comments, and
 * agreed with Moderation (2026-11-25). The main site's browsing categories are a separate list. Never a browsing level or
 * a whole kind of sexual content: Knights exists for the community to rate mature content, so it must stay served. Nor a
 * tag that only names an orientation. Never reuse a retired key (anime, political): players may still have it stored, and it
 * would hide that group again without their choosing.
 */
export const KNIGHTS_TAG_GROUPS = [
  {
    key: 'furry',
    description: 'Anthro and anthropomorphic characters',
    label: 'Furry',
    tags: [
      { id: 5139, name: 'anthro' },
      { id: 5140, name: 'furry' },
      { id: 116764, name: 'anthropomorphic' },
    ],
  },
  {
    key: 'male-focus',
    description: 'Images centred on men, including bara and yaoi',
    label: 'Male focus',
    tags: [
      { id: 114923, name: 'male focus' },
      { id: 313, name: 'bara' },
      { id: 3822, name: 'yaoi' },
    ],
  },
  {
    key: 'feet',
    description: 'Images that focus on feet',
    label: 'Feet',
    tags: [
      { id: 5311, name: 'feet' },
      { id: 137120, name: 'foot focus' },
    ],
  },
  {
    key: 'bondage',
    description: 'Restraints, bondage and BDSM',
    label: 'Bondage',
    tags: [
      { id: 511, name: 'bondage' },
      { id: 882, name: 'bdsm' },
    ],
  },
  {
    key: 'futanari',
    description: 'Futa and intersex characters',
    label: 'Futanari',
    tags: [
      { id: 279, name: 'futanari' },
      { id: 3616, name: 'futa' },
    ],
  },
  {
    key: 'gore',
    description: 'Blood, corpses, gore and body horror',
    label: 'Gore',
    tags: [
      { id: 2954, name: 'blood' },
      { id: 1282, name: 'gore' },
      { id: 122352, name: 'guro' },
      { id: 123088, name: 'corpse' },
      { id: 789, name: 'body horror' },
    ],
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
