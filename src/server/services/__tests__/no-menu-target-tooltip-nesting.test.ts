import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SOURCE GATE — a `Tooltip` must WRAP `Menu.Target`, never sit inside it.
 *
 * WHAT BREAKS. `Menu.Target` clones its single child to attach the toggle handler
 * and its ref. `Tooltip` also clones ITS child and overrides the ref. So the
 * intuitive nesting
 *
 *     <Menu.Target>
 *       <Tooltip label="…">
 *         <ActionIcon />
 *       </Tooltip>
 *     </Menu.Target>
 *
 * hands the menu a ref to nothing, and THE TRIGGER STOPS OPENING THE DROPDOWN.
 * Nothing throws, nothing warns, the tooltip still works and the button still
 * highlights — the menu simply never mounts. Inverting the two fixes it:
 *
 *     <Tooltip label="…" withArrow>
 *       <Menu.Target>{trigger}</Menu.Target>
 *     </Tooltip>
 *
 * MEASURED, NOT REASONED. A 2x2 probe (tooltip x stopPropagation) in this exact
 * environment passed both no-tooltip arms and failed both tooltip-inside arms with
 * the dropdown never mounting; the inverted nesting passes all four. The reference
 * implementation and the long-form rationale live in
 * `src/components/Apps/AppListingActionsMenu.tsx`.
 *
 * WHY A GUARD RATHER THAN JUST THE SIX FIXES. This mistake is the one a reasonable
 * person makes: "wrap the button in a tooltip, then make it the menu target" reads
 * correctly and renders fine in review. It had been made independently at SIX sites
 * across four years of unrelated features. Fixing them without a gate just resets
 * the counter — and because the symptom is silent, the seventh would ship the same
 * way the first six did.
 *
 * WHY A SOURCE SCAN. The behavioural proof needs a real browser, and browser-mode
 * tests here run only in the label-gated `preview / component-tests` pipeline, which
 * is REPORT-ONLY and gates no merge. This file is a `.test.ts` under `src/`, so it
 * matches the `unit` project's `include` and runs in CI's `Unit tests` job — the
 * tier that can actually block. It buys blocking coverage of the *shape*; it is not
 * a claim that any particular menu opens. See the SCOPE note at the end, which is
 * deliberately specific about what this cannot see.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__screenshots__']);

/** The reference implementation. Pinned by name: if this stops matching the correct
 *  shape, the corpus-level control below is measuring nothing worth measuring. */
const REFERENCE = path.join('components', 'Apps', 'AppListingActionsMenu.tsx');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Strip comments before matching. This guard's own prose spells the forbidden
 * nesting out in full, and each of the six fixed sites now carries a comment naming
 * it too — an unstripped scan would flag the documentation describing the rule.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * From `i` (just past a tag NAME), find the index one past the `>` that closes the
 * opening tag. Skips over attribute values so a `>` inside a string or a `{…}`
 * expression cannot end the tag early — `<Tooltip label={a > b ? 'x' : 'y'}>` and
 * `<Tooltip label="a > b">` both have to resolve to the real closer.
 */
function openingTagEnd(src: string, i: number): { end: number; selfClosing: boolean } | null {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if ((c === '"' || c === "'") && depth === 0) {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === '>' && depth === 0) {
      return { end: i + 1, selfClosing: src[i - 1] === '/' };
    }
    i++;
  }
  return null;
}

/**
 * Advance past whitespace and braced JSX comments to the first thing that is
 * actually rendered. Whitespace-insensitive by construction, which is the point:
 * see the "reformatting does not walk this" fixtures below.
 */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    const rest = src.slice(i);
    const m = /^(?:\s+|\{\s*\/\*[\s\S]*?\*\/\s*\})/.exec(rest);
    if (!m) return i;
    i += m[0].length;
  }
}

const lineAt = (src: string, index: number) => src.slice(0, index).split('\n').length;

/**
 * Every `<Menu.Target>` whose first rendered child is a `<Tooltip>` — the broken
 * shape. Returns 1-based line numbers of the offending `<Menu.Target>`.
 */
