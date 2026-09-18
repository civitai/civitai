import { describe, expect, it } from 'vitest';

import { isResultStale } from '~/components/Buzz/CryptoDeposit/DepositHistory';

// The found row is the one that matters: a successful reconcile credits the deposit and
// invalidates the query, so the list moves underneath the result that caused it. Treat
// that as stale and the confirmation is wiped by its own refetch — which is the defect
// this whole change exists to fix (ClickUp 868m6j63r). Delete the `!found` term in
// isResultStale and that row is what turns red.

const idle = { found: false, isSuccess: false, isError: false, totalAtMutate: 0, total: 0 };

describe('isResultStale', () => {
  it.each([
    [
      'found, list moved — the confirmation must survive its own refetch',
      { ...idle, found: true, isSuccess: true, totalAtMutate: 0, total: 1 },
      false,
    ],
    [
      'found, list unchanged — reconciling an already-listed deposit adds no row',
      { ...idle, found: true, isSuccess: true, totalAtMutate: 1, total: 1 },
      false,
    ],
    [
      'nothing found, list moved — a deposit arrived after the answer',
      { ...idle, isSuccess: true, totalAtMutate: 0, total: 1 },
      true,
    ],
    [
      'nothing found, list unchanged — the answer still describes the list',
      { ...idle, isSuccess: true, totalAtMutate: 0, total: 0 },
      false,
    ],
    ['error, list moved', { ...idle, isError: true, totalAtMutate: 0, total: 1 }, true],
    [
      'error, list unchanged — persists, and outlives its minute',
      { ...idle, isError: true, totalAtMutate: 0, total: 0 },
      false,
    ],
    [
      'pending or idle — nothing to be stale about, whatever the totals say',
      { ...idle, totalAtMutate: 0, total: 9 },
      false,
    ],
  ])('%s', (_name, input, expected) => {
    expect(isResultStale(input)).toBe(expected);
  });
});
