import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';

// The three fail-closed behaviours are ON unless their switch says off.
const SWITCHES = [
  'PROMPT_CHECK_FAIL_CLOSED',
  'BLOCKS_ENFORCE_GENERATION_STATUS',
  'TRAINING_STATUS_FAIL_CLOSED',
] as const;

describe.each(SWITCHES)('%s', (name) => {
  const field = serverSchema.shape[name];

  it('is ON when unset or empty', () => {
    expect(field.parse(undefined)).toBe(true);
    expect(field.parse('')).toBe(true);
  });

  it.each(['off', 'OFF', '0', 'false', 'False'])('is OFF for %j', (value) => {
    expect(field.parse(value)).toBe(false);
  });

  it.each(['on', 'true', '1', 'offf'])('stays ON for %j', (value) => {
    expect(field.parse(value)).toBe(true);
  });
});
