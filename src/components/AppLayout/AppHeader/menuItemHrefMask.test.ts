import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * A menu row whose `href` carries a query string must not also set `as`: `as` replaces the
 * address bar, so "open in new tab" and "copy link" lose the filter ("My Bounties" opened
 * unfiltered, Freshdesk 74820). Parsed from the real `hooks.tsx`, since the menu table lives
 * inside a hook that is too heavy to mount.
 */
const source = fs.readFileSync(path.resolve(__dirname, 'hooks.tsx'), 'utf8');
const sf = ts.createSourceFile(
  'hooks.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

const rows: { href: string; hasAs: boolean }[] = [];
const visit = (node: ts.Node) => {
  if (ts.isObjectLiteralExpression(node)) {
    const names = new Map<string, ts.Expression>();
    for (const m of node.properties)
      if (ts.isPropertyAssignment(m) && ts.isIdentifier(m.name))
        names.set(m.name.text, m.initializer);
    const href = names.get('href');
    if (href) rows.push({ href: href.getText(sf), hasAs: names.has('as') });
  }
  node.forEachChild(visit);
};
visit(sf);

describe('user menu hrefs with a query string', () => {
  it('finds the menu rows, including the My Bounties filter link', () => {
    expect(rows.some((r) => r.href.includes('/bounties?engagement=favorite'))).toBe(true);
  });

  it('are not masked by an `as` path', () => {
    const masked = rows.filter((r) => r.href.includes('?') && r.hasAs).map((r) => r.href);
    expect(masked).toEqual([]);
  });
});
