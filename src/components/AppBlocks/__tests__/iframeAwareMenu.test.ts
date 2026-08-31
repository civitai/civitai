import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY `<Menu>` in the app-block host chrome must be iframe-aware. Node `unit`
 * project — the GATING tier. The behavioural proof lives in
 * `AppBlockChrome.browser.test.tsx`, which runs in CI as the REPORT-ONLY
 * `preview / component-tests` status; this is the copy that can block a merge.
 *
 * WHAT BROKE. `AppBlockChrome` renders two Mantine menus a hundred lines apart.
 * The platform-nav one was made CONTROLLED with a window-`blur` close, because
 * the cross-origin app iframe below swallows the `mousedown` of a click into the
 * app and Mantine's `closeOnClickOutside` therefore never fires. The ⋮ overflow
 * menu — same component, same iframe, same hazard — was left a bare uncontrolled
 * `<Menu>` and stayed open on top of the app the user had just clicked into.
 *
 * Nothing about the second menu looked wrong; the rule simply lived at one site
 * and the other site was written without it. So the cure is a shared hook
 * (`useIframeAwareMenu`) plus this LEDGER, which fails when the set of menus in
 * the chrome GROWS (a new control added without the hook) or SHRINKS (a menu
 * removed, or the hook quietly reverted to inline state) — not a presence check
 * that a third uncontrolled menu would sail past.
 *
 * 🔴 THIS IS A SOURCE SCAN, AND IT PINS A RELATIONSHIP, NOT A WORD. It asserts
 * that the count of `<Menu …>` opening tags inside `AppBlockChrome` equals the
 * count of hook calls AND that every one of those tags carries both `opened=` and
 * `onChange=`. A menu that spells `opened` from some other state still fails the
 * count, and a hook call with no menu fails it in the other direction.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const HOOK = path.join(REPO_ROOT, 'src/components/AppBlocks/useIframeAwareMenu.ts');
const CRUMB = path.join(REPO_ROOT, 'src/components/AppBlocks/AppNameCrumb.tsx');
const REVIEW_ENTRY = path.join(REPO_ROOT, 'src/components/AppBlocks/ChromeReviewEntry.tsx');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent
  // file reports zero of everything, which would read as a clean pass.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments — every token searched for below is also
 *  discussed at length in the comments around it, so a rule must never be
 *  satisfiable by prose ABOUT the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The `AppBlockChrome` function body, bounded by the NEXT top-level
 * `export function` in the file. `IframeHost.tsx` also exports `IframeHost`,
 * which renders no chrome menus of its own — scoping keeps this guard about the
 * chrome rather than about the whole 5k-line module.
 */
