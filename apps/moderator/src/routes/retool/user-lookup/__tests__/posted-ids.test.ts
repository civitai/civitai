import { describe, expect, it } from 'vitest';
import { postedIds } from '../posted-ids';

/**
 * The one behavioural test in this change. Everything else about the checkbox migration is a text pin
 * over source, because this repo has no tier that renders a Svelte component — so the rule that
 * decides WHICH rows a bulk Delete acts on was pulled out into a plain function precisely so it could
 * be exercised rather than asserted.
 */

const rows = (...ids: number[]) => ids.map((id) => ({ id, details: `review ${id}` }));

describe('postedIds', () => {
  it('posts exactly the selected rows', () => {
    expect(postedIds(rows(1, 2, 3, 4), new Set([2, 4]))).toEqual([2, 4]);
  });

  it('posts nothing for an empty selection', () => {
    // A bulk action over an empty payload is a no-op server-side, but the COUNT is what the operator
    // confirms against — so this also pins what ConfirmSubmit shows when nothing is ticked.
    expect(postedIds(rows(1, 2, 3), new Set())).toEqual([]);
  });

  it('drops a selected row that is no longer in the list', () => {
    // THE failure this exists for. A moderator ticks three reviews, types into the filter box, and two
    // of them leave the screen. Posting the raw selection deletes rows they can no longer see.
    //
    // 🔴 Row 7 is load-bearing and was added after a mutation run. Written as
    // `postedIds(rows(1, 3), new Set([1, 2, 3, 99]))` every row was selected, so dropping the filter
    // entirely STILL returned `[1, 3]` — the fixture could only ever produce the expected value, and
    // the mutant survived this case while four neighbouring ones caught it. An UNSELECTED row in the
    // list is what makes the narrowing observable here.
    expect(postedIds(rows(1, 3, 7), new Set([1, 2, 3, 99]))).toEqual([1, 3]);
  });

  it('orders by the rows, not by the selection', () => {
    // Deliberately distinct from the insertion order, so a mutant that returns the selection's own
    // iteration order cannot pass by coincidence.
    expect(postedIds(rows(10, 20, 30), new Set([30, 10]))).toEqual([10, 30]);
  });

  it('emits one entry per row even when the same id is offered twice', () => {
    // `getAll('reviewIds')` maps entries to ids one-for-one, so a duplicated ROW must not silently
    // become a doubled payload of a different length than the confirmed count.
    expect(postedIds(rows(5, 5, 6), new Set([5]))).toEqual([5, 5]);
  });

  it('reads membership through `has`, so a SvelteSet and a plain Set behave alike', () => {
    // The two call sites pass different things: ReviewsPanel a SelectionSet (a SvelteSet subclass),
    // CommentList a plain Set built from an array. Both satisfy `{ has }` and nothing else is used.
    const calls: number[] = [];
    const probe = {
      has: (id: number) => {
        calls.push(id);
        return id === 2;
      },
    };
    expect(postedIds(rows(1, 2, 3), probe)).toEqual([2]);
    expect(calls).toEqual([1, 2, 3]);
  });
});
