import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@civitai/auth';
import { canSetGenerationOnly } from '../membership';

const user = (over: Partial<SessionUser> = {}) => ({ id: 1, ...over }) as SessionUser;

describe('canSetGenerationOnly', () => {
  it('denies an anonymous caller', () => {
    expect(canSetGenerationOnly(undefined)).toBe(false);
  });

  it('denies a free creator', () => {
    expect(canSetGenerationOnly(user())).toBe(false);
  });

  it('denies bronze and silver', () => {
    expect(canSetGenerationOnly(user({ tier: 'bronze' }))).toBe(false);
    expect(canSetGenerationOnly(user({ tier: 'silver' }))).toBe(false);
  });

  it('allows gold', () => {
    expect(canSetGenerationOnly(user({ tier: 'gold' }))).toBe(true);
  });

  it('allows a moderator on any tier', () => {
    expect(canSetGenerationOnly(user({ isModerator: true }))).toBe(true);
  });

  it('allows an explicit generationOnlyModels grant', () => {
    expect(canSetGenerationOnly(user({ permissions: ['generationOnlyModels'] }))).toBe(true);
  });

  it('does not treat an unrelated permission as a grant', () => {
    expect(canSetGenerationOnly(user({ permissions: ['creatorsProgram'] }))).toBe(false);
  });
});
