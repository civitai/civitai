import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

const field = serverSchema.shape.ORCHESTRATOR_MINI_USER_IDS;

describe('ORCHESTRATOR_MINI_USER_IDS', () => {
  it('reads a list of integer ids, negatives included', () => {
    expect(field.parse('-1, 42')).toEqual([-1, 42]);
  });

  it('is empty when unset or blank', () => {
    expect(field.parse(undefined)).toEqual([]);
    expect(field.parse('')).toEqual([]);
  });

  it('drops a malformed entry on its own and keeps the rest', () => {
    expect(field.parse('-1,12x, ,0,1.5,7')).toEqual([-1, 7]);
  });
});