function brokenNesting(source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(/<Menu\.Target\b/g)) {
    const tag = openingTagEnd(source, m.index! + m[0].length);
    if (!tag || tag.selfClosing) continue;
    if (/^<Tooltip\b/.test(source.slice(skipTrivia(source, tag.end)))) {
      hits.push(lineAt(source, m.index!));
    }
  }
  return hits;
}

/**
 * The inverse — every `<Tooltip>` whose first rendered child is a `<Menu.Target>`,
 * i.e. the CORRECT shape. This exists purely as a positive control: a scanner that
 * has silently stopped matching anything reports zero violations, which is
 * indistinguishable from a clean tree. Finding the correct shape in the real corpus
 * proves the parser can still see this construct in real code.
 */
function correctNesting(source: string): number[] {
  const hits: number[] = [];
  for (const m of source.matchAll(/<Tooltip\b/g)) {
    const tag = openingTagEnd(source, m.index! + m[0].length);
    if (!tag || tag.selfClosing) continue;
    if (/^<Menu\.Target\b/.test(source.slice(skipTrivia(source, tag.end)))) {
      hits.push(lineAt(source, m.index!));
    }
  }
  return hits;
}

const files = walk(SRC);
const sources = new Map(files.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]));

const BROKEN_FIXTURE = `
  <Menu.Target>
    <Tooltip label="More actions" withArrow>
      <ActionIcon><IconDots /></ActionIcon>
    </Tooltip>
  </Menu.Target>`;

const CORRECT_FIXTURE = `
  <Tooltip label="More actions" withArrow>
    <Menu.Target>
      <ActionIcon><IconDots /></ActionIcon>
    </Menu.Target>
  </Tooltip>`;

