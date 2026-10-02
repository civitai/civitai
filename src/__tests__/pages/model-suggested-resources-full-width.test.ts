import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Inside the rail region (or any xl Container) the carousel is capped at 1320px, which fits only
// three 320px masonry columns at every viewport width, so Suggested Resources stops scaling.
const pagePath = resolve(__dirname, '../../pages/models/[id]/[[...slug]].tsx');
const source = ts.createSourceFile(
  pagePath,
  readFileSync(pagePath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function jsxAncestries(tag: string) {
  const found: string[][] = [];
  const visit = (node: ts.Node, chain: string[]) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText() === tag) found.push(chain);
    }
    const next = ts.isJsxElement(node) ? [...chain, node.openingElement.tagName.getText()] : chain;
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(source, []);
  return found;
}

describe('model page: Suggested Resources and Discussion render below the rail region', () => {
  it('Suggested Resources is not inside the rail region or any width-capped container', () => {
    expect(jsxAncestries('AssociatedModels')).toEqual([['Gated']]);
  });

  it('Discussion is below the rail region, in its own xl Container', () => {
    expect(jsxAncestries('ModelDiscussion')).toEqual([['Gated', 'Container']]);
  });
});
