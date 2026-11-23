import { describe, expect, it } from 'vitest';
import { dbEnvSchema } from './env';

// The read retry's kill switch: an env change and a restart turn it off, no release needed.
describe('DB_READ_RETRY', () => {
  const parse = (value: string | undefined) => dbEnvSchema.shape.DB_READ_RETRY.parse(value);

  it.each(['off', 'OFF', 'false', '0', ' off '])('%j turns the retry off', (value) => {
    expect(parse(value)).toBe(false);
  });

  it.each([undefined, '', 'on', 'true', '1'])('%j leaves it on', (value) => {
    expect(parse(value)).toBe(true);
  });
});

describe('DB_READ_RETRY_BUDGET_MS', () => {
  const schema = dbEnvSchema.shape.DB_READ_RETRY_BUDGET_MS;

  it('overrides the budget with a whole number of ms', () => {
    expect(schema.parse('2500')).toBe(2500);
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it.each(['-1', '2.5', 'abc', '600000'])('rejects %j', (value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
