import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { parseRemovedAppealRuling } = await import('../removed-appeals.service');

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('parseRemovedAppealRuling', () => {
  it('returns the verdict, reason, note and a trimmed message to the user', () => {
    expect(
      parseRemovedAppealRuling(
        form({
          status: 'Approved',
          resolvedReason: 'misclassified',
          internalNotes: ' checked ',
          resolvedMessage: '  Sorry  ',
        })
      )
    ).toEqual({
      status: 'Approved',
      resolvedReason: 'misclassified',
      internalNotes: 'checked',
      resolvedMessage: 'Sorry',
    });
  });

  it('treats any verdict but Approved as a rejection and an empty message as none', () => {
    const res = parseRemovedAppealRuling(
      form({ status: 'Void', resolvedReason: 'violation-confirmed', resolvedMessage: ' ' })
    );
    expect(res).toMatchObject({ status: 'Rejected', resolvedMessage: undefined });
  });

  it('caps the message at 1000 characters', () => {
    const res = parseRemovedAppealRuling(
      form({
        status: 'Approved',
        resolvedReason: 'misclassified',
        resolvedMessage: 'x'.repeat(1500),
      })
    );
    expect(typeof res === 'string' ? res : res.resolvedMessage).toHaveLength(1000);
  });

  it('answers a reason that does not fit the verdict with the message to show', () => {
    expect(typeof parseRemovedAppealRuling(form({ status: 'Approved' }))).toBe('string');
  });
});
