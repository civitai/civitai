import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  newDataKey,
  openSecrets,
  parseMasterKey,
  parseMasterKeys,
  sealSecrets,
  unwrapDataKey,
  wrapDataKey,
  type MasterKeyring,
} from '~/server/services/app-hibernation/secrets-envelope';

/**
 * Envelope encryption of a sleeping app's `.env*` files: a per-archive data key seals the blob,
 * the current master key wraps the data key, and both bind the (user, app, attempt) they belong
 * to. The master keys are a ring: the first wraps, every one listed can unwrap.
 */

const BINDING = {
  userId: 7101,
  appKey: 'tip-calculator',
  attemptId: 'a1b2c3d4-0000-4000-8000-000000000001',
};
const ENV = Buffer.from('.env\0API_TOKEN=test-only-not-a-real-token\n');
const K_OLD = randomBytes(32);
const K_NEW = randomBytes(32);
const K_OTHER = randomBytes(32);
const ring = (spec: string): MasterKeyring => {
  const parsed = parseMasterKeys(spec);
  if (!parsed) throw new Error(`bad ring ${spec}`);
  return parsed;
};
const b64 = (k: Buffer) => k.toString('base64');

describe('secrets envelope', () => {
  it('round-trips: seal with a data key, wrap it, unwrap it, open the blob', () => {
    const r = ring(`k1:${b64(K_OLD)}`);
    const dataKey = newDataKey();
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    const wrapped = wrapDataKey(r, BINDING, dataKey);

    expect(sealed.toString('latin1')).not.toContain('test-only-not-a-real-token');
    expect(wrapped.startsWith('v2.k1.')).toBe(true);
    const opened = openSecrets(unwrapDataKey(r, BINDING, wrapped), BINDING, sealed);
    expect(opened.toString()).toBe(ENV.toString());
  });

  it('a wrong master key cannot unwrap the data key', () => {
    const wrapped = wrapDataKey(ring(`k1:${b64(K_OLD)}`), BINDING, newDataKey());
    expect(() => unwrapDataKey(ring(`k1:${b64(K_OTHER)}`), BINDING, wrapped)).toThrow();
  });

  it('rotation: the new key wraps, and keys wrapped under the old one still unwrap', () => {
    const before = ring(`k1:${b64(K_OLD)}`);
    const dataKey = newDataKey();
    const wrappedOld = wrapDataKey(before, BINDING, dataKey);

    const after = ring(`k2:${b64(K_NEW)},k1:${b64(K_OLD)}`);
    const fresh = newDataKey();
    const wrappedNew = wrapDataKey(after, BINDING, fresh);
    expect(wrappedNew.startsWith('v2.k2.')).toBe(true);
    // Wrapped under the NEW key: it opens with the new key alone, and not with the old one.
    expect(
      unwrapDataKey(ring(`k2:${b64(K_NEW)}`), BINDING, wrappedNew).equals(new Uint8Array(fresh))
    ).toBe(true);
    expect(() => unwrapDataKey(ring(`k2:${b64(K_OLD)}`), BINDING, wrappedNew)).toThrow();
    expect(unwrapDataKey(after, BINDING, wrappedOld).equals(new Uint8Array(dataKey))).toBe(true);
  });

  it('a key id the ring does not list fails, even when another listed key exists', () => {
    const wrapped = wrapDataKey(ring(`k1:${b64(K_OLD)}`), BINDING, newDataKey());
    expect(() => unwrapDataKey(ring(`k2:${b64(K_NEW)}`), BINDING, wrapped)).toThrow(
      /unknown master key id/
    );
  });

  it('only the v2 format with a key id is read: a value without a key id is refused', () => {
    const r = ring(`k1:${b64(K_OLD)}`);
    const wrapped = wrapDataKey(r, BINDING, newDataKey());
    const body = wrapped.split('.')[2];
    expect(() => unwrapDataKey(r, BINDING, `v1.${body}`)).toThrow(/unknown wrapped-key format/);
    expect(() => unwrapDataKey(r, BINDING, `v2.${body}`)).toThrow(/unknown wrapped-key format/);
  });

  it('a wrapped key or a blob moved to another user or app does not open', () => {
    const r = ring(`k1:${b64(K_OLD)}`);
    const dataKey = newDataKey();
    const wrapped = wrapDataKey(r, BINDING, dataKey);
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    expect(() => unwrapDataKey(r, { ...BINDING, userId: 7102 }, wrapped)).toThrow();
    expect(() => openSecrets(dataKey, { ...BINDING, appKey: 'other-app' }, sealed)).toThrow();
  });

  it('a flipped ciphertext byte is refused, not decrypted to garbage', () => {
    const dataKey = newDataKey();
    const sealed = sealSecrets(dataKey, BINDING, ENV);
    sealed[14] ^= 0x01;
    expect(() => openSecrets(dataKey, BINDING, sealed)).toThrow();
  });

  it('a master key must be base64 of exactly 32 bytes; anything else is unset', () => {
    expect(parseMasterKey(b64(K_OLD))?.equals(new Uint8Array(K_OLD))).toBe(true);
    expect(parseMasterKey(randomBytes(16).toString('base64'))).toBeNull();
    expect(parseMasterKey('not base64 at all!')).toBeNull();
    expect(parseMasterKey('   ')).toBeNull();
    expect(parseMasterKey(undefined)).toBeNull();
  });

  it('the ring refuses a malformed entry, a bad key id or a repeated one as a whole', () => {
    expect(parseMasterKeys(`k1:${b64(K_OLD)}`)?.current.kid).toBe('k1');
    expect(parseMasterKeys(`k1:${b64(K_OLD)},nocolon`)).toBeNull();
    expect(parseMasterKeys(`k1:${b64(K_OLD)},k1:${b64(K_NEW)}`)).toBeNull();
    expect(parseMasterKeys(`bad.kid:${b64(K_OLD)}`)).toBeNull();
    expect(parseMasterKeys(`k1:${randomBytes(16).toString('base64')}`)).toBeNull();
    expect(parseMasterKeys('')).toBeNull();
  });
});
