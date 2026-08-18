import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 The browsing-level control in `BrowsingModeMenu` must not render where the
 * server will not honour it, and the controls beside it that DO still work must
 * stay outside that gate.
 *
 * WHY, and the part that took several review rounds to get right: where
 * `canViewNsfw` is false the picker is **wholly inert**, not merely capped.
 * `BrowsingLevelProvider` sets `domainForcedLevel = sfwBrowsingLevelsFlag` for a
 * logged-in viewer there, and `useBrowsingLevelDebounced` resolves
 * `forcedBrowsingLevel ?? browsingLevelOverride ?? userBrowsingLevel` — so the
 * stored level never reaches a query. Unticking PG-13 changes nothing either, and
 * `blurLevels` cannot compensate because it only ever carries R/X/XXX bits.
 * Attempts to keep the control and disable only the mature chips were built on the
 * belief that PG vs PG-13 stayed a live choice there. It does not.
 *
 * Measured against production, same account and query, only the host differing:
 * where the flag is false, `browsingLevel=4` and `browsingLevel=31` return an
 * identical page; where it is true they differ completely.
 *
 * 🔴 The neighbours are the easy thing to lose, and two were nearly lost in a row:
 *   - **"Apply my filters"** (`disableHidden`) is not mature content.
 *   - **"Blur mature content"** (`blurNsfw`) is read straight from the store by
 *     `BlurText` and `RenderHtml`'s profanity filter, neither of which passes
 *     through the domain-forced level — so it still has effects where the picker
 *     has none.
 * Both work on a capped domain, and the desktop header, the account page and
 * onboarding are all already gated, so this menu is their only entry point there.
 * Gating the whole component, or the whole `Stack`, silently removes them.
 *
 * 🔴 Structural, not behavioural: it proves the gate is in the tree and the two
 * controls are outside it. `test:component` runs in no CI job, so a browser test
 * would pin this for whoever runs it by hand and nothing on `main`.
 */

const FILE = path.resolve(__dirname, '../BrowsingMode.tsx');

const sf = ts.createSourceFile(
  FILE,
  fs.readFileSync(FILE, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function collect(root: ts.Node, match: (n: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (match(n)) found.push(n);
    n.forEachChild(visit);
  };
  visit(root);
  return found;
}

const mentions = (root: ts.Node, name: string) =>
  collect(root, (n) => ts.isIdentifier(n) && n.text === name).length > 0;

/**
 * Every `&&` condition guarding `<BrowsingLevelsGrouped />`, gathered by walking
 * UP from the element rather than by matching a source spelling. Reassociating the
 * operands (`a && (b && …)` vs `a && b && …`) rearranges the tree but not this set,
 * which is what makes the guard survive a behaviour-preserving refactor.
 */
function guardConditions(): ts.Expression[] {
  const picker = collect(
    sf,
    (n) =>
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === 'BrowsingLevelsGrouped'
  )[0];
  if (!picker) return [];
  const conditions: ts.Expression[] = [];
  for (let n: ts.Node | undefined = picker; n; n = n.parent) {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      conditions.push(n.left);
    }
  }
  return conditions;
}

/** A bare `x` mention, not a `!x` — an inverted gate is the precise inverse bug. */
function assertsPositively(conditions: ts.Expression[], name: string): boolean {
  return conditions.some((c) => {
    const hits = collect(c, (n) => ts.isIdentifier(n) && n.text === name) as ts.Identifier[];
    return hits.some((id) => {
      for (let n: ts.Node | undefined = id; n && n !== c.parent; n = n.parent) {
        if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken)
          return false;
      }
      return true;
    });
  });
}

/** The nearest JSX element rendering `name`, or undefined. */
function elementRendering(name: string): ts.Node | undefined {
  return collect(
    sf,
    (n) => (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && mentions(n, name)
  )[0];
}

/**
 * Every `&&` condition that must hold for `node` to render, by the same upward
 * walk as {@link guardConditions}.
 *
 * 🔴 Asking "is it inside the picker's subtree?" is NOT enough, and an earlier
 * version of this file made exactly that mistake. Giving the checkbox its own
 * `{showNsfw && features.canViewNsfw && <Checkbox …/>}` leaves it just as
 * unreachable on a capped domain while placing it OUTSIDE the picker's subtree —
 * so a containment check reports green. All four mutation controls happened to
 * move the node *into* that subtree, which is the one shape containment catches.
 * What matters is whether the flag guards it, wherever it sits.
 */
function conditionsGuarding(node: ts.Node): ts.Expression[] {
  const conditions: ts.Expression[] = [];
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      conditions.push(n.left);
    }
  }
  return conditions;
}

describe('BrowsingModeMenu gates the browsing-level control', () => {
  it('🔴 POSITIVE CONTROL: every landmark is RENDERED, not merely declared', () => {
    // `mentions(sf, 'toggleBlurNsfw')` would be satisfied by the `const` declaration
    // and `'BrowsingLevelsGrouped'` by the import line, so a file with every JSX
    // element deleted would pass. Assert the elements instead.
    expect(guardConditions().length, 'the picker is not rendered at all').toBeGreaterThan(0);
    expect(elementRendering('toggleDisableHidden'), 'filters checkbox not rendered').toBeDefined();
    expect(elementRendering('toggleBlurNsfw'), 'blur checkbox not rendered').toBeDefined();
  });

  it('renders the level picker only behind a POSITIVE canViewNsfw check', () => {
    // `!features.canViewNsfw` would satisfy a mere mention while producing the
    // precise inverse bug — shown only to viewers whose requests are clamped.
    expect(
      assertsPositively(guardConditions(), 'canViewNsfw'),
      'the picker is not guarded by an un-negated canViewNsfw — on a capped domain it is inert'
    ).toBe(true);
  });

  it.each([
    ['the hidden-tags toggle', 'toggleDisableHidden'],
    ['the blur toggle', 'toggleBlurNsfw'],
  ])('🔴 renders %s WITHOUT a canViewNsfw gate of its own', (_label, handler) => {
    const el = elementRendering(handler);
    expect(el, `${handler} is no longer rendered`).toBeDefined();
    expect(
      conditionsGuarding(el!).some((c) => mentions(c, 'canViewNsfw')),
      `${handler} is now gated on canViewNsfw — it still works on a capped domain, and this menu is its only entry point there`
    ).toBe(false);
  });
});
