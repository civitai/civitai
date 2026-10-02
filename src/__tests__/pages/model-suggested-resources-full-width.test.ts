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
    const element = ts.isJsxElement(node) ? node.openingElement : node;
    if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
      ts.forEachChild(node, (child) => visit(child, chain));
      return;
    }
    const name = element.tagName.getText();
    if (name === tag) found.push(chain);
    const inside = [...chain, name];
    visit(element.attributes, inside);
    if (ts.isJsxElement(node)) node.children.forEach((child) => visit(child, inside));
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
