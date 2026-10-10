import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';

/**
 * ⚠️ A TEXT PIN OVER A STYLESHEET. NOTHING HERE RENDERS OR MEASURES ANYTHING.
 *
 * `@media (pointer: coarse)` does not fire in a desktop browser narrowed to a phone width — it needs
 * real touch emulation — and this repo has no tier that renders a Svelte component at all (the
 * `component` and `geometry` browser projects are React, globbed at `src/**\/*.tsx`). So the floor is
 * asserted as ARITHMETIC OVER THE CASCADE and nothing more. What it can see: that the rules exist,
 * that they are reachable, that the numbers add up. What it CANNOT see: whether a real thumb lands on
 * a real button.
 *
 * 🔴 EVERY NUMBER IS PARSED OUT OF THE STYLESHEET, never restated beside it. The sibling
 * `two-pane-stacking.test.ts` records why: an earlier revision carried a pane width as a constant
 * here, which made it blind to the very thing its own failure message told you to change.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const CSS_PATH = path.resolve(dir, '..', 'global.css');
const css = stripComments(readFileSync(CSS_PATH, 'utf8'));

/** The WCAG 2.5.5 target size, and the only number this file is allowed to know. */
const WCAG_TARGET_PX = 44;

/**
 * The at-rules enclosing a byte offset, outermost first. A prelude is whatever sits between the last
 * block/statement boundary and the `{` that opens the block.
 *
 * This exists for one assertion — that the floor is UNLAYERED — and that assertion is the difference
 * between the floor working and the floor being inert. Tailwind v4 emits
 * `@layer theme, base, components, utilities`, so a rule inside `@layer components` loses to every
 * `utilities` rule NO MATTER ITS SPECIFICITY. Moved one block up in this file, the floor would still
 * parse, still match its elements, and do nothing at all.
 */
function enclosingAtRules(source: string, index: number): string[] {
  const stack: string[] = [];
  let segmentStart = 0;
  for (let i = 0; i < index; i++) {
    const c = source[i];
    if (c === '{') {
      stack.push(source.slice(segmentStart, i).trim().split('\n').at(-1)!.trim());
      segmentStart = i + 1;
    } else if (c === '}') {
      stack.pop();
      segmentStart = i + 1;
    } else if (c === ';') {
      segmentStart = i + 1;
    }
  }
  return stack;
}

/** The body of a block whose prelude contains `prelude`. Throws rather than returning a falsy value:
 *  an absent block must fail loudly and name itself, never let a `.includes()` below pass vacuously. */
function blockBody(source: string, prelude: string): string {
  const at = source.indexOf(prelude);
  if (at === -1) throw new Error(`no \`${prelude}\` in ${CSS_PATH}`);
  const open = source.indexOf('{', at);
  if (open === -1) throw new Error(`\`${prelude}\` opens no block in ${CSS_PATH}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`\`${prelude}\` block is never closed in ${CSS_PATH}`);
}

