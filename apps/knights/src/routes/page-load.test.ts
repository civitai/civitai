import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

const run = (locals: Record<string, unknown>) => (load as unknown as (event: unknown) => unknown)({ locals });

describe('welcome page load at /', () => {
  it('sends a signed-in player to /home', () => {
    expect(() => run({ user: { id: 1 } })).toThrowError(expect.objectContaining({ status: 303, location: '/home' }));
  });

  it('hands a signed-out visitor the hub sign-in URL', () => {
    expect(run({ signInUrl: 'https://auth.civitai.com/login?returnUrl=x' })).toEqual({
      signInUrl: 'https://auth.civitai.com/login?returnUrl=x',
    });
  });

  it('falls back to / when the hook set no sign-in URL', () => {
    expect(run({})).toEqual({ signInUrl: '/' });
  });
});
