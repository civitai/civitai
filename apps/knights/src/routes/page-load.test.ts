import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

const run = (locals: Record<string, unknown>, next?: string) =>
  (load as unknown as (event: unknown) => unknown)({
    locals,
    url: new URL(
      `https://knights.civitai.com/${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`
    ),
  });

describe('welcome page load at /', () => {
  it('sends a signed-in player to /home', () => {
    expect(() => run({ user: { id: 1 } })).toThrowError(
      expect.objectContaining({ status: 303, location: '/home' })
    );
  });

  it('sends a signed-in player to the page they asked for in ?next=', () => {
    expect(() => run({ user: { id: 1 } }, '/judgments')).toThrowError(
      expect.objectContaining({ status: 303, location: '/judgments' })
    );
  });

  it('percent-encodes a non-ASCII next path, so the Location header stays valid', () => {
    expect(() => run({ user: { id: 1 } }, '/\u2603?q=\u00e9')).toThrowError(
      expect.objectContaining({ status: 303, location: '/%E2%98%83?q=%C3%A9' })
    );
  });

  it.each([
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '/..//evil.com',
    '/.//evil.com',
    '/a/..//evil.com',
    '/%2e%2e//evil.com',
    'judgments',
    '/',
    '/?next=%2F',
  ])('ignores an off-site or malformed next (%s) and goes to /home', (next) => {
    expect(() => run({ user: { id: 1 } }, next)).toThrowError(
      expect.objectContaining({ status: 303, location: '/home' })
    );
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
