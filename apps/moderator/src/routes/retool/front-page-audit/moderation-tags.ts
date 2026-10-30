/**
 * Retool's `TagData` — the curated moderation-tag palette the sweep offers on every card, so a
 * moderator can add a tag the auto-tagger missed rather than only voting on ones already there.
 *
 * Ids are Retool's, verbatim. `nsfwLevel` is the level the tag implies, which is what Retool logged
 * alongside the vote; it is shown so the moderator can see what adding the tag argues for.
 *
 * Page-local, not `$lib`: only this sweep renders it, and a component importing `$lib/server/*` would
 * drag the database client into the client bundle.
 */
export type ModerationTag = { id: number; name: string; nsfwLevel: number };

export const TAG_CATEGORIES: { key: string; label: string; tags: ModerationTag[] }[] = [
  {
    key: 'adult',
    label: 'Adult',
    tags: [
      { id: 2013, name: 'Nudity', nsfwLevel: 8 },
      { id: 112481, name: 'Male Explicit Nudity', nsfwLevel: 8 },
      { id: 112683, name: 'Female Explicit Nudity', nsfwLevel: 8 },
      { id: 111991, name: 'Sexual Acts', nsfwLevel: 16 },
      { id: 2561, name: 'Vore', nsfwLevel: 16 },
    ],
  },
  {
    key: 'suggestive',
    label: 'Suggestive',
    tags: [
      { id: 6924, name: 'Sexy Attire', nsfwLevel: 2 },
      { id: 111755, name: 'Suggestive', nsfwLevel: 2 },
      { id: 111969, name: 'Male Swimwear or Underwear', nsfwLevel: 4 },
      { id: 112070, name: 'Female Swimwear or Underwear', nsfwLevel: 4 },
      { id: 111942, name: 'Partial Nudity', nsfwLevel: 4 },
      { id: 112944, name: 'Sexual Situations', nsfwLevel: 4 },
    ],
  },
  {
    key: 'violence',
    label: 'Violence',
    tags: [
      { id: 113675, name: 'Physical Violence', nsfwLevel: 2 },
      { id: 111901, name: 'Graphic Violence or Gore', nsfwLevel: 4 },
    ],
  },
  {
    key: 'extra',
    label: 'Extra',
    tags: [
      { id: 112909, name: 'Explosions and Blasts', nsfwLevel: 1 },
      { id: 113487, name: 'Corpses', nsfwLevel: 2 },
      { id: 112783, name: 'Emaciated Bodies', nsfwLevel: 4 },
      { id: 112512, name: 'Middle Finger', nsfwLevel: 1 },
      { id: 126846, name: 'Disturbing', nsfwLevel: 4 },
      { id: 113360, name: 'Adult Products', nsfwLevel: 8 },
    ],
  },
];
