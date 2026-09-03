import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A PUBLISHER-CONTROLLED LABEL IN THE APP-BLOCK CHROME MUST BE HELD TO ONE LINE.
 * Node `unit` project — the tier that EXECUTES this assertion (report-only on a
 * pull request, an honest verdict on a push to `main`). The rendered proof lives in
 * `AppBlockChromeRecentsClamp.browser.test.tsx`, in the REPORT-ONLY browser tier.
 * NEITHER TIER BLOCKS A MERGE: `main` requires no status check at all in this repo,
 * so this is a signal a reviewer must read, not a door that stays shut.
 *
 * WHAT BROKE. F3 consolidated the chrome's two dropdowns and its bottom sheets onto
 * one primitive (`ChromeSurface`). Its sheet row wraps children in
 * `<Text size="sm" lineClamp={1}>`; its menu item rendered them RAW. That is correct
 * for the six host-authored labels ("Marketplace", "Manage apps", …), which were raw
 * children before the primitive existed — and wrong for the "Recently run" app name,
 * which the pre-primitive chrome wrapped in exactly that `Text`, with the comment
 * "`lineClamp={1}` keeps a pathologically long name from blowing out the dropdown at
 * ANY of its widths". The consolidation dropped it on the desktop path only, and
 * nothing noticed: the whole node `unit` tier and all seven touched browser suites stayed
 * green. Measured at 1440×900 with a 63-char name (`APP_CHROME_NAME_MAX` is 64), the
 * row went 35px → 78px — three lines — ×`RECENTLY_RUN_LIMIT` = 5. (The audit reported
 * 33.6 → 56.7 for the same defect with a shorter fixture; the gap is the name length,
 * not a disagreement.)
 *
 * 🔴 THE RULE IS KEYED ON THE DATA, NOT ON A LAYOUT PREFERENCE, AND THAT IS WHAT MAKES
 * IT A RELATIONSHIP RATHER THAN A SPELLING. `sanitizeAppChromeName` is this repo's
 * marker for "this string came from a publisher and is being laundered before it is
 * rendered" — every spoof-proof label in the chrome goes through it, and nothing else
 * does. So the invariant is: an item whose children pass through that sanitizer
 * carries `clamp`. A future publisher-controlled row cannot be added without either
 * tripping this or skipping the sanitizer, and skipping the sanitizer is a louder
 * defect with its own guard (`appChromeName.test.ts`).
 *
 * A presence check ("some item carries `clamp`") would have been walkable by adding a
 * second unclamped publisher label beside the first, so the check is over the SET.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const SURFACE = path.join(REPO_ROOT, 'src/components/AppBlocks/ChromeSurface.tsx');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent file
  // reports zero of everything, which reads as a clean pass.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Strip JSX comments whole (braces included), then block and line comments. Every
 * token searched for below is also discussed at length in the prose around it —
 * including, in the chrome, a comment that names `clamp` and one that names
 * `sanitizeAppChromeName` — so a rule must never be satisfiable by prose ABOUT the
 * rule. Leaving the `{}` of a JSX comment behind would also glue an empty expression
 * into the element's children and corrupt the parse.
 */
