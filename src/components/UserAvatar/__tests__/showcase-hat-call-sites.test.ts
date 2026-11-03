import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Which avatars wear the showcase hat is a product decision, not a size rule: the profile header, the
 * creator card (inline and hover), comment authors and the roster draw it; feed bylines, the header
 * and username spots must not. Comment avatars (26px) are smaller than some bylines, so no size
 * threshold can tell them apart, which is why it is an explicit `withShowcaseHat` per call site.
 *
 * To whoever is about to add the prop to another avatar: that widens where the hat shows, which is
 * the Team Hats lead's and product's call. Add it here only with that sign-off.
 */
const ALLOWED = [
  'src/components/CommentsV2/Comment/Comment.tsx',
  'src/components/CommentsV3/CommentItem.tsx',
  'src/components/CreatorCard/CreatorCard.tsx',
  'src/components/CreatorCard/CreatorCardSimple.tsx',
  'src/components/Profile/ProfileSidebar.tsx',
].sort();

describe('showcase hat call sites', () => {
  it('only the agreed surfaces opt in to the showcase hat', () => {
    const files = readdirSync('src', { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.tsx') && !d.name.includes('.test.'))
      .map((d) => join(d.parentPath, d.name).split('\\').join('/'))
      .filter((f) => /\bwithShowcaseHat\b/.test(readFileSync(f, 'utf8')))
      .filter((f) => f !== 'src/components/UserAvatar/UserAvatar.tsx')
      .sort();
    expect(files).toEqual(ALLOWED);
  });
});
