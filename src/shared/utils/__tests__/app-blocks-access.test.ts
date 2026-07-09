import { describe, it, expect } from 'vitest';
import { isAppDeveloper, isAppReviewer } from '~/shared/utils/app-blocks-access';

describe('isAppDeveloper', () => {
  it('returns true for a moderator', () => {
    expect(isAppDeveloper({ isModerator: true })).toBe(true);
  });

  it('returns false for a non-moderator', () => {
    expect(isAppDeveloper({ isModerator: false })).toBe(false);
  });

  it('returns false when isModerator is null', () => {
    expect(isAppDeveloper({ isModerator: null })).toBe(false);
  });

  it('returns false when isModerator is missing', () => {
    expect(isAppDeveloper({})).toBe(false);
  });

  it('returns false for null user', () => {
    expect(isAppDeveloper(null)).toBe(false);
  });

  it('returns false for undefined user', () => {
    expect(isAppDeveloper(undefined)).toBe(false);
  });

  // Developer soft-launch (Phase B): the optional `appBlocksAuthor` capability
  // widens the predicate to a curated non-mod cohort without touching mods.
  it('returns true for a non-mod when the appBlocksAuthor capability is granted', () => {
    expect(isAppDeveloper({ isModerator: false }, { appBlocksAuthor: true })).toBe(true);
  });

  it('stays false for a non-mod when the capability is not granted', () => {
    expect(isAppDeveloper({ isModerator: false }, { appBlocksAuthor: false })).toBe(false);
    expect(isAppDeveloper({ isModerator: false }, {})).toBe(false);
  });

  it('keeps moderators in as a floor even when the capability flag is false', () => {
    expect(isAppDeveloper({ isModerator: true }, { appBlocksAuthor: false })).toBe(true);
  });

  it('preserves the mod-only meaning when called with no opts (no silent widening)', () => {
    expect(isAppDeveloper({ isModerator: false })).toBe(false);
  });
});

describe('isAppReviewer', () => {
  it('returns true for a moderator', () => {
    expect(isAppReviewer({ isModerator: true })).toBe(true);
  });

  it('returns false for a non-moderator, null, and undefined', () => {
    expect(isAppReviewer({ isModerator: false })).toBe(false);
    expect(isAppReviewer({ isModerator: null })).toBe(false);
    expect(isAppReviewer({})).toBe(false);
    expect(isAppReviewer(null)).toBe(false);
    expect(isAppReviewer(undefined)).toBe(false);
  });
});
