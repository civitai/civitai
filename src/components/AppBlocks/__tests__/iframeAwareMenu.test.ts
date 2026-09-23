import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY `<Menu>` in the app-block host chrome must be iframe-aware. Node `unit`
 * project — the tier that EXECUTES this assertion (report-only on a pull request,
 * an honest verdict on a push to `main`). The behavioural proof lives in
 * `AppBlockChrome.browser.test.tsx`, which runs in CI as the REPORT-ONLY
 * `preview / component-tests` status. NEITHER TIER BLOCKS A MERGE: `main` requires
 * no status check at all in this repo, so this is a signal a reviewer must read,
 * not a door that stays shut.
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
const SURFACE = path.join(REPO_ROOT, 'src/components/AppBlocks/ChromeSurface.tsx');

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
 * Opening `<Menu …>` / `<Popover …>` / `<Drawer …>` tags only — `<Menu.Item>`,
 * `<Menu.Dropdown>`, `<Popover.Target>` etc. are sub-components, not floating
 * surfaces, and closing tags are not openings.
 *
 * 🔴 THE HAZARD IS THE FLOATING SURFACE, NOT THE COMPONENT NAME. The rule this
 * ledger enforces is a fact about the SURFACE — the chrome sits on a cross-origin
 * iframe that swallows the `mousedown` of a click into the app — so it applies to
 * anything Mantine renders in a floating layer with a click-outside close, not just
 * to `<Menu>`. F2 added a `<Popover>` (the app-name crumb's store card), which the
 * `<Menu>`-only matcher would have counted as zero and passed clean while the
 * popover hung over the app exactly like the ⋮ menu once did. F3 added `<Drawer>`
 * (the bottom sheets below `sm`) — the previous revision of this comment named
 * `Drawer` as the next thing to widen for, and this is that widening. Widen it again
 * before adding a `HoverCard` or `Combobox`.
 *
 * 🔴 `(?![.\w])` IS WHAT KEEPS `<AppPermissionsActivityDrawer …>` OUT. That element
 * is rendered by the chrome and its NAME ends in "Drawer", but it is a component of
 * ours whose own `<Drawer>` lives in its own file — matching it here would count one
 * surface twice and demand a hook call the chrome does not make for it.
 */
function menuOpeningTags(src: string): string[] {
  return [...src.matchAll(/<(?:Menu|Popover|Drawer)(?![.\w])[\s\S]*?>/g)].map((m) => m[0]);
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

    // The `<Drawer>` third of the union (F3's bottom sheets), with the same
    // sub-component control — and, crucially, the OTHER-COMPONENT control: the chrome
    // renders `<AppPermissionsActivityDrawer>`, whose name ends in "Drawer" and whose
    // own sheet lives in its own file. A matcher that counted it here would demand a
    // hook call for a surface this file does not render.
    expect(
      menuOpeningTags('<Drawer opened={d.opened} onClose={d.close} position="bottom">x</Drawer>')
    ).toHaveLength(1);
    expect(menuOpeningTags('<AppPermissionsActivityDrawer opened={x} onClose={y} />')).toHaveLength(
      0
    );
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
  /**
   * 🔴 F3 SPLIT THE ONE NUMBER INTO TWO, AND THE SPLIT IS THE POINT. Until F3 every
   * chrome source both RENDERED its floating surfaces and OWNED their state, so one
   * count could pin both ("N surfaces, N hook calls"). F3 moved the rendering into a
   * single primitive (`ChromeSurface`, which picks `Menu` / `Popover` / `Drawer` from
   * the bar's measured width) while leaving the state at the CALL SITES — deliberately,
   * so two triggers can never come to share one `opened` flag.
   *
   * A single number can no longer express that: `ChromeSurface.tsx` renders three
   * surfaces and calls the hook ZERO times (it receives a control), while
   * `AppBlockChrome` renders zero raw surfaces and calls the hook TWICE. Collapsing
   * those back into one column would force one of the two files to lie.
   *
   * So each row states both, and the invariant that still ties them together is
   * asserted separately below: `sum(hookCalls) === sum(chromeSurfaceUses)` across the
   * whole chrome — one control per trigger, no matter which file each half lives in.
   */
  const LEDGER: ReadonlyArray<{
    what: string;
    source: () => string;
    /** RAW Mantine floating surfaces (`<Menu>`/`<Popover>`/`<Drawer>`) rendered here. */
    surfaces: number;
    /** `useIframeAwareMenu()` calls — i.e. open-state owners — declared here. */
    hookCalls: number;
    /** `<ChromeSurface>` uses — i.e. triggers wired to the primitive — declared here. */
    chromeSurfaces: number;
    detail: string;
  }> = [
    {
      what: 'ChromeSurface.tsx (the primitive)',
      source: () => code(read(SURFACE)),
      surfaces: 3,
      hookCalls: 0,
      chromeSurfaces: 0,
      detail:
        'THE ONLY file in the chrome allowed to render a raw Mantine floating surface, and it ' +
        'renders exactly three: the `Menu` and `Popover` a desktop-width bar gets, and the ' +
        'bottom-sheet `Drawer` below `sm`. A FOURTH means a new rendering was added — check it ' +
        'is controlled from the same `control` prop. FEWER means one mode was dropped, which ' +
        'silently sends that bar width to whichever branch remains. It calls the hook ZERO ' +
        'times ON PURPOSE: the state belongs to the call site, so two triggers cannot end up ' +
        'sharing one `opened` flag.',
    },
    {
      what: 'AppBlockChrome (IframeHost.tsx)',
      source: chromeSource,
      surfaces: 0,
      hookCalls: 2,
      chromeSurfaces: 2,
      detail:
        'the platform-nav trigger behind the app icon and the ⋮ overflow trigger — each a ' +
        '`<ChromeSurface>` with its own control. ZERO raw surfaces is the F3 contract: a bare ' +
        '`<Menu>` or `<Drawer>` reappearing here is the primitive being bypassed, which is how ' +
        'the mobile shell would silently regain a dropdown that hangs over the app. A THIRD ' +
        'trigger means a new control was added: give it its own `useIframeAwareMenu()` and ' +
        'raise BOTH numbers in the same commit.',
    },
    {
      what: 'AppNameCrumb.tsx',
      source: () => code(read(CRUMB)),
      surfaces: 0,
      hookCalls: 1,
      chromeSurfaces: 1,
      detail:
        'the app-name crumb’s store card (full name + recommend rollup + "View in App Store" + ' +
        'F4’s review action) — a popover on a desktop bar, a bottom sheet below `sm`, one ' +
        '`<ChromeSurface>` either way.',
    },
    {
      what: 'ChromeReviewEntry.tsx',
      source: () => code(read(REVIEW_ENTRY)),
      surfaces: 0,
      hookCalls: 0,
      chromeSurfaces: 0,
      detail:
        'F4’s two review entry points. ALL THREE ZEROES are the correct counts and this row is ' +
        'not filler: both entry points are plain controls rendered INTO surfaces their hosts ' +
        'already own (a `ChromeSurfaceItem` inside the ⋮ surface, a `Button` inside the crumb’s ' +
        'card), and the modal they open is mounted by `AppBlockChrome` OUTSIDE both. Any of ' +
        'these going non-zero means this file grew a surface of its own — wire it and raise the ' +
        'number in the same commit, or it will hang over the app the first time a user clicks ' +
        'into it.',
    },
  ];

  /** `<ChromeSurface …>` uses — the compound sub-components are not surfaces. */
  function chromeSurfaceUses(src: string): string[] {
    return [...src.matchAll(/<ChromeSurface(?![.\w])[\s\S]*?>/g)].map((m) => m[0]);
  }

  it('the ChromeSurface matcher can see a use and skips its item siblings — positive control', () => {
    // Same reasoning as the `<Menu>` control above: a matcher that silently sees
    // nothing turns every count below into a fact about the regex.
    expect(
      chromeSurfaceUses('<ChromeSurface compact={c} control={m}>x</ChromeSurface>')
    ).toHaveLength(1);
    // 🔴 THE SIBLINGS ARE THE TRAP. `ChromeSurfaceItem` / `ChromeSurfaceLabel` /
    // `ChromeSurfaceGroup` all START with the string `ChromeSurface`, and the chrome
    // renders a dozen of them — without the `(?![.\w])` guard every one would be
    // counted as a trigger and the hook-call equality below would demand a dozen
    // controls that must not exist.
    expect(
      chromeSurfaceUses(
        '<ChromeSurfaceItem href="/apps">a</ChromeSurfaceItem><ChromeSurfaceLabel>b</ChromeSurfaceLabel><ChromeSurfaceGroup />'
      )
    ).toHaveLength(0);
  });

  it.each(LEDGER)(
    '$what: $surfaces raw floating surface(s), $chromeSurfaces ChromeSurface use(s), $hookCalls hook call(s)',
    (row) => {
      const src = row.source();
      const tags = menuOpeningTags(src);

      // Failing on GROWTH is the point: a new floating surface must be a deliberate
      // edit here, which is the moment somebody reads the paragraph above and wires
      // the hook. Failing on SHRINK catches one being removed or restructured past
      // this scanner.
      expect(
        tags.length,
        `expected exactly ${row.surfaces} raw Mantine floating surface(s) in ${row.what} — ${row.detail}`
      ).toBe(row.surfaces);

      // Every one of them is CONTROLLED. A count alone would pass surfaces that all
      // dropped their `opened`/`onChange`.
      //
      // 🔴 A `Drawer` CLOSES THROUGH `onClose`, NOT `onChange` — it has no `onChange`
      // prop at all. Requiring `onChange` of every surface would have made the F3
      // sheet unrepresentable and invited someone to drop the check rather than
      // widen it, so the close-handler assertion branches on the component while the
      // `opened=` half stays universal.
      for (const tag of tags) {
        const oneLine = tag.replace(/\s+/g, ' ');
        expect(oneLine, `an uncontrolled floating surface in ${row.what}: ${oneLine}`).toMatch(
          /opened=\{/
        );
        const closeProp = /^<Drawer\b/.test(oneLine) ? /onClose=\{/ : /onChange=\{/;
        expect(
          oneLine,
          `a floating surface with no close handler in ${row.what}: ${oneLine}`
        ).toMatch(closeProp);
      }

      expect(
        chromeSurfaceUses(src).length,
        `expected exactly ${row.chromeSurfaces} \`<ChromeSurface>\` use(s) in ${row.what} — ${row.detail}`
      ).toBe(row.chromeSurfaces);

      // …and the control state comes from the SHARED hook, once per TRIGGER. Two
      // triggers and one hook call would mean they share a single `opened` flag
      // (opening one would close the other); two triggers and three calls means a
      // dead one.
      const hookCalls = src.match(/useIframeAwareMenu\(/g) ?? [];
      expect(
        hookCalls,
        `the number of \`useIframeAwareMenu()\` calls in ${row.what} must be ${row.hookCalls} — ` +
          'each trigger owns its own open state, and the primitive owns none.'
      ).toHaveLength(row.hookCalls);

      // 🔴 ONE listener, one place — checked per source, not just for the chrome.
      // The original defect was this effect existing at one site and not the other;
      // an inline copy in ANY chrome source is that defect re-forming.
      expect(
        src.match(/addEventListener\(\s*'blur'/g) ?? [],
        `a window \`blur\` listener has reappeared inside ${row.what}. That is the copy this ` +
          'consolidation removed — route the new control through `useIframeAwareMenu` instead.'
      ).toHaveLength(0);
    }
  );

  it('ONE CONTROL PER TRIGGER, summed across the whole chrome', () => {
    // 🔴 THE SEAM THE PER-ROW COUNTS CANNOT SEE. Every number above is a fact about
    // ONE file, and F3 put the two halves of this rule in different files: a trigger
    // is declared where its `useIframeAwareMenu()` lives, and rendered by a primitive
    // somewhere else. A per-file ledger is satisfied by "2 and 2 here, 1 and 1 there"
    // — and would stay satisfied if a future file declared a `<ChromeSurface>` with a
    // control borrowed from a sibling, which is exactly the shared-`opened` bug the
    // per-surface count was written to prevent. This is the relationship, not the
    // components.
    let hooks = 0;
    let triggers = 0;
    const controls: string[] = [];
    for (const row of LEDGER) {
      const src = row.source();
      hooks += (src.match(/useIframeAwareMenu\(/g) ?? []).length;
      const uses = chromeSurfaceUses(src);
      triggers += uses.length;
      for (const tag of uses) {
        const named = /control=\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(tag.replace(/\s+/g, ' '));
        expect(
          named,
          `a \`<ChromeSurface>\` in ${row.what} passes no simple \`control={identifier}\`. Pass the ` +
            'variable a `useIframeAwareMenu()` call was assigned to, so the check below can see ' +
            'WHICH control each surface holds.'
        ).not.toBeNull();
        controls.push(`${row.what}::${(named as RegExpExecArray)[1]}`);
      }
    }
    // Positive control: a zero on BOTH sides would satisfy the equality while
    // proving that neither pattern matched anything in the real tree.
    expect(triggers, 'the ledger found no `<ChromeSurface>` in the chrome at all').toBeGreaterThan(
      0
    );
    expect(
      hooks,
      'the chrome declares a different number of open-state controls than it has triggers. ' +
        'Every `<ChromeSurface>` needs its OWN `useIframeAwareMenu()`; sharing one makes opening ' +
        'either surface close the other.'
    ).toBe(triggers);

    // 🔴 THE COUNT ALONE IS NOT THE RULE, AND A MUTATION PROVED IT. Pointing the
    // platform-nav surface at `overflowMenu` leaves BOTH numbers at two — two hook
    // calls, two triggers — while the two surfaces share one `opened` flag, so opening
    // either closes the other and one hook call is dead. The equality above scores that
    // clean. The rule is that the controls are DISTINCT, so that is what is asserted.
    expect(
      new Set(controls).size,
      `two chrome surfaces are driven by the SAME control (${controls.join(', ')}). They would ` +
        'share one `opened` flag: opening either would close the other, and one ' +
        '`useIframeAwareMenu()` call would be dead while every count still balanced.'
    ).toBe(controls.length);
  });

  it('the primitive takes its open state from the caller rather than owning any', () => {
    // The counts above say `ChromeSurface.tsx` calls the hook zero times. That is
    // consistent with it holding its own `useState` instead, which would be the same
    // defect wearing different clothes — the state would be per-PRIMITIVE-INSTANCE
    // either way, but nothing would stop a future caller from reading `opened` for a
    // decision the primitive no longer exposes. Pin the actual contract.
    const surface = code(read(SURFACE));
    expect(
      surface,
      '`ChromeSurface` must accept a `control` (the `useIframeAwareMenu()` return) rather than ' +
        'deriving open state internally.'
    ).toMatch(/control\s*[,:}]/);
    expect(
      surface.match(/useState\(/g) ?? [],
      '`ChromeSurface` grew its own `useState`. Open state belongs to the CALL SITE — see the ' +
        'ledger note above for why that split is load-bearing rather than stylistic.'
    ).toHaveLength(0);
  });

  it('a CONTROLLED Popover gets no onClick from Mantine, so the primitive wires its own', () => {
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

    // 🔴 F3 MOVED THIS HANDLER FROM `AppNameCrumb` INTO `ChromeSurface`, WHICH IS WHY
    // THE ASSERTION MOVED WITH IT — and the hazard got WIDER rather than narrower.
    // The primitive now clones its target in TWO modes that both need it: `popover`
    // (Mantine withholds `onClick` from a controlled target, as pinned above) and
    // `sheet` (there is no Mantine target wrapper at all, so nothing would attach
    // one). A crumb-scoped check would now be looking at a file that no longer owns
    // the behaviour and would pass by finding nothing.
    const surface = code(read(SURFACE));
    expect(
      surface,
      '`ChromeSurface` must clone its target with its OWN onClick — a controlled Popover.Target ' +
        'gets none from Mantine, and a bare sheet trigger has no wrapper to get one from, so ' +
        'without it the trigger opens nothing in either mode.'
    ).toMatch(/cloneElement\([\s\S]{0,200}?onClick:/);
    // Both cloning sites, not just one: the count is what catches a refactor that
    // keeps the popover clone and drops the sheet's (or vice versa) — either of which
    // ships a real button, correctly labelled, that does nothing.
    expect(
      surface.match(/cloneElement\(/g) ?? [],
      '`ChromeSurface` must clone its target in BOTH the `popover` and `sheet` modes. `menu` ' +
        'mode deliberately does NOT — `MenuTarget` has no `!ctx.controlled` guard, so Mantine ' +
        'attaches the handler there and a second one would be a behaviour change on the ' +
        'desktop path this work is not supposed to touch.'
    ).toHaveLength(2);
  });

  it('the chrome’s controls are addressable by stable testids, across both shells', () => {
    const chrome = chromeSource();
    // Reachable only by accessible name, the ⋮ trigger broke every test that
    // touched it whenever the copy changed. Its siblings all carry a testid.
    expect(chrome).toContain('data-testid="app-block-menu-trigger"');
    // Named alongside the sibling ledger so a rename of the family is visible
    // here rather than only in a browser suite that does not gate a merge.
    //
    // 🔴 `app-block-back` IS THE F3 ADDITION AND IT IS NOT COSMETIC: the mobile
    // shell's back chevron is the ONLY way off the run page once the breadcrumb is
    // gone, so a rename that silently orphaned every test reaching for it would
    // leave that route unguarded in the tier that gates merges.
    for (const id of [
      'app-block-chrome',
      'app-platform-nav-trigger',
      'app-block-name',
      'app-block-menu-trigger',
      'app-block-back',
    ]) {
      expect(chrome, `chrome testid \`${id}\` is missing`).toContain(`data-testid="${id}"`);
    }
  });
});
