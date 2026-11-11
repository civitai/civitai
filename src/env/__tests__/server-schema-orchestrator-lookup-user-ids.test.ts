import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

const field = serverSchema.shape.ORCHESTRATOR_LOOKUP_USER_IDS;

describe('ORCHESTRATOR_LOOKUP_USER_IDS', () => {
  it('reads a list of integer ids', () => {
    expect(field.parse('-7, 42')).toEqual([-7, 42]);
  });

  it('is empty when unset or blank', () => {
    expect(field.parse(undefined)).toEqual([]);
    expect(field.parse('')).toEqual([]);
  });

  it('drops a malformed entry on its own and keeps the rest', () => {
    expect(field.parse('-7,12x, ,0,1.5,0x10,1e3,7')).toEqual([-7, 7]);
  });
});
