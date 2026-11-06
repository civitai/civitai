import { describe, it, expect } from 'vitest';
import { isLocalOrigin, outwardTrafficAllowed } from '../local-origin';

describe('isLocalOrigin', () => {
  it.each([
    'http://localhost:3000',
    'http://localhost',
    'https://localhost:3000/some/path',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://dev.localhost:3000',
    'HTTP://LOCALHOST:3000',
  ])('local: %s', (link) => {
    expect(isLocalOrigin(link)).toBe(true);
  });

  it.each([
    'https://civitai.com',
    'https://civitai.red',
    'https://staging.example.com',
    'http://localhost.evil.com',
    'http://evil.com/localhost',
    'http://notlocalhost:3000',
    'http://127.0.0.1.evil.com',
    'http://user@civitai.com@localhost.evil.com',
  ])('deployed: %s', (link) => {
    expect(isLocalOrigin(link)).toBe(false);
  });

  it('treats a missing or unparseable origin as local outside production only', () => {
    for (const link of [undefined, '', 'not a url']) {
      expect(isLocalOrigin(link, 'development')).toBe(true);
      expect(isLocalOrigin(link, 'test')).toBe(true);
      expect(isLocalOrigin(link, 'production')).toBe(false);
    }
  });
});

describe('outwardTrafficAllowed', () => {
  it('blocks a local origin by default, including in a production build', () => {
    expect(outwardTrafficAllowed('http://localhost:3000', undefined)).toBe(false);
    expect(outwardTrafficAllowed('http://localhost:3000', 'false')).toBe(false);
    expect(outwardTrafficAllowed('http://127.0.0.1:3000', '')).toBe(false);
  });

  it('lets a local origin through only on an exact opt-in', () => {
    expect(outwardTrafficAllowed('http://localhost:3000', 'true')).toBe(true);
    expect(outwardTrafficAllowed('http://localhost:3000', '1')).toBe(false);
  });

  // Positive control: the deployed case must keep sending analytics and serving ads.
  it('never blocks a deployed origin, with or without the flag', () => {
    expect(outwardTrafficAllowed('https://civitai.com', undefined)).toBe(true);
    expect(outwardTrafficAllowed('https://civitai.com', 'false')).toBe(true);
    expect(outwardTrafficAllowed('https://civitai.red', 'true')).toBe(true);
    expect(outwardTrafficAllowed(undefined, undefined, 'production')).toBe(true);
    expect(outwardTrafficAllowed(undefined, undefined, 'development')).toBe(false);
  });
});
