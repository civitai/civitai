import { describe, expect, it } from 'vitest';
import {
  isWelcomeRequest,
  safeNext,
  showsNotFound,
  signedOutLocation,
  WELCOME_PATH,
} from './welcome';

describe('safeNext', () => {
  it.each(['/play', '/judgments?tab=mine', '/ranks#top', '/'])(
    'keeps the same-origin path %s',
    (p) => {
      expect(safeNext(p)).toBe(p);
    }
  );

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
});

describe('signedOutLocation', () => {
  const hub = 'https://auth.civitai.com/login?returnUrl=x';
  const at = (path: string, navigation = true) =>
    signedOutLocation({
      url: new URL(`https://knights.civitai.com${path}`),
      navigation,
      loginRedirect: hub,
    });

  it('sends a signed-out page load to the welcome page, remembering where it was going', () => {
    expect(at('/play')).toBe(`${WELCOME_PATH}?next=%2Fplay`);
    expect(at('/home')).toBe(`${WELCOME_PATH}?next=%2Fhome`);
    expect(at('/judgments?tab=mine')).toBe(`${WELCOME_PATH}?next=%2Fjudgments%3Ftab%3Dmine`);
  });

  it('leaves the welcome page itself bare, which would otherwise loop', () => {
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

describe('isWelcomeRequest', () => {
  const is = (path: string) => isWelcomeRequest(new URL(`https://knights.civitai.com${path}`));

  it('is the root page, with or without a query, and its client-side data request', () => {
    expect(is('/')).toBe(true);
    expect(is('/?next=%2Fplay')).toBe(true);
    expect(is('/__data.json?x-sveltekit-invalidated=1')).toBe(true);
  });

  it('is not any other page', () => {
    expect(is('/home')).toBe(false);
    expect(is('/play')).toBe(false);
    expect(is('/home/__data.json')).toBe(false);
  });
});

describe('showsNotFound', () => {
  const at = (path: string, routeId: string | null, navigation = true) =>
    showsNotFound({ url: new URL(`https://knights.civitai.com${path}`), navigation, routeId });

  it('is true for a signed-out page load that matches no route', () => {
    expect(at('/no-such-page', null)).toBe(true);
    expect(at('/no-such-page/__data.json?x-sveltekit-invalidated=1', null)).toBe(true);
  });

  it('is false for a real route, which keeps the sign-in redirect', () => {
    expect(at('/play', '/play')).toBe(false);
    expect(at('/', '/')).toBe(false);
  });

  it('is false for API and non-page requests, which keep the hub redirect', () => {
    expect(at('/api/nothing', null)).toBe(false);
    expect(at('/no-such-page', null, false)).toBe(false);
  });
});
