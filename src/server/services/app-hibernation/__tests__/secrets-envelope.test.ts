import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newDataKey,
  openSecrets,
  parseMasterKey,
  sealSecrets,
  unwrapDataKey,
  wrapDataKey,
} from '~/server/services/app-hibernation/secrets-envelope';

/**
 * Envelope encryption of a sleeping app's `.env*` files: a per-archive data key seals the blob,
 * the master key wraps the data key, and both bind the (user, app, attempt) they belong to.
 */

const MASTER = randomBytes(32);
const OTHER_MASTER = randomBytes(32);
const BINDING = {
  userId: 7101,
  appKey: 'tip-calculator',
  attemptId: 'a1b2c3d4-0000-4000-8000-000000000001',
};
const ENV = Buffer.from('.env\0API_TOKEN=test-only-not-a-real-token\n');

describe('secrets envelope', () => {
  it('round-trips: seal with a data key, wrap it, unwrap it, open the blob', () => {
    const dataKey = newDataKey();
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    const wrapped = wrapDataKey(MASTER, BINDING, dataKey);

    expect(sealed.toString('latin1')).not.toContain('test-only-not-a-real-token');
    expect(wrapped.startsWith('v1.')).toBe(true);
    const opened = openSecrets(unwrapDataKey(MASTER, BINDING, wrapped), BINDING, sealed);
    expect(opened.toString()).toBe(ENV.toString());
  });

  it('a wrong master key cannot unwrap the data key', () => {
    const wrapped = wrapDataKey(MASTER, BINDING, newDataKey());
    expect(() => unwrapDataKey(OTHER_MASTER, BINDING, wrapped)).toThrow();
  });

  it('a wrapped key or a blob moved to another user or app does not open', () => {
    const dataKey = newDataKey();
    const wrapped = wrapDataKey(MASTER, BINDING, dataKey);
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    expect(() => unwrapDataKey(MASTER, { ...BINDING, userId: 7102 }, wrapped)).toThrow();
    expect(() => openSecrets(dataKey, { ...BINDING, appKey: 'other-app' }, sealed)).toThrow();
  });

  it('a flipped ciphertext byte is refused, not decrypted to garbage', () => {
    const dataKey = newDataKey();
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    sealed[14] ^= 0x01;
    expect(() => openSecrets(dataKey, BINDING, sealed)).toThrow();
  });

  it('the master key must be base64 of exactly 32 bytes; anything else is unset', () => {
    expect(parseMasterKey(MASTER.toString('base64'))?.equals(new Uint8Array(MASTER))).toBe(true);
    expect(parseMasterKey(randomBytes(16).toString('base64'))).toBeNull();
    expect(parseMasterKey('not base64 at all!')).toBeNull();
    expect(parseMasterKey('   ')).toBeNull();
    expect(parseMasterKey(undefined)).toBeNull();
  });
});
