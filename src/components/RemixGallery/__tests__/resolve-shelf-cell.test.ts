import { describe, expect, it } from 'vitest';
import { resolveShelfCell } from '~/components/RemixGallery/remix-flyout-layout';

type Node = { name: string; parentElement: Node | null };

/** Builds a chain outermost-first and returns it by name. */
function chain(...names: string[]) {
  const nodes: Record<string, Node> = {};
  let parent: Node | null = null;
  for (const name of names) {
    const node: Node = { name, parentElement: parent };
    nodes[name] = node;
    parent = node;
  }
  return nodes;
}

/**
 * Do not replace this with a level count. The number of boxes between the card
 * and the shelf differs per caller — the two shapes below are both live — and a
 * count that is right for one silently returns the CONTAINER for the other,
 * which lifts nothing relative to its own children.
 */
describe('resolveShelfCell', () => {
  it('returns the cosmetic wrapper where the card is the grid item (profile shelf)', () => {
    const n = chain('grid', 'wrapper', 'card');

    expect(resolveShelfCell(n.card, n.grid)?.name).toBe('wrapper');
  });

  it('returns the padding div where the caller wraps its cards (home block)', () => {
    const n = chain('grid', 'padding', 'wrapper', 'card');

    expect(resolveShelfCell(n.card, n.grid)?.name).toBe('padding');
  });

  it('never returns the clipper itself', () => {
    const shapes = [chain('grid', 'wrapper', 'card'), chain('grid', 'padding', 'wrapper', 'card')];

    for (const n of shapes) expect(resolveShelfCell(n.card, n.grid)).not.toBe(n.grid);
  });

  it('resolves the cell as a direct child of the clipper', () => {
    const n = chain('grid', 'padding', 'wrapper', 'card');

    expect(resolveShelfCell(n.card, n.grid)?.parentElement).toBe(n.grid);
  });

  it('names no cell when there is no clipper', () => {
    const n = chain('grid', 'wrapper', 'card');

    expect(resolveShelfCell(n.card, null)).toBeNull();
  });

  it('names no cell when the clipper is not an ancestor', () => {
    const n = chain('grid', 'wrapper', 'card');
    const elsewhere = chain('other')['other'];

    expect(resolveShelfCell(n.card, elsewhere)).toBeNull();
  });
});
