import { describe, expect, it } from 'vitest';
import { describeEvidence, parseLinkEvidence } from '../evidence';

const names: Record<number, string> = { 1: 'alpha', 2: 'beta', 3: 'gamma', 9: 'sink' };
const name = (id: number) => names[id] ?? `#${id}`;

describe('describeEvidence', () => {
  it('names the accounts, the Buzz moved and what they share', () => {
    const lines = describeEvidence(
      {
        sinks: [{ sinkId: 9, feederIds: [1, 2, 3], tipCount: 12, amount: 3400, burst: true }],
        ipLinks: [{ userIds: [1, 2], sharedIps: 1 }],
        createdTogether: [[1, 2, 3]],
      },
      name
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('alpha, beta and gamma tipped sink 12 times');
    expect(lines[0]).toContain('3,400 Buzz');
    expect(lines[1]).toContain('alpha and beta used 1 address');
    expect(lines[2]).toContain('alpha, beta and gamma were created');
  });

  it('falls back to ids for unknown accounts and tolerates a malformed payload', () => {
    expect(parseLinkEvidence({ sinks: 'nope' })).toEqual({
      sinks: [],
      ipLinks: [],
      createdTogether: [],
    });
    expect(parseLinkEvidence(null)).toEqual({ sinks: [], ipLinks: [], createdTogether: [] });
    expect(
      describeEvidence(
        { sinks: [], ipLinks: [{ userIds: [7, 8], sharedIps: 2 }], createdTogether: [] },
        name
      )[0]
    ).toContain('#7 and #8');
  });

  it('lists a repeated created-together run once', () => {
    const lines = describeEvidence(
      {
        sinks: [],
        ipLinks: [],
        createdTogether: [
          [1, 2],
          [1, 2],
          [2, 3],
        ],
      },
      name
    );

    expect(lines).toEqual([
      'alpha and beta were created within moments of each other.',
      'beta and gamma were created within moments of each other.',
    ]);
  });
});