/** The declarations of the rule whose selector is exactly `selector`, inside `body`. */
function rule(body: string, selector: string): string {
  const match = body.match(
    new RegExp(
      `(?:^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
      'm'
    )
  );
  if (!match) throw new Error(`no rule for selector \`${selector}\``);
  return match[1];
}

/** `--touch-target-min`'s declared value, in px. */
function tokenPx(): number {
  const match = css.match(/--touch-target-min:\s*([\d.]+)px\s*;/);
  if (!match) throw new Error('`--touch-target-min` is not declared as a px length');
  return Number(match[1]);
}

const COARSE = '@media (pointer: coarse)';
const coarse = blockBody(css, COARSE);

describe('coarse-pointer touch-target floor', () => {
  // Positive control. Asserts nothing about the floor itself — a control built out of the step under
  // test is a second sample of the same unknown. This one only shows the file was read, the comment
  // strip did not eat it, and the block walker returns something to assert over.
  it('reads a non-empty stylesheet with a coarse-pointer block in it', () => {
    expect(css.length).toBeGreaterThan(400);
    expect(coarse.trim().length).toBeGreaterThan(0);
    // Comments are stripped before anything is matched, so a pin cannot pass on prose describing the
    // rule it pins. This file's own header explains the floor at length; none of it must be visible.
    expect(css).not.toContain('WCAG');
  });

  // The control for `enclosingAtRules`, run against a rule in THIS file that IS layered. Without it,
  // a walker that always returned `[]` would make the unlayered assertion below pass on nothing.
  it('the at-rule walker reports a layer when there is one', () => {
    const placeholder = css.indexOf('.placeholder');
    expect(placeholder).toBeGreaterThan(-1);
    expect(enclosingAtRules(css, placeholder)).toContain('@layer components');
  });

  it('is unlayered, so the hit-area rule outranks the primitive’s own `after:*` utilities', () => {
    const layers = enclosingAtRules(css, css.indexOf(COARSE)).filter((p) => p.startsWith('@layer'));
    expect(
      layers,
      'the coarse-pointer floor sits inside a @layer. Tailwind v4 orders `components` BEFORE ' +
        '`utilities`, so the checkbox hit-area rule loses to the primitive’s own ' +
        '`after:-inset-x-3 after:-inset-y-2` regardless of specificity, and the target stays 40x32. ' +
        '(The min-height/min-width rule would survive a layer — they are different PROPERTIES from ' +
        'the `h-*`/`size-*` utilities — so this is about the hit area specifically.)'
    ).toEqual([]);
  });

  it('declares a target size at or above the WCAG 2.5.5 floor', () => {
    expect(tokenPx()).toBeGreaterThanOrEqual(WCAG_TARGET_PX);
  });

  it('floors a marked element’s own box on BOTH axes', () => {
    // Both are load-bearing and neither implies the other: `min-height` alone leaves the four `size-*`
    // icon button variants (24-36px) narrow, `min-width` alone leaves the four `h-*` variants short.
    const declarations = rule(coarse, '[data-touch-target]');
    expect(declarations).toMatch(/min-height:\s*var\(--touch-target-min\)/);
    expect(declarations).toMatch(/min-width:\s*var\(--touch-target-min\)/);
  });

  it('gives a marked checkbox a containing block of its own', () => {
    // Without this the hit area's `inset` resolves against whatever ancestor happens to be positioned,
    // and a 44px target silently becomes a form-sized one that eats its neighbours' taps. Set here
    // rather than inherited from the primitive's `relative` token, which a `shadcn-svelte add
    // checkbox --overwrite` may drop — the package README forbids hand-editing that file.
    expect(rule(coarse, "[data-touch-target] [data-slot='checkbox']")).toMatch(
      /position:\s*relative/
    );
  });

  it('grows the checkbox hit area to the floor on both axes, derived from the token', () => {
    const declarations = rule(coarse, "[data-touch-target] [data-slot='checkbox']::after");

    // Self-sufficient: it must not depend on the generated component still spelling `after:absolute`,
    // which is what supplies `content` and `position` today.
    expect(declarations).toMatch(/content:\s*['"]{2}|content:\s*''/);
    expect(declarations).toMatch(/position:\s*absolute/);

    // 🔴 The arithmetic, re-derived rather than restated. `inset` is read out of the stylesheet and
    // evaluated against the box the primitive actually paints, so widening the visual checkbox or
    // editing the expression by hand fails here instead of quietly returning a short target.
    const inset = declarations.match(/inset:\s*([^;]+);/)?.[1].trim();
    expect(inset, 'no `inset` on the hit area').toBeTruthy();

    const token = tokenPx();
    const box = checkboxBoxPx();
    // `100%` under `inset` resolves per axis against the containing block, so one expression covers
    // both. Evaluate it the way the engine would: offset = calc((token - box) / -2), and the resulting
    // target spans box + 2 * -offset.
    const offset = evaluateInset(inset!, { token, percent: box });
    expect(box + -offset * 2).toBeGreaterThanOrEqual(WCAG_TARGET_PX);
  });
});

/**
 * The checkbox's painted size, read from the PRIMITIVE rather than from a number here: `size-4` is
 * Tailwind's 4 × 0.25rem. Read from the component so a regen that changes it fails the arithmetic
 * above rather than leaving this test agreeing with a stale figure.
 */
function checkboxBoxPx(): number {
  const source = readFileSync(
    path.resolve(
      dir,
      '../../../../packages/civitai-ui/src/lib/components/ui/checkbox/checkbox.svelte'
    ),
    'utf8'
  );
  const match = source.match(/(?:^|\s)size-(\d+(?:\.\d+)?)(?:\s|"|')/);
  if (!match) throw new Error('could not read a `size-<n>` off the checkbox primitive');
  return Number(match[1]) * 4;
}

/** Evaluates the `calc((<token> - 100%) / -2)` shape, and refuses anything else rather than guessing. */
function evaluateInset(expression: string, at: { token: number; percent: number }): number {
  const match = expression.match(
    /^calc\(\s*\(\s*var\(--touch-target-min\)\s*-\s*100%\s*\)\s*\/\s*(-?[\d.]+)\s*\)$/
  );
  if (!match) {
    throw new Error(
      `inset is \`${expression}\`, which this test cannot evaluate. It understands only ` +
        '`calc((var(--touch-target-min) - 100%) / <n>)`. Extend evaluateInset() rather than ' +
        'leaving the target size unchecked.'
    );
  }
  return (at.token - at.percent) / Number(match[1]);
}
