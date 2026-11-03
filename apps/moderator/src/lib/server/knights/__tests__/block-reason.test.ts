import { describe, expect, it } from 'vitest';
import { consensusBlockReason, type BlockedVote } from '../block-reason';

const vote = (
  playerId: number,
  blockReason: string | null,
  second: number,
  answer = '32'
): BlockedVote => ({
  answer,
  blockReason,
  playerId,
  createdAt: new Date(Date.UTC(2026, 11, 27, 12, 0, second)),
});

describe('consensusBlockReason', () => {
  it('takes the reason most Blocked votes gave and counts against all Blocked votes', () => {
    const votes = [
      vote(1, 'Other', 1),
      vote(2, 'DepictsRealPerson', 2),
      vote(3, 'DepictsRealPerson', 3),
      vote(4, 'DepictsRealPerson', 4),
    ];
    expect(consensusBlockReason(votes)).toEqual({
      reason: 'DepictsRealPerson',
      label: 'Depicts Real Person',
      count: 3,
      of: 4,
    });
  });

  it('breaks a tie with the reason of the earliest vote among the tied, whatever the input order', () => {
    const votes = [
      vote(3, 'Bestiality', 3),
      vote(2, 'Other', 2),
      vote(1, 'Bestiality', 5),
      vote(4, 'Other', 4),
    ];
    expect(consensusBlockReason(votes)?.reason).toBe('Other');
    expect(consensusBlockReason([...votes].reverse())?.reason).toBe('Other');
  });

  it('ignores votes that did not block, and counts reasonless Blocked votes only in the total', () => {
    const votes = [vote(1, null, 1), vote(2, 'Other', 2), vote(3, null, 3, '8')];
    expect(consensusBlockReason(votes)).toMatchObject({ reason: 'Other', count: 1, of: 2 });
  });

  it('is null when no Blocked vote carried a reason, or a reason that is not on the list', () => {
    expect(consensusBlockReason([])).toBeNull();
    expect(consensusBlockReason([vote(1, null, 1), vote(2, null, 2)])).toBeNull();
    expect(consensusBlockReason([vote(1, 'Invented', 1)])).toBeNull();
  });
});
