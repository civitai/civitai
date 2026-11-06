import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// A bad value must fall back to the shipped cap: `src/env/server.ts` throws on an invalid field.
const field = serverSchema.shape.CDN_ACCESS_SYNC_MAX_RETRACTS_PER_RUN;

describe('CDN_ACCESS_SYNC_MAX_RETRACTS_PER_RUN', () => {
  it('reads a positive integer', () => {
    expect(field.parse('7')).toBe(7);
  });

  it.each([
    ['unset', undefined],
    ['zero', '0'],
    ['negative', '-3'],
    ['non-numeric', 'abc'],
    ['a float', '2.5'],
  ])('falls back to 15 when %s', (_label, value) => {
    expect(field.parse(value)).toBe(15);
  });
});
