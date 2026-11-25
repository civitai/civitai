import { describe, expect, it } from 'vitest';

import {
  SIGNED_OUT_ROLLOUT_COOKIE,
  ensureSignedOutRolloutBucket,
  parseSignedOutRolloutBucket,
  readSignedOutRolloutBucket,
  signedOutRolloutEntity,
} from '~/shared/utils/signed-out-rollout-bucket';

describe('the signed-out rollout bucket', () => {
  it('has a fixed cookie name and entity spelling (the rollout is keyed on both)', () => {
    expect(SIGNED_OUT_ROLLOUT_COOKIE).toBe('civitai-so-bucket');
    expect(signedOutRolloutEntity(0)).toBe('signed-out-0');
    expect(signedOutRolloutEntity(437)).toBe('signed-out-437');
  });

  it('parses exactly the whole numbers 0..999', () => {
    expect(parseSignedOutRolloutBucket('0')).toBe(0);
    expect(parseSignedOutRolloutBucket('7')).toBe(7);
    expect(parseSignedOutRolloutBucket('999')).toBe(999);
    for (const bad of ['1000', '-1', '07', '4.5', '', ' 5', 'abc', '1e2', '0x10']) {
      expect(parseSignedOutRolloutBucket(bad)).toBeNull();
    }
    expect(parseSignedOutRolloutBucket(undefined)).toBeNull();
    expect(parseSignedOutRolloutBucket(null)).toBeNull();
  });

  it('reads its own cookie out of a Cookie header, and nothing else', () => {
    expect(readSignedOutRolloutBucket('a=1; civitai-so-bucket=612; b=2')).toBe(612);
    expect(readSignedOutRolloutBucket('civitai-so-bucket=41')).toBe(41);
    expect(readSignedOutRolloutBucket(['a=1', 'civitai-so-bucket=3'])).toBe(3);
    // A cookie whose name merely contains the bucket's is not it.
    expect(readSignedOutRolloutBucket('x-civitai-so-bucket=5; civitai-so-bucketx=6')).toBeNull();
    expect(readSignedOutRolloutBucket('civitai-so-bucket=1000')).toBeNull();
    expect(readSignedOutRolloutBucket('')).toBeNull();
    expect(readSignedOutRolloutBucket(undefined)).toBeNull();
  });

  it('writes a new visitor one bucket, from the random draw, for a year', () => {
    const jar = { cookie: 'other=1' };
    const written: string[] = [];
    const recording = {
      get cookie() {
        return jar.cookie;
      },
      set cookie(value: string) {
        written.push(value);
        jar.cookie = `other=1; ${value.split(';')[0]}`;
      },
    };
    expect(ensureSignedOutRolloutBucket(recording, () => 0.4371, true)).toBe(437);
    expect(written).toEqual([
      'civitai-so-bucket=437; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    ]);
    // A visitor who has one keeps it: no second write, whatever the draw.
    expect(ensureSignedOutRolloutBucket(recording, () => 0.9, true)).toBe(437);
    expect(written).toHaveLength(1);
  });

  it('replaces an invalid value, and omits Secure off https', () => {
    const jar = { cookie: 'civitai-so-bucket=abc' };
    expect(ensureSignedOutRolloutBucket(jar, () => 0.999999, false)).toBe(999);
    expect(jar.cookie).toBe('civitai-so-bucket=999; Path=/; Max-Age=31536000; SameSite=Lax');
  });

  it('does nothing without a cookie jar (on the server)', () => {
    expect(ensureSignedOutRolloutBucket(undefined)).toBeNull();
  });
});
