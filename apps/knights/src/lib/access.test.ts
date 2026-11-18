import { describe, expect, it } from 'vitest';
import { decideAccess } from './access';

describe('decideAccess', () => {
  it('lets a moderator in whatever the flag says', () => {
    expect(decideAccess({ isModerator: true, flagOn: false })).toBe('allow');
    expect(decideAccess({ isModerator: true, flagOn: true })).toBe('allow');
  });

  it('lets a non-moderator in only when the flag is on for them', () => {
    expect(decideAccess({ isModerator: false, flagOn: true })).toBe('allow');
    expect(decideAccess({ isModerator: false, flagOn: false })).toBe('closed');
  });

  it('treats an unknown moderator status as not a moderator', () => {
    expect(decideAccess({ isModerator: undefined, flagOn: false })).toBe('closed');
  });
});