describe('🔴 Tooltip wraps Menu.Target, never the reverse', () => {
  it('the scan actually reached the source tree', () => {
    // A broken walker returning [] makes every assertion below vacuously green.
    // 1000 is far under the real count (~1870) and far over anything a broken glob
    // returns.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('scans only .tsx, so this .ts guard cannot match its own prose', () => {
    // The fixtures below spell the forbidden nesting out literally. That is safe
    // only while the corpus is .tsx-only; if this ever widens to .ts, the fixtures
    // must be built by interpolation instead.
    expect(files.every((f) => f.endsWith('.tsx'))).toBe(true);
  });

  describe('positive controls — the matcher can tell the two shapes apart', () => {
    it('flags the broken nesting', () => {
      expect(brokenNesting(BROKEN_FIXTURE)).toHaveLength(1);
      expect(correctNesting(BROKEN_FIXTURE)).toHaveLength(0);
    });

    it('does NOT flag the correct nesting', () => {
      expect(brokenNesting(CORRECT_FIXTURE)).toHaveLength(0);
      expect(correctNesting(CORRECT_FIXTURE)).toHaveLength(1);
    });

    /**
     * 🔴 Reformatting does not walk this guard. The obvious evasion for a
     * line-oriented scanner — putting the `<Tooltip` on the same line as the
     * `<Menu.Target>` — is caught, because the walk skips whitespace rather than
     * reading "the next line". Asserted rather than claimed.
     */
    it('catches the broken nesting written on one line', () => {
      expect(
        brokenNesting(`<Menu.Target><Tooltip label="x"><ActionIcon /></Tooltip></Menu.Target>`)
      ).toHaveLength(1);
    });

    it('catches it through an intervening JSX comment', () => {
      expect(
        brokenNesting(`<Menu.Target>\n  {/* why */}\n  <Tooltip label="x"><b /></Tooltip>`)
      ).toHaveLength(1);
    });

    it('is not fooled by a > inside an attribute value', () => {
      // Without the quote/brace skipping in openingTagEnd, the tag would "close"
      // at the > inside the attribute and the child check would read the wrong text.
      expect(
        brokenNesting(
          `<Menu.Target data-x={a > b} title="a > b"><Tooltip label="y"><b /></Tooltip>`
        )
      ).toHaveLength(1);
      expect(
        correctNesting(`<Tooltip label={a > b ? 'x' : 'y'}><Menu.Target><b /></Menu.Target>`)
      ).toHaveLength(1);
    });

    it('does not flag a Menu.Target whose child is anything else', () => {
      expect(brokenNesting(`<Menu.Target><ActionIcon /></Menu.Target>`)).toHaveLength(0);
      expect(brokenNesting(`<Menu.Target>{trigger}</Menu.Target>`)).toHaveLength(0);
      expect(brokenNesting(`<Menu.Target><TooltipLikeThing /></Menu.Target>`)).toHaveLength(0);
    });

    it('the comment stripper leaves real code intact', () => {
      const commented = `// <Menu.Target><Tooltip label="x">`;
      expect(stripComments(`${commented}\nconst a = 1;`)).toContain('const a = 1;');
      expect(brokenNesting(stripComments(commented))).toHaveLength(0);
    });
  });

  describe('positive control — the correct shape is still visible in the real corpus', () => {
    /**
     * A LOWER BOUND, not an exact set. An exact list would go red every time
     * somebody legitimately writes a new tooltipped menu trigger, and a
     * permanently-red gate is worse than no gate. The bound only has to be high
     * enough that a scanner wired to nothing cannot clear it.
     */
    it('finds the correct nesting at several real call sites', () => {
      const sites = [...sources.entries()].flatMap(([file, source]) =>
        correctNesting(source).map((line) => `${path.relative(SRC, file)}:${line}`)
      );
      expect(
        sites.length,
        'the scanner no longer recognises Tooltip > Menu.Target anywhere in src/ — ' +
          'a zero-violation result below would therefore prove nothing'
      ).toBeGreaterThanOrEqual(4);
    });

    it('the reference implementation is one of them', () => {
      // Pins a specific, stable file rather than only a count, so the bound above
      // cannot be satisfied by matches that have drifted to some unrelated shape.
      const source = sources.get(path.join(SRC, REFERENCE));
      expect(source, `${REFERENCE} has moved — repoint REFERENCE`).toBeDefined();
      expect(correctNesting(source!).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('no Menu.Target in src/ has a Tooltip as its child', () => {
    const offenders = [...sources.entries()].flatMap(([file, source]) =>
      brokenNesting(source).map((line) => `${path.relative(SRC, file)}:${line}`)
    );

    expect(
      offenders.sort(),
      'A Tooltip INSIDE Menu.Target steals the ref the menu needs, and the trigger ' +
        'silently stops opening the dropdown. Invert them — put the Tooltip on the ' +
        'outside: <Tooltip …><Menu.Target>{trigger}</Menu.Target></Tooltip>. ' +
        'See src/components/Apps/AppListingActionsMenu.tsx.'
    ).toEqual([]);
  });
});

/**
 * 🔴 SCOPE, stated honestly — this is a source-text scan, not a behavioural test,
 * and not a type-aware one.
 *
 * It CANNOT see:
 *   - INDIRECTION. `const trigger = <Tooltip>…</Tooltip>` followed by
 *     `<Menu.Target>{trigger}</Menu.Target>` is the same defect and reads as clean
 *     here, because the child is an expression. This is the real hole.
 *   - A WRAPPER COMPONENT that renders a Tooltip internally
 *     (`<Menu.Target><MyTooltippedButton /></Menu.Target>`).
 *   - JSX outside `src/**` + `.tsx` — `packages/`, `apps/`, or a shared component
 *     imported from a workspace package.
 *
 * It is NOT walkable by reformatting: whitespace, line breaks and JSX comments are
 * all skipped, and each of those has a fixture above.
 *
 * WHY NOT AN ESLINT RULE. A custom rule in `eslint-local-rules.js` would be the
 * structurally correct version — it reads a real AST, so it is immune to every
 * text-level concern above and would report at the exact node. Two reasons it is
 * not what shipped here: ESLint is not in the blocking merge gate the way the
 * `unit` project is, so the rule would enforce less than this file does; and it
 * would NOT close the indirection hole either, since following `{trigger}` back to
 * its declaration needs scope/type analysis that a lint rule does not do by
 * default. An AST rule is a genuine improvement on precision, not on coverage —
 * worth doing, but it is not the difference between airtight and leaky, and this
 * file should not be read as either.
 *
 * SCOPED TO `Menu.Target` DELIBERATELY. `Popover.Target` clones its child the same
 * way and there are several `Popover.Target > Tooltip` sites in the tree, but that
 * combination has NOT been probed in a browser here — Popover's trigger semantics
 * differ, and flagging it on the strength of an analogy would be asserting a defect
 * nobody has observed. Widen this only after measuring it.
 */
