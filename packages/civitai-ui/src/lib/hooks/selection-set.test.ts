import { describe, expect, it } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';
import { SelectionSet } from './selection-set.svelte';

const ORDER = [1, 2, 3, 4, 5, 6];

function setup(initial: number[] = []) {
  const selection = new SelectionSet<number>();
  for (const key of initial) selection.add(key);
  const click = (key: number, shiftKey = false) => selection.toggle(key, ORDER, shiftKey);
  const state = () => [...selection].sort((a, b) => a - b);
  return { selection, click, state };
}

describe('SelectionSet', () => {
  it('runs against the reactive client build, not the plain Set of the server build', () => {
    expect(SvelteSet).not.toBe(Set);
    expect(new SelectionSet<number>()).toBeInstanceOf(SvelteSet);
  });

  it('a plain toggle flips one key', () => {
    const { click, state } = setup();

    click(3);
    expect(state()).toEqual([3]);
    click(3);
    expect(state()).toEqual([]);
  });

  it('shift-clicking an unselected key selects the range, downward or upward', () => {
    const down = setup();
    down.click(2);
    down.click(5, true);
    expect(down.state()).toEqual([2, 3, 4, 5]);

    const up = setup();
    up.click(5);
    up.click(2, true);
    expect(up.state()).toEqual([2, 3, 4, 5]);
  });

  it('shift-clicking back to a selected key deselects the whole range', () => {
    const { click, state } = setup();

    click(1);
    click(4, true);
    click(1, true);
    expect(state()).toEqual([]);
  });

  it('the range takes the clicked key state even when the anchor was just deselected', () => {
    const { click, state } = setup([1, 2, 3, 4]);

    click(3);
    click(4);
    click(3, true);
    expect(state()).toEqual([1, 2, 3, 4]);
  });

  it('shift-clicking a selected key across a partly selected range deselects it (Gmail)', () => {
    // The one case where createSelectionStore differs: it would select 1..3 here.
    const { click, state } = setup([3]);

    click(1);
    click(3, true);
    expect(state()).toEqual([]);
  });

  it('shift-clicking an unselected key across a partly selected range selects it', () => {
    const { click, state } = setup([3]);

    click(1);
    click(4, true);
    expect(state()).toEqual([1, 2, 3, 4]);
  });

  it('deselect one key, shift-click another: the range between is deselected', () => {
    const { click, state } = setup([1, 2, 3, 4, 5, 6]);

    click(2);
    click(5, true);
    expect(state()).toEqual([1, 6]);
  });

  it('chains: the shift-clicked key becomes the anchor for the next shift toggle', () => {
    const { click, state } = setup();

    click(1);
    click(3, true);
    // Anchored at 1 instead, this would leave [3].
    click(2, true);
    expect(state()).toEqual([1]);
  });

  it('falls back to a plain toggle with no anchor, an off-page anchor, or the anchor itself', () => {
    const noAnchor = setup();
    noAnchor.click(4, true);
    expect(noAnchor.state()).toEqual([4]);

    const offPage = setup();
    offPage.selection.toggle(99, [99], false);
    offPage.click(4, true);
    expect(offPage.state()).toEqual([4, 99]);

    const self = setup();
    self.click(4);
    self.click(4, true);
    expect(self.state()).toEqual([]);
  });

  it('clear() also forgets the anchor, so an old anchor cannot start a range', () => {
    const { selection, click, state } = setup();

    click(1);
    selection.clear();
    selection.add(1);
    selection.add(4);
    // A remembered anchor at 1 would make this the range 1..3.
    click(3, true);
    expect(state()).toEqual([1, 3, 4]);
  });
});
