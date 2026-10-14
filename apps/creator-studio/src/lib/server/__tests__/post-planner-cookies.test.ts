import { describe, expect, it } from 'vitest';
import { sessionCookies } from '../session-cookies';

const request = (cookie: string) => new Request('https://studio.test/', { headers: { cookie } });

describe('sessionCookies', () => {
  it('forwards the prefixed production session cookie and nothing else', () => {
    const cookie =
      'civitai-test-membership=gold; __Secure-civ-token=abc.def; __Secure-civ-device=dev1; other=1';
    expect(sessionCookies(request(cookie), '__Secure-civ-token')).toBe(
      '__Secure-civ-token=abc.def'
    );
  });

  it('forwards the unprefixed dev cookie by the same rule', () => {
    expect(sessionCookies(request('civ-token=abc; civ-device=d'), 'civ-token')).toBe(
      'civ-token=abc'
    );
  });

  it('forwards nothing when the session cookie is absent', () => {
    expect(sessionCookies(request('civitai-test-membership=gold'), '__Secure-civ-token')).toBe('');
  });
});