function code(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every `<ChromeSurfaceItem …>children</ChromeSurfaceItem>` as `{ head, children }`. */
function items(src: string): Array<{ head: string; children: string }> {
  return [...src.matchAll(/<ChromeSurfaceItem\b([\s\S]*?)<\/ChromeSurfaceItem>/g)].map((m) => {
    const block = m[1];
    // The opening tag's `>` is the first one at brace depth 0 — `leftSection={<Icon
    // … />}` contains a `>` that is NOT the end of the tag, so a naive `indexOf('>')`
    // truncates the item and loses the children entirely.
    let depth = 0;
    let tagEnd = -1;
    for (let i = 0; i < block.length; i += 1) {
      const ch = block[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        tagEnd = i;
        break;
      }
    }
    return {
      head: tagEnd === -1 ? block : block.slice(0, tagEnd + 1),
      children: tagEnd === -1 ? '' : block.slice(tagEnd + 1),
    };
  });
}

const chromeSource = () => code(read(HOST));

describe('a publisher-controlled chrome row is clamped to one line', () => {
  it('the parser separates an opening tag from its children — positive control', () => {
    // A guard built on a regex that matches nothing reports a confident, empty,
    // fully-green set. Feed it the two shapes that break naive versions: a
    // `leftSection` whose JSX carries a `>` of its own, and a boolean prop written
    // without a value.
    const parsed = items(`
      <ChromeSurfaceItem
        href="/apps"
        leftSection={<IconBuildingStore size={14} stroke={1.5} />}
        clamp
      >
        {sanitizeAppChromeName(r.name) || r.blockId}
      </ChromeSurfaceItem>
    `);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].head, 'the leftSection JSX must not truncate the opening tag').toContain(
      'clamp'
    );
    expect(parsed[0].children.trim()).toBe('{sanitizeAppChromeName(r.name) || r.blockId}');

    // …and the children of a plain item are NOT mistaken for its head.
    const plain = items('<ChromeSurfaceItem href="/apps">Marketplace</ChromeSurfaceItem>');
    expect(plain[0].head).not.toContain('Marketplace');
    expect(plain[0].children).toBe('Marketplace');
  });

  it('EVERY item whose label passes through the publisher sanitizer carries `clamp`', () => {
    const all = items(chromeSource());
    // The chrome really was read. A zero here is indistinguishable from a parser
    // wired to nothing, so it must never be the thing that makes this pass.
    expect(all.length, 'parsed no `<ChromeSurfaceItem>` out of the chrome').toBeGreaterThanOrEqual(
      5
    );

    const publisherControlled = all.filter((i) => i.children.includes('sanitizeAppChromeName'));
    expect(
      publisherControlled.length,
      'no chrome row renders a `sanitizeAppChromeName(...)` label any more. If the "Recently run" ' +
        'section was removed, delete this guard deliberately; if the label stopped going through ' +
        'the sanitizer, that is a SPOOFING regression, not a reason to relax this.'
    ).toBe(1);

    for (const item of publisherControlled) {
      expect(
        item.head.replace(/\s+/g, ' '),
        'a chrome row renders a publisher-controlled label WITHOUT `clamp`. On the desktop menu ' +
          'path `ChromeSurfaceItem` renders children raw, so an unclamped name wraps to two ' +
          'lines and grows the dropdown by ~23px per row (×5 rows). Add `clamp`.'
      ).toMatch(/(^|\s)clamp(\s|>|=)/);
    }
  });

  it('the HOST-authored labels are deliberately NOT clamped — the fix is not over-applied', () => {
    // 🔴 THE OTHER DIRECTION, AND IT IS NOT SYMMETRY FOR ITS OWN SAKE. Clamping the
    // whole menu would have been the tempting one-line "fix", and it would have
    // changed the rendering of six labels that were raw children before this
    // primitive existed — a desktop behaviour change smuggled in as a bug fix, on the
    // exact surface F3 promises not to touch. This fails if someone reaches for it.
    const plain = items(chromeSource()).filter(
      (i) => !i.children.includes('sanitizeAppChromeName')
    );
    expect(plain.length, 'expected the host-authored rows to still be here').toBeGreaterThanOrEqual(
      4
    );
    for (const item of plain) {
      expect(
        item.head.replace(/\s+/g, ' '),
        `a host-authored row gained \`clamp\`: ${item.children
          .trim()
          .slice(0, 40)}. Those labels ` +
          'are short, fixed and were raw children before `ChromeSurface` existed; wrapping them ' +
          'in a `Text` changes the desktop dropdown for no reason.'
      ).not.toMatch(/(^|\s)clamp(\s|>|=)/);
    }
  });

  it('`clamp` actually renders the one-line wrapper on the MENU path', () => {
    // The prop could exist, be threaded, be asserted above — and do nothing, which is
    // the shape of a guard that reads as coverage while providing none. Pin that the
    // menu branch consumes it, and that the sheet branch clamps unconditionally (the
    // asymmetry `clamp` exists to document rather than hide).
    const surface = code(read(SURFACE));
    expect(
      surface.replace(/\s+/g, ' '),
      '`ChromeSurfaceItem`’s menu branch must render `clamp`ed children inside a ' +
        '`<Text lineClamp={1}>` — otherwise the prop is inert and every assertion above passes ' +
        'over a label that still wraps.'
    ).toMatch(/clamp \? \( <Text size="sm" lineClamp=\{1\}>/);
    expect(
      (surface.match(/lineClamp=\{1\}/g) ?? []).length,
      'expected TWO `lineClamp={1}` sites in the primitive: the menu branch (opt-in, via ' +
        '`clamp`) and the sheet branch (unconditional). One means a branch lost its clamp.'
    ).toBe(2);
  });
});
