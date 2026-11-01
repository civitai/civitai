import { describe, expect, it } from 'vitest';
import { sessionCookies } from '../session-cookies';

const request = (cookie: string) => new Request('https://studio.test/', { headers: { cookie } });

describe('sessionCookies', () => {
  it('forwards the prefixed production session and device cookies and nothing else', () => {
    const cookie =
      'civitai-test-membership=gold; __Secure-civ-token=abc.def; __Secure-civ-device=dev1; other=1';
    expect(sessionCookies(request(cookie))).toBe(
      '__Secure-civ-token=abc.def; __Secure-civ-device=dev1'
    );
  });

  it('forwards the unprefixed dev cookies by the same rule', () => {
    expect(sessionCookies(request('civ-token=abc; civ-device=d; x=1'))).toBe(
      'civ-token=abc; civ-device=d'
    );
  });

  it('does not forward look-alikes or the legacy cookie', () => {
    expect(
      sessionCookies(request('__Secure-civitai-token=legacy; civ-tokenx=1; mycivi-token=2'))
    ).toBe('');
  });

  it('forwards nothing when the session cookie is absent', () => {
    expect(sessionCookies(request('civitai-test-membership=gold'))).toBe('');
  });
});
