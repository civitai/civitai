import { describe, expect, it } from 'vitest';
import type { LinkedAccountReviewConfig } from '../config';
import { buzzEdges, signIns, type ClickhousePort } from '../read';

// ClickHouse returns UInt64 aggregates as strings; compared as strings, '900' > '1000'.
const port = (rows: object[]): ClickhousePort => ({
  $query: async <T extends object>() => rows as T[],
});

describe('ClickHouse readers', () => {
  it('returns Buzz edges as numbers', async () => {
    const edges = await buzzEdges(
      port([{ sender: '11', payee: '12', amount: '900', senderTotal: '1000' }]),
      new Date(),
      {
        buzzAccountTypes: ['alpha'],
        buzzSenderMin: 1,
        buzzEdgeShare: 0.25,
      } as LinkedAccountReviewConfig
    );
    expect(edges).toEqual([{ from: 11, to: 12, amount: 900, senderTotal: 1000 }]);
  });

  it('returns sign-in account counts as numbers', async () => {
    const rows = await signIns(
      port([{ userId: '11', ip: 'x', ipAccounts: '9' }]),
      [11],
      new Date()
    );
    expect(rows).toEqual([{ userId: 11, ip: 'x', ipAccounts: 9 }]);
  });

  it('reads every user when the list spans several queries', async () => {
    const asked: number[] = [];
    const counting: ClickhousePort = {
      $query: async <T extends object>(sql: string) => {
        const ids = /userId IN \(([\d,]+)\)/.exec(sql)![1].split(',').map(Number);
        asked.push(...ids);
        return ids.map((id) => ({ userId: String(id), ip: 'x', ipAccounts: '2' })) as T[];
      },
    };
    const users = Array.from({ length: 9_001 }, (_, i) => i + 1);
    const rows = await signIns(counting, users, new Date());
    expect(asked).toEqual(users);
    expect(rows).toHaveLength(users.length);
  });
});
