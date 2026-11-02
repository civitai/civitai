import { describe, expect, it } from 'vitest';
import { safeNext, signedOutLocation, WELCOME_PATH } from './welcome';

describe('safeNext', () => {
  it.each(['/play', '/judgments?tab=mine', '/ranks#top', '/'])('keeps the same-origin path %s', (p) => {
    expect(safeNext(p)).toBe(p);
  });

  it.each([
    '//evil.com',
    '//evil.com/play',
    'https://evil.com',
    'http://evil.com/play',
    '/\\evil.com',
    '\\\\evil.com',
    '/\\/evil.com',
    'javascript:alert(1)',
    'play',
    '',
    '/%0d%0aSet-Cookie:x=1',
    '/ok\nbad',
    '/ok\tbad',
    '/\t/evil.com',
  ])('falls back to / for %j', (p) => {
    expect(safeNext(p)).toBe('/');
  });

  it('falls back to / when there is no value', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });

  it('never returns the welcome page itself, which would loop', () => {
    expect(safeNext('/welcome')).toBe('/');
    expect(safeNext('/welcome?next=/play')).toBe('/');
  });
});

describe('signedOutLocation', () => {
  const hub = 'https://auth.civitai.com/login?returnUrl=x';
  const at = (path: string, navigation = true) =>
    signedOutLocation({ url: new URL(`https://knights.civitai.com${path}`), navigation, loginRedirect: hub });

  it('sends a signed-out page load to the welcome page, remembering where it was going', () => {
    expect(at('/play')).toBe(`${WELCOME_PATH}?next=%2Fplay`);
    expect(at('/judgments?tab=mine')).toBe(`${WELCOME_PATH}?next=%2Fjudgments%3Ftab%3Dmine`);
  });

  it('sends the home page to a bare welcome page', () => {
    expect(at('/')).toBe(WELCOME_PATH);
  });

  it('leaves API requests and non-page requests on the hub redirect', () => {
    expect(at('/api/anything')).toBe(hub);
    expect(at('/play', false)).toBe(hub);
  });

  it('remembers the page, not the SvelteKit data URL, for a client-side navigation', () => {
    expect(at('/play/__data.json?x-sveltekit-invalidated=01')).toBe(`${WELCOME_PATH}?next=%2Fplay`);
  });
});
