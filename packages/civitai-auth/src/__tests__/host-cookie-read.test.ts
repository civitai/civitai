import { afterEach, describe, expect, it } from 'vitest';
import {
  hostDeviceCookieName,
  hostSessionCookieName,
  legacyCookieReadEnabled,
  readDeviceId,
  readSessionToken,
  rollSlot,
  sessionCookieMode,
  type CookieReadOptions,
  type CookieSlot,
} from '../cookies';

const HOST = '__Host-civ-token';
const SHARED = '__Secure-civ-token';
const secure = { secure: true } satisfies CookieReadOptions;
const shared = { ...secure, mode: 'shared' } satisfies CookieReadOptions;
const host = { ...secure, mode: 'host' } satisfies CookieReadOptions;

describe('host-only cookie names', () => {
  it('uses the __Host- prefix on https and the bare name on http', () => {
    expect(hostSessionCookieName(true)).toBe(HOST);
    expect(hostSessionCookieName(false)).toBe('civ-token');
    expect(hostDeviceCookieName(true)).toBe('__Host-civ-device');
    expect(hostDeviceCookieName(false)).toBe('civ-device');
  });
});

describe('sessionCookieMode / legacyCookieReadEnabled (env)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to shared, and only the exact value host selects host', () => {
    delete process.env.AUTH_SESSION_COOKIE_MODE;
    expect(sessionCookieMode()).toBe('shared');
    process.env.AUTH_SESSION_COOKIE_MODE = 'Host';
    expect(sessionCookieMode()).toBe('shared');
    process.env.AUTH_SESSION_COOKIE_MODE = 'host';
    expect(sessionCookieMode()).toBe('host');
  });

  it('reads the shared slot unless AUTH_LEGACY_READ is explicitly false', () => {
    delete process.env.AUTH_LEGACY_READ;
    expect(legacyCookieReadEnabled()).toBe(true);
    process.env.AUTH_LEGACY_READ = 'true';
    expect(legacyCookieReadEnabled()).toBe(true);
    process.env.AUTH_LEGACY_READ = 'false';
    expect(legacyCookieReadEnabled()).toBe(false);
  });
});

// Test 14: the reader is presence-based. The mode's slot wins whenever it is present, valid or not, and the
// other slot is only a fallback when it is absent. Control: a reader that takes the mode's name only
// (`cookies[sessionCookieName()]`, today's read) returns null for the fallback cases below.
describe('readSessionToken / readDeviceId — presence-based', () => {
  it('shared mode prefers the shared slot when both are present', () => {
    expect(readSessionToken({ [SHARED]: 's', [HOST]: 'h' }, shared)).toEqual({
      value: 's',
      name: SHARED,
      slot: 'shared',
    });
  });

  it('host mode prefers the host-only slot when both are present', () => {
    expect(readSessionToken({ [SHARED]: 's', [HOST]: 'h' }, host)).toEqual({
      value: 'h',
      name: HOST,
      slot: 'host',
    });
  });

  it('shared mode falls back to the host-only slot when the shared one is absent', () => {
    expect(readSessionToken({ [HOST]: 'h' }, shared)?.slot).toBe('host');
  });

  it('host mode falls back to the shared slot when the host-only one is absent', () => {
    expect(readSessionToken({ [SHARED]: 's' }, host)?.slot).toBe('shared');
  });

  it('uses the preferred slot even when its value is stale; it never inspects validity', () => {
    const read = readSessionToken({ [HOST]: 'expired.or.revoked', [SHARED]: 'valid' }, host);
    expect(read?.value).toBe('expired.or.revoked');
  });

  it('skips the shared slot entirely when the legacy read is off', () => {
    expect(readSessionToken({ [SHARED]: 's' }, { ...host, legacyRead: false })).toBeNull();
    expect(
      readSessionToken({ [SHARED]: 's', [HOST]: 'h' }, { ...shared, legacyRead: false })?.slot
    ).toBe('host');
  });

  it('returns null with no session cookie at all', () => {
    expect(readSessionToken({ other: '1' }, host)).toBeNull();
    expect(readSessionToken(undefined, shared)).toBeNull();
  });

  it('reads the device id by the same rule', () => {
    const jar = { '__Secure-civ-device': 'D-shared', '__Host-civ-device': 'D-host' };
    expect(readDeviceId(jar, shared)?.value).toBe('D-shared');
    expect(readDeviceId(jar, host)?.value).toBe('D-host');
    expect(readDeviceId({ '__Host-civ-device': 'D-host' }, shared)?.slot).toBe('host');
  });
});

// Roll rule: write under the name the token was read from, and never copy a shared-slot token into the
// host-only slot. Tests 4 and 19 exercise it end to end in the main app; this pins the table.
describe('rollSlot', () => {
  const cases: [CookieSlot, 'shared' | 'host', CookieSlot | null][] = [
    ['shared', 'shared', 'shared'],
    ['host', 'shared', 'host'],
    ['host', 'host', 'host'],
    ['shared', 'host', null],
  ];
  it.each(cases)('a token read from %s in %s mode rolls to %s', (slot, mode, expected) => {
    expect(rollSlot({ slot }, mode)).toBe(expected);
  });
});
