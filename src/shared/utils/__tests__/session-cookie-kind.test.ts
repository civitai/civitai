import { describe, expect, it } from 'vitest';
import { hasSessionCookie, sessionCookieKind } from '~/shared/utils/session-cookie';

// Literal cookie names as browsers send them; values are irrelevant (names only).
describe('sessionCookieKind', () => {
  it.each([
    [{ '__Secure-civ-token': 'v' }, 'civ-token'],
    [{ '__Host-civ-token': 'v' }, 'civ-token'],
    [{ 'civ-token': 'v' }, 'civ-token'],
    [{ '__Secure-civitai-token': 'v' }, 'legacy'],
    [{ 'civitai-token': 'v' }, 'legacy'],
    [{ '__Secure-civ-token': 'v', '__Secure-civitai-token': 'v' }, 'both'],
    [{ 'mantine-color-scheme': 'dark' }, 'none'],
    [{}, 'none'],
  ] as const)('%o → %s', (jar, kind) => {
    expect(sessionCookieKind(jar)).toBe(kind);
  });

  it('a missing jar is `none`', () => {
    expect(sessionCookieKind(undefined)).toBe('none');
    expect(sessionCookieKind(null)).toBe('none');
  });

  it('agrees with hasSessionCookie on every case: one definition', () => {
    for (const jar of [
      { '__Secure-civ-token': 'v' },
      { 'civitai-token': 'v' },
      { 'civ-token': 'v', 'civitai-token': 'v' },
      { other: 'v' },
      {},
    ])
      expect(sessionCookieKind(jar) !== 'none').toBe(hasSessionCookie(jar));
  });
});
