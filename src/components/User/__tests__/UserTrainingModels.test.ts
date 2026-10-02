import { describe, expect, it } from 'vitest';
import { enrichTrainingData, sumBuzzByAccount } from '~/components/User/UserTrainingModels';
import type { MyTrainingModelGetAll } from '~/types/router';

describe('sumBuzzByAccount', () => {
  it('sums every debit of a colour, not just the first', () => {
    const debits = [
      { amount: 1789, accountType: 'yellow', type: 'debit' },
      { amount: 356, accountType: 'yellow', type: 'debit' },
    ];
    // Regression: .find() returned only 1789, hiding the second 356 debit.
    expect(sumBuzzByAccount(debits, 'yellow')).toBe(2145);
  });

  it('sums only the requested colour', () => {
    const txs = [
      { amount: 100, accountType: 'yellow' },
      { amount: 50, accountType: 'blue' },
      { amount: 25, accountType: 'yellow' },
    ];
    expect(sumBuzzByAccount(txs, 'yellow')).toBe(125);
    expect(sumBuzzByAccount(txs, 'blue')).toBe(50);
    expect(sumBuzzByAccount(txs, 'green')).toBeUndefined();
  });

  it('ignores transactions with no accountType', () => {
    const txs = [
      { amount: 100, accountType: null },
      { amount: 40, accountType: 'green' },
    ];
    expect(sumBuzzByAccount(txs, 'green')).toBe(40);
  });

  it('returns undefined (not 0) when there are no transactions of the colour', () => {
    // Undefined is load-bearing: the render uses `{value && <Badge/>}`, and 0 would
    // render as a literal "0" text node for every absent colour.
    expect(sumBuzzByAccount([], 'yellow')).toBeUndefined();
  });
});

function makeItem(
  transactionData: { amount: number; accountType: string; type: string }[]
): MyTrainingModelGetAll['items'][number] {
  return {
    files: [
      {
        metadata: {
          trainingResults: {
            version: 2,
            submittedAt: '2026-09-22T19:10:25.546Z',
            completedAt: '2026-09-22T23:25:56.075Z',
            workflowId: 'wf-test',
            transactionData,
          },
        },
      },
    ],
  } as unknown as MyTrainingModelGetAll['items'][number];
}

describe('enrichTrainingData cost derivation', () => {
  it('sums two same-colour debits into one Cost value', () => {
    const [row] = enrichTrainingData([
      makeItem([
        { amount: 1789, accountType: 'yellow', type: 'debit' },
        { amount: 356, accountType: 'yellow', type: 'debit' },
      ]),
    ]);
    expect(row.costInfo?.yellowBuzz).toBe(2145);
  });

  it('leaves absent colours undefined so no "0" badge renders', () => {
    const [row] = enrichTrainingData([
      makeItem([{ amount: 730, accountType: 'blue', type: 'debit' }]),
    ]);
    expect(row.costInfo?.blueBuzz).toBe(730);
    expect(row.costInfo?.yellowBuzz).toBeUndefined();
    expect(row.costInfo?.greenBuzz).toBeUndefined();
  });

  it('sums same-colour credits in the Refund value', () => {
    const [row] = enrichTrainingData([
      makeItem([
        { amount: 3809, accountType: 'blue', type: 'credit' },
        { amount: 30, accountType: 'blue', type: 'credit' },
      ]),
    ]);
    expect(row.refundInfo?.blueBuzz).toBe(3839);
    expect(row.refundInfo?.yellowBuzz).toBeUndefined();
  });
});
