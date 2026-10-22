import { describe, expect, it } from 'vitest';
import { buildApprovalPayload, newAliases, readApprovalResult } from '../alias-approval';

const rule = (id: number, aliases: string[], over = {}) => ({
  id,
  subject: `Subject ${id}`,
  description: 'About',
  note: 'a note',
  aliases,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

describe('buildApprovalPayload', () => {
  it('appends the ticked aliases to each rule, against the rule as it was saved', () => {
    const payload = buildApprovalPayload([rule(3, ['Old One']), rule(4, [])], {
      3: ['New One', 'old one'],
      4: ['Fresh'],
    });
    expect(payload).toEqual([
      {
        draftId: 3,
        id: 3,
        subject: 'Subject 3',
        description: 'About',
        aliases: 'Old One\nNew One',
        note: 'a note',
        baseUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        draftId: 4,
        id: 4,
        subject: 'Subject 4',
        description: 'About',
        aliases: 'Fresh',
        note: 'a note',
        baseUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('skips rules with nothing ticked and ticks for rules that are gone', () => {
    expect(buildApprovalPayload([rule(3, []), rule(4, [])], { 3: [], 9: ['X'] })).toEqual([]);
  });

  it('skips a rule whose ticked aliases it already has', () => {
    expect(buildApprovalPayload([rule(3, ['Old One'])], { 3: ['old one'] })).toEqual([]);
  });
});

describe('newAliases', () => {
  it('counts only the ticked aliases the rule does not already have', () => {
    expect(newAliases(['Old One'], ['old one', 'New One', 'new  one'])).toEqual(['New One']);
  });
});

describe('readApprovalResult', () => {
  it('splits a mixed result into saved ids and per-rule errors', () => {
    expect(
      readApprovalResult({
        saved: [{ draftId: 3, id: 3 }],
        failed: [{ draftId: 4, error: 'Changed since.' }],
      })
    ).toEqual({ saved: [3], failed: { 4: 'Changed since.' } });
  });

  it('reads an unexpected answer as nothing saved', () => {
    expect(readApprovalResult(undefined)).toEqual({ saved: [], failed: {} });
    expect(readApprovalResult({ saved: 'x', failed: [{ draftId: 'a' }] })).toEqual({
      saved: [],
      failed: {},
    });
  });
});
