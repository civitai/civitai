import { describe, it, expect } from 'vitest';
import { decodeRedisString } from '~/server/redis/buffer-decode';

describe('decodeRedisString', () => {
  it('decodes a Buffer reply to a utf8 string (HA/Sentinel case)', () => {
    const decoded = decodeRedisString(Buffer.from('Knight-4', 'utf8'));
    expect(decoded).toBe('Knight-4');
    // the operations that broke on a raw Buffer now work:
    expect(decoded === 'Knight-4').toBe(true);
    expect(() => decoded!.split('-')).not.toThrow();
  });

  it('passes a plain string through unchanged (single-node / dev)', () => {
    expect(decodeRedisString('invalid')).toBe('invalid');
  });

  it('passes null / undefined through unchanged', () => {
    expect(decodeRedisString(null)).toBeNull();
    expect(decodeRedisString(undefined)).toBeUndefined();
  });
});
