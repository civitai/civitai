import { describe, expect, it } from 'vitest';
import type { HiddenPreferencesState } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import {
  filterPreferences,
  withoutViewerHidden,
} from '~/components/HiddenPreferences/useApplyHiddenPreferences';

// What the Flag Race's "Show anyway" may reveal: an image only the viewer's own hidden users,
// images or tags took out. A creator who blocked the viewer, and the browsing level, still hide it.

const SFW = 1;
const HID = 10; // a user the viewer hid
const BLOCKED = 11; // a user the viewer blocked
const BLOCKER = 12; // a creator who blocked the viewer
const TAG = 500;
const MATURE_TAG = 501; // a moderated tag the viewer hid

const prefs: HiddenPreferencesState = {
  hiddenUsers: new Map([
    [HID, true],
    [BLOCKED, true],
    [BLOCKER, true],
  ]),
  blockRelations: new Map([
    [BLOCKED, true],
    [BLOCKER, true],
  ]),
  blockedByUsers: new Map([[BLOCKER, true]]),
  hiddenTags: new Map([
    [TAG, true],
    [MATURE_TAG, true],
  ]),
  hiddenModels: new Map(),
  hiddenModel3Ds: new Map(),
  hiddenImages: new Map([
    [4, true],
    [8, true],
  ]),
  hiddenLoading: false,
  moderatedTags: [{ id: MATURE_TAG, name: 'mature', nsfwLevel: 4 }] as never,
  systemHiddenTags: new Map(),
  // 8 is hidden by the viewer's vote on a moderated tag they hide, not yet applied to it.
  moderatedHiddenImages: new Map([[8, true]]),
};

const image = (
  id: number,
  over: { userId?: number; tagIds?: number[]; nsfwLevel?: number } = {}
) => ({
  id,
  userId: over.userId ?? 1,
  nsfwLevel: over.nsfwLevel ?? SFW,
  tagIds: over.tagIds ?? [],
  prompt: '',
});

const images = [
  image(1, { userId: HID }),
  image(2, { userId: BLOCKED }),
  image(3, { tagIds: [TAG] }),
  image(4),
  image(5, { userId: BLOCKER }),
  image(6, { userId: HID, nsfwLevel: 4 }),
  image(7, { tagIds: [MATURE_TAG] }),
  image(8),
];

const signedIn = { signedIn: true };

const kept = (hiddenPreferences: HiddenPreferencesState) =>
  filterPreferences({
    type: 'images',
    data: images as never,
    hiddenPreferences,
    browsingLevel: SFW,
    currentUser: null as never,
    canViewNsfw: true,
  }).items.map((x) => (x as { id: number }).id);

describe('withoutViewerHidden: what Flag Race Show anyway may set aside (#10115)', () => {
  it("lets through what only the viewer's own hidden users, blocks, images and tags hid", () => {
    expect(kept(prefs)).toEqual([]);
    expect(kept(withoutViewerHidden(prefs, signedIn))).toEqual([1, 2, 3, 4]);
  });

  it('keeps a creator who blocked the viewer, and the browsing level, in force', () => {
    const shown = kept(withoutViewerHidden(prefs, signedIn));
    expect(shown).not.toContain(5);
    expect(shown).not.toContain(6);
  });

  it('keeps every block, either way, when it cannot tell who blocked whom', () => {
    expect(kept(withoutViewerHidden({ ...prefs, blockedByUsers: undefined }, signedIn))).toEqual([
      1, 3, 4,
    ]);
  });

  it("sets nothing aside for a signed-out viewer, whose hidden tags are the site's defaults", () => {
    expect(kept(withoutViewerHidden(prefs, { signedIn: false }))).toEqual([]);
  });

  it('keeps a moderated tag the viewer hid in force, while setting aside an ordinary one', () => {
    const shown = kept(withoutViewerHidden(prefs, signedIn));
    expect(shown).toContain(3);
    expect(shown).not.toContain(7);
  });

  it('keeps an image hidden by a moderated-tag vote hidden, while setting aside one hidden by hand', () => {
    const shown = kept(withoutViewerHidden(prefs, signedIn));
    expect(shown).toContain(4);
    expect(shown).not.toContain(8);
  });
});
