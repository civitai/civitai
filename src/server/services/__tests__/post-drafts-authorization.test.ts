import { describe, expect, it } from 'vitest';
import { canSeePostDrafts } from '~/server/services/post.service';

// Who may see a creator's unpublished POSTS. The images/videos tabs gained this
// capability first (`canRequestUnpublished` in image.service.ts); without the same
// rule here a moderator saw drafts under Images and Videos on a profile and not
// under Posts — less consistent than before that change, which is the opposite of
// what it was for.
//
// Tested through the extracted predicate rather than the SQL, so it costs no
// database. The predicate is the whole authorization decision: the branch it
// selects is `publishedAt IS NULL` versus `publishedAt <= NOW()`.

const owner = { isOwnerRequest: true, isModerator: false, targetUser: 7 };
const moderator = { isOwnerRequest: false, isModerator: true, targetUser: 7 };
const stranger = { isOwnerRequest: false, isModerator: false, targetUser: 7 };

describe('canSeePostDrafts', () => {
  it('grants the creator their own drafts', () => {
    expect(canSeePostDrafts(owner)).toBe(true);
  });

  it('grants a moderator a specific creator’s drafts', () => {
    expect(canSeePostDrafts(moderator)).toBe(true);
  });

  it('REFUSES a moderator with no creator scope', () => {
    // 🔴 The one that matters. On the global posts feed there is no `username`,
    // so `targetUser` is undefined — and without this half a moderator opening
    // /posts takes the owner branch and receives every draft on the site rather
    // than a profile's worth.
    //
    // Mutate the predicate to `isOwnerRequest || isModerator` and this is the
    // only case here that fails.
    expect(canSeePostDrafts({ ...moderator, targetUser: undefined })).toBe(false);
    expect(canSeePostDrafts({ ...moderator, targetUser: null })).toBe(false);
  });

  it('REFUSES an ordinary viewer on someone else’s profile', () => {
    expect(canSeePostDrafts(stranger)).toBe(false);
  });

  it('REFUSES an anonymous viewer with no scope', () => {
    expect(
      canSeePostDrafts({ isOwnerRequest: false, isModerator: false, targetUser: undefined })
    ).toBe(false);
  });

  it('grants the creator even when the scope has not been resolved', () => {
    // The control for the moderator case above. `isOwnerRequest` is computed from
    // the username comparison directly and does not depend on the `targetUser`
    // lookup having succeeded, so requiring a scope for BOTH arms would break the
    // owner path — a plausible over-correction that this pins against.
    expect(canSeePostDrafts({ ...owner, targetUser: undefined })).toBe(true);
  });
});