function chromeSource(): string {
  const src = code(read(HOST));
  const start = src.indexOf('export function AppBlockChrome');
  expect(
    start,
    'the `AppBlockChrome` declaration was not found in IframeHost.tsx — if it moved or was ' +
      'renamed, re-point this guard rather than deleting it: it is the only BLOCKING check that ' +
      'every chrome menu is iframe-aware.'
  ).toBeGreaterThan(-1);
  const rest = src.slice(start + 'export function AppBlockChrome'.length);
  const nextExport = rest.indexOf('\nexport function ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/**
 * Opening `<Menu …>` / `<Popover …>` tags only — `<Menu.Item>`, `<Menu.Dropdown>`,
 * `<Popover.Target>` etc. are sub-components, not floating surfaces, and closing
 * tags are not openings.
 *
 * 🔴 THE HAZARD IS THE FLOATING SURFACE, NOT THE COMPONENT NAME. The rule this
 * ledger enforces is a fact about the SURFACE — the chrome sits on a cross-origin
 * iframe that swallows the `mousedown` of a click into the app — so it applies to
 * anything Mantine renders in a floating layer with a click-outside close, not just
 * to `<Menu>`. F2 added a `<Popover>` (the app-name crumb's store card), which the
 * `<Menu>`-only matcher would have counted as zero and passed clean while the
 * popover hung over the app exactly like the ⋮ menu once did. Widen this union
 * before adding a `HoverCard`, `Combobox` or `Drawer` to the chrome.
 */
function menuOpeningTags(src: string): string[] {
  return [...src.matchAll(/<(?:Menu|Popover)(?![.\w])[\s\S]*?>/g)].map((m) => m[0]);
}

describe('every Menu in the app-block chrome is iframe-aware', () => {
  it('the scanner can actually see a menu — positive control on the regex itself', () => {
    // A ledger built on a regex that matches nothing reports a confident, empty,
    // fully-green set. Feed the matcher a shape it MUST find before believing any
    // count it returns from the real file.
    const fixture = `
      <Menu position="bottom-end" opened={x.opened} onChange={x.onChange}>
        <Menu.Target><button /></Menu.Target>
        <Menu.Dropdown><Menu.Item>a</Menu.Item></Menu.Dropdown>
      </Menu>
    `;
    const found = menuOpeningTags(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('position="bottom-end"');
    // …and that it does NOT count the sub-components, which is the whole reason
    // for the `(?![.\w])` guard.
    expect(menuOpeningTags('<Menu.Item>x</Menu.Item><Menu.Dropdown />')).toHaveLength(0);

    // The `<Popover>` half of the union, with the same sub-component control. A
    // matcher that silently sees no popovers would score the F2 crumb as
    // "no floating surfaces here" — a green built entirely out of a blind spot.
    expect(
      menuOpeningTags('<Popover opened={p.opened} onChange={p.onChange}>x</Popover>')
    ).toHaveLength(1);
    expect(
      menuOpeningTags('<Popover.Target><button /></Popover.Target><Popover.Dropdown />')
    ).toHaveLength(0);
  });

  it('the shared hook exists and is the only place the blur listener lives', () => {
    const hook = code(read(HOOK));
    expect(hook).toMatch(/export function useIframeAwareMenu/);
    expect(hook).toMatch(/addEventListener\(\s*'blur'/);

    // 🔴 ONE listener, one place. The original defect was this effect existing at
    // one site and not the other; a second inline copy in the chrome would be the
    // same defect re-forming, so the chrome must not grow its own.
    const chrome = chromeSource();
    expect(
      chrome.match(/addEventListener\(\s*'blur'/g) ?? [],
      'a window `blur` listener has reappeared INSIDE AppBlockChrome. That is the copy this ' +
        'consolidation removed — route the new control through `useIframeAwareMenu` instead.'
    ).toHaveLength(0);
  });

  /**
   * The LEDGER, one row per source that renders part of the chrome.
   *
   * 🔴 THE CHROME IS NO LONGER ONE FILE. F2 moved the breadcrumb's app-name crumb
   * into its own component (`AppNameCrumb.tsx`) because it needs a tRPC query and a
   * feature-flag gate that do not belong in a 5k-line host module. That split is
   * the exact shape that lets the rule leak: a guard scoped to `AppBlockChrome`'s
   * function body cannot see a floating surface that renders INSIDE the chrome from
   * another file, so it would report "still two, both controlled" and pass while a
   * third dropdown hung over the app. Every new file that renders into this chrome
   * belongs in this table.
   */
  const LEDGER: ReadonlyArray<{
    what: string;
    source: () => string;
    surfaces: number;
    detail: string;
  }> = [
    {
      what: 'AppBlockChrome (IframeHost.tsx)',
      source: chromeSource,
      surfaces: 2,
      detail:
        'the platform-nav menu behind the app icon and the ⋮ overflow menu. A THIRD means a ' +
        'new control was added: put it on `useIframeAwareMenu` and update this count in the ' +
        'same commit, or it will be stuck open the first time a user clicks into the app. ' +
        'FEWER means one was removed or restructured past this scanner.',
    },
    {
      what: 'AppNameCrumb.tsx',
      source: () => code(read(CRUMB)),
      surfaces: 1,
      detail:
        'the breadcrumb app-name crumb’s store popover (full name + recommend rollup + "View ' +
        'in App Store"). It renders directly over the app iframe like every other floating ' +
        'surface in this chrome, so it is on the same hook.',
    },
    {
      what: 'ChromeReviewEntry.tsx',
      source: () => code(read(REVIEW_ENTRY)),
      surfaces: 0,
      detail:
        'F4’s two review entry points. ZERO is the correct count and this row is not filler: ' +
        'both are plain controls rendered INTO surfaces their hosts already own (a `Menu.Item` ' +
        'inside the chrome’s ⋮ dropdown, a `Button` inside the crumb’s popover), and the modal ' +
        'they open is mounted by `AppBlockChrome` OUTSIDE both. A `<Menu>` or `<Popover>` ' +
        'appearing here means this file grew a floating surface of its own — put it on ' +
        '`useIframeAwareMenu` and raise this number in the same commit, or it will hang over ' +
        'the app the first time a user clicks into it.',
    },
  ];

  it.each(LEDGER)('$what renders exactly $surfaces floating surface(s), all on the hook', (row) => {
    const src = row.source();
    const tags = menuOpeningTags(src);

    // Failing on GROWTH is the point: a new floating surface must be a deliberate
    // edit here, which is the moment somebody reads the paragraph above and wires
    // the hook. Failing on SHRINK catches one being removed or restructured past
    // this scanner.
    expect(
      tags.length,
      `expected exactly ${row.surfaces} floating surface(s) in ${row.what} — ${row.detail}`
    ).toBe(row.surfaces);

    // Every one of them is CONTROLLED. A count alone would pass surfaces that all
    // dropped their `opened`/`onChange`.
    for (const tag of tags) {
      const oneLine = tag.replace(/\s+/g, ' ');
      expect(oneLine, `an uncontrolled floating surface in ${row.what}: ${oneLine}`).toMatch(
        /opened=\{/
      );
      expect(oneLine, `a floating surface with no onChange in ${row.what}: ${oneLine}`).toMatch(
        /onChange=\{/
      );
    }

    // …and the control state comes from the SHARED hook, once per surface. Two
    // surfaces and one hook call would mean they share a single `opened` flag
    // (opening one would close the other); two surfaces and three calls means a
    // dead one.
    const hookCalls = src.match(/useIframeAwareMenu\(/g) ?? [];
    expect(
      hookCalls,
      `the number of \`useIframeAwareMenu()\` calls must equal the number of floating surfaces ` +
        `in ${row.what} — each owns its own open state.`
    ).toHaveLength(tags.length);

    // 🔴 ONE listener, one place — checked per source, not just for the chrome.
    // The original defect was this effect existing at one site and not the other;
    // an inline copy in ANY chrome source is that defect re-forming.
    expect(
      src.match(/addEventListener\(\s*'blur'/g) ?? [],
      `a window \`blur\` listener has reappeared inside ${row.what}. That is the copy this ` +
        'consolidation removed — route the new control through `useIframeAwareMenu` instead.'
    ).toHaveLength(0);
  });

  it('a CONTROLLED Popover gets no onClick from Mantine, so the crumb wires its own', () => {
    // 🔴 THIS IS THE ONE THAT WOULD SHIP A DEAD BUTTON. `PopoverTarget` clones its
    // child with `...(!ctx.controlled ? { onClick: ctx.onToggle } : null)` — so the
    // moment the popover is put on `useIframeAwareMenu` (which is what supplying
    // `opened` means) Mantine STOPS attaching the handler that opens it. The result
    // is a real `<button>` carrying every correct ARIA attribute that does nothing
    // at all, and no type error, no lint error and no ledger row above can see it.
    //
    // Pinned against the installed Mantine so the premise is checked, not assumed:
    // if a future version starts attaching onClick to controlled targets, this
    // fails and the redundant handler can be dropped deliberately.
    const target = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'node_modules/@mantine/core/esm/components/Popover/PopoverTarget/PopoverTarget.mjs'
      ),
      'utf8'
    );
    expect(
      target.replace(/\s+/g, ' '),
      'Mantine’s PopoverTarget no longer guards its onClick on `!ctx.controlled` — re-read the ' +
        'crumb’s own onClick before trusting either.'
    ).toContain('!ctx.controlled ? { onClick: ctx.onToggle } : null');

    expect(
      code(read(CRUMB)),
      'AppNameCrumb’s Popover.Target must carry its OWN onClick — a controlled Popover.Target ' +
        'gets none from Mantine, so without it the trigger opens nothing.'
    ).toMatch(/onClick=\{[^}]*popover\.onChange/);
  });

  it('the ⋮ overflow trigger is addressable by a stable testid, like its siblings', () => {
    const chrome = chromeSource();
    // Reachable only by accessible name, the ⋮ trigger broke every test that
    // touched it whenever the copy changed. Its siblings all carry a testid.
    expect(chrome).toContain('data-testid="app-block-menu-trigger"');
    // Named alongside the sibling ledger so a rename of the family is visible
    // here rather than only in a browser suite that does not gate a merge.
    for (const id of [
      'app-block-chrome',
      'app-platform-nav-trigger',
      'app-block-name',
      'app-block-menu-trigger',
    ]) {
      expect(chrome, `chrome testid \`${id}\` is missing`).toContain(`data-testid="${id}"`);
    }
  });
});
