import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@civitai/auth';
import { canSetGenerationOnly } from '../membership';

const user = (over: Partial<SessionUser> = {}) => ({ id: 1, ...over }) as SessionUser;

describe('canSetGenerationOnly', () => {
  it('denies an anonymous caller', () => {
    expect(canSetGenerationOnly(undefined)).toBe(false);
  });

  it('allows every signed-in creator, whatever their tier', () => {
    for (const tier of [undefined, 'free', 'founder', 'bronze', 'silver', 'gold'] as const)
      expect(canSetGenerationOnly(user({ tier }))).toBe(true);
  });
});
