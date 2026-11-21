import { describe, expect, it } from 'vitest';
import { clearProfileInput } from '~/server/api-routes/mod/user/clear-profile';

// The moderator endpoint answers 400 to any input this schema refuses.
describe('user.clearProfile input', () => {
  const USER = 990400011;

  it('refuses a request that names no fields', () => {
    expect(clearProfileInput.safeParse({ userId: USER }).success).toBe(false);
  });

  it('refuses an empty field list', () => {
    expect(clearProfileInput.safeParse({ userId: USER, fields: [] }).success).toBe(false);
  });

  it('accepts a named field', () => {
    expect(clearProfileInput.safeParse({ userId: USER, fields: ['bio'] }).success).toBe(true);
  });
});
