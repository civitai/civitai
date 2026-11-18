import { describe, expect, it } from 'vitest';

import { createSelectionStore } from '~/store/createSelectionStore';

type Item = { id: string };

const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const [a, b, c, d, e] = items;

function setup(order: Item[] = items) {
  const selection = createSelectionStore<Item>({ getKey: (item) => item.id });
  selection.actions.registerOrder('grid', order);
  const click = (item: Item, shiftKey = false) =>
    selection.actions.select(item, {
      shiftKey,
      checked: !selection.store.getState().selected[item.id],
    });
  const selectedIds = () => selection.actions.getSelected().map((item) => item.id);
  return { selection, click, selectedIds };
}

describe('createSelectionStore shift-click range', () => {
  it('selects the whole range, both ends included, in either direction', () => {
    const forward = setup();
    forward.click(b);
    forward.click(d, true);
    expect(forward.selectedIds().sort()).toEqual(['b', 'c', 'd']);

    const backward = setup();
    backward.click(d);
    backward.click(b, true);
    expect(backward.selectedIds().sort()).toEqual(['b', 'c', 'd']);
  });

  it('deselects a range that is already fully selected', () => {
    const { click, selectedIds } = setup();
    click(a);
    click(e, true);
    click(b, true);
    expect(selectedIds().sort()).toEqual(['a']);
  });

  it('chains consecutive shift-clicks from the last clicked item', () => {
    const { click, selectedIds } = setup();
    click(a);
    click(d, true);
    // Anchored at d, b..d is fully selected and toggles off; anchored at a it would drop a..b.
    click(b, true);
    expect(selectedIds().sort()).toEqual(['a']);
  });

  it('never puts an item that is not in the registered order into a range', () => {
    const { click, selectedIds } = setup([a, b, d, e]);
    click(a);
    click(e, true);
    expect(selectedIds()).not.toContain('c');
    expect(selectedIds().sort()).toEqual(['a', 'b', 'd', 'e']);
  });

  it('falls back to a single toggle when the anchor has left the order', () => {
    const { selection, click, selectedIds } = setup();
    click(a);
    selection.actions.registerOrder('grid', [b, c, d]);
    click(d, true);
    expect(selectedIds().sort()).toEqual(['a', 'd']);
  });

  it('clear drops the anchor, so the next shift-click is a single toggle', () => {
    const { selection, click, selectedIds } = setup();
    click(a);
    selection.actions.clear();
    click(c, true);
    expect(selectedIds()).toEqual(['c']);
  });
});
