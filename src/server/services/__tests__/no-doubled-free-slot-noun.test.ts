import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `PlacementFreeSlotSlider` renders `Free {noun[1]} you'll accept`, so a caller
 * that passes `"free stickers"` ships **"Free free stickers you'll accept"**.
 *
 * Both callers did, and it was live on account settings and on remix gallery
 * settings until 2026-08-24 (`868kv227t`). The rendered string is asserted for
 * the sticker caller in `PlacementSpaceSection.freeSlots.browser.test.tsx` — but
 * that file is in the `component` project, which **no CI job runs**, and the
 * remix caller has no test of its own at all. This guard is what covers the
 * second caller and every caller after it.
 *
 * A source guard rather than a render, deliberately: the defect is a value at
 * the call site, and the only check that cannot be satisfied by fixing one call
 * site is one that finds them all itself.
 */
const COMPONENT = 'PlacementFreeSlotSlider';

// Four levels up from src/server/services/__tests__.
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const componentsRoot = path.join(repoRoot, 'src', 'components');

/**
 * Found by walking the tree rather than listed here.
 *
 * 🔴 A hand-written list of call sites cannot catch a call site nobody added to
 * the list, which is the same class of bug as the one being guarded.
 */
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) yield full;
  }
}

const callers = [...sourceFiles(componentsRoot)]
  .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
  .filter(
    ({ file, source }) => source.includes(`<${COMPONENT}`) && !file.endsWith(`${COMPONENT}.tsx`)
  )
  .map(({ file, source }) => ({
    file: path.relative(repoRoot, file).split(path.sep).join('/'),
    // 🔴 `String.raw`, not a plain template literal. `\s` inside a template
    // literal is just the letter "s", so the class becomes [s/>] and the count
    // comes back 0 — which reads as "no call sites" and lets the check below
    // pass. Found by running the control: it went green with a non-literal noun
    // in place.
    renders: [...source.matchAll(new RegExp(String.raw`<${COMPONENT}[\s/>]`, 'g'))].length,
    nouns: [...source.matchAll(/noun=\{\[([^\]]*)\]\}/g)].map((match) => match[1]),
  }));

describe('the free-slot slider is not told the word it already says', () => {
  /**
   * 🔴 The negative control, and the reason this file is worth having.
   *
   * A guard that finds no call sites passes forever, and it reads exactly like
   * one that found them all and approved them. If the component is renamed, the
   * prop is renamed, or the walk stops reaching `src/components`, that lands
   * here instead of in a silent green.
   */
  it('found call sites to check', () => {
    // Only that the walk found anything. Whether each call site is READABLE is
    // the next test's job — asserting it here too made the control for that one
    // fail as `expected false to be true`, naming no file.
    expect(callers.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 A call site whose `noun` is not an inline literal — `noun={NOUNS[surface]}`
   * — has nothing for the check below to read, and would be SKIPPED rather than
   * caught. That is the shape a guard goes quiet in: still green, still counting
   * the file, checking nothing in it.
   *
   * So an unreadable call site fails here instead. The remedy is to inline the
   * literal, or to assert the rendered label in a test of that caller and add it
   * to the exemption with a reason.
   */
  it('can read the noun at every call site', () => {
    const unreadable = callers
      .filter(({ renders, nouns }) => nouns.length < renders)
      .map(
        ({ file, renders, nouns }) =>
          `${file}: ${renders} render(s), ${nouns.length} inline noun literal(s)`
      );

    expect(unreadable).toEqual([]);
  });

  it('every caller passes a bare noun', () => {
    const doubled = callers.filter(({ nouns }) =>
      nouns.some((noun) => /['"]\s*free\s/i.test(noun))
    );

    // Named, so the failure says which file and which literal rather than
    // reporting that some boolean was false.
    expect(doubled.map(({ file, nouns }) => `${file}: ${nouns.join(' | ')}`)).toEqual([]);
  });
});
