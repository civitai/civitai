import { describe, expect, it } from 'vitest';
import { profileFieldsTouchedByModerator } from '~/server/controllers/user-profile.controller';

/** A moderator's save over another user's profile archives the old text of every field it touches. */
describe('profileFieldsTouchedByModerator', () => {
  it('archives the About text when a moderator edits it', () => {
    expect(profileFieldsTouchedByModerator({ userId: 5, about: '<p>new</p>' })).toEqual(['about']);
  });

  it('counts the civitai.com copy as the field it overrides', () => {
    expect(profileFieldsTouchedByModerator({ sfwBio: 'x', sponsorshipLinks: [] })).toEqual([
      'bio',
      'links',
    ]);
  });

  it('archives nothing for a save that touches no archived field', () => {
    expect(profileFieldsTouchedByModerator({ userId: 5, badgeId: 1 })).toEqual([]);
  });
});
