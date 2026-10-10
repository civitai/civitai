import { describe, expect, it } from 'vitest';
import { moderatorDbStatus, storeUnavailableMessage } from '../moderator-db-status';

describe('moderatorDbStatus', () => {
  it.each([
    [{ code: '42P01' }, 'no-schema'],
    [{ code: '42501' }, 'no-grant'],
    [new Error('MODERATOR_DATABASE_URL is not configured'), 'not-configured'],
    [{ code: '08006' }, 'unreachable'],
    [null, 'unreachable'],
  ])('%o → %s', (e, status) => {
    expect(moderatorDbStatus(e)).toBe(status);
  });
});

describe('storeUnavailableMessage', () => {
  const names = { tables: 'The x tables', database: 'the x database', schemaFile: 'x/schema.sql' };
  it('names the file to apply, and the role to apply it as, per cause', () => {
    expect(storeUnavailableMessage('no-schema', names)).toBe(
      'The x tables do not exist yet — apply x/schema.sql.'
    );
    expect(storeUnavailableMessage('no-grant', names)).toBe(
      'The x tables exist but this role cannot read them — re-run x/schema.sql as the application role.'
    );
    expect(storeUnavailableMessage('not-configured', names)).toMatch(/MODERATOR_DATABASE_URL/);
    expect(storeUnavailableMessage('unreachable', names)).toBe('Could not reach the x database.');
  });
});
