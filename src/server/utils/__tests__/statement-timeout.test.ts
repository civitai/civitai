import { describe, expect, it } from 'vitest';
import { isStatementTimeout } from '../statement-timeout';

describe('isStatementTimeout', () => {
  it('recognizes the PostgreSQL statement timeout signature', () => {
    const message = 'canceling statement due to statement timeout';
    expect(isStatementTimeout(Object.assign(new Error(message), { code: '57014' }))).toBe(true);
    expect(isStatementTimeout({ code: '57014', message })).toBe(true);
  });

  it.each([
    { code: '57014', message: 'canceling statement due to user request' },
    { code: 'XX000', message: 'statement timeout' },
    { code: 57014, message: 'statement timeout' },
    { message: 'statement timeout' },
    { code: '57014' },
    { code: '57014', message: null },
    { code: '57014', message: {} },
    new Error('statement timeout'),
    null,
    undefined,
    'statement timeout',
  ])('rejects a cancellation or unrelated error: %j', (error) => {
    expect(isStatementTimeout(error)).toBe(false);
  });
});
