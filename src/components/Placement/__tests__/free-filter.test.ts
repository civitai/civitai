import { describe, expect, it } from 'vitest';
import { selectionAfterHidingFree, visibleQueueRows } from '~/components/Placement/free-filter';

const rows = [
  { id: 1, free: false },
  { id: 2, free: true },
  { id: 3, free: false },
  { id: 4, free: true },
];

describe('visibleQueueRows', () => {
  it('shows everything while free rows are shown', () => {
    expect(visibleQueueRows(rows, true).map((row) => row.id)).toEqual([1, 2, 3, 4]);
  });

  it('drops the free rows when they are hidden', () => {
    expect(visibleQueueRows(rows, false).map((row) => row.id)).toEqual([1, 3]);
  });
});

/**
 * The half that decides what a bulk Approve or Decline acts on. Both are
 * irreversible, so a selection carrying rows the filter just hid would move
 * money on placements the owner can no longer see — and the count beside the
 * buttons would still be counting them.
 */
describe('selectionAfterHidingFree', () => {
  it('keeps the paid rows and drops the free ones', () => {
    expect(selectionAfterHidingFree([1, 2, 3, 4], rows)).toEqual([1, 3]);
  });

  it('drops an id whose row is not there at all', () => {
    expect(selectionAfterHidingFree([1, 99], rows)).toEqual([1]);
  });

  it('leaves a selection of paid rows alone', () => {
    expect(selectionAfterHidingFree([3, 1], rows)).toEqual([3, 1]);
  });
});
