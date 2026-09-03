import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The app-block host chrome's platform-nav dropdown must draw the store's
 * destinations the way the STORE draws them. Node `unit` project — the tier that
 * EXECUTES this assertion (report-only on a pull request, an honest verdict on a
 * push to `main`). The behavioural companion in
 * `AppBlockChromePlatformNav.browser.test.tsx` is in the REPORT-ONLY browser tier.
 * NEITHER TIER BLOCKS A MERGE: `main` requires no status check at all in this
 * repo, so this is a signal a reviewer must read, not a door that stays shut.
 *
 * WHAT BROKE. `AppBlockChrome`'s dropdown and `AppsSubNav`'s tab bar are two
 * renderings of ONE platform navigation — a user who opens an app from the store
 * and then reaches for this menu is looking for the same destinations they just
 * left. They disagreed on the glyph for every single shared concept: grid vs
 * storefront for the marketplace, apps vs plug for installs, upload vs apps for
 * "My apps", shield vs gavel for review. Four out of four, which is what makes it
 * a missing rule rather than four typos: nothing tied the two tables together, so
 * each was drawn from scratch.
 *
 * 🔴 THIS PINS A RELATIONSHIP BETWEEN TWO FILES, NOT A LIST OF ICON NAMES. It reads
 * the icon out of `SUB_NAV_LINKS` at run time and requires the chrome to match
 * whatever it finds. So it fails in BOTH directions: re-icon the chrome and it
 * fails, and — the case a hardcoded list would sail past — re-icon the SUBNAV and
 * it fails there too, which is the drift that actually happens. The subnav is the
 * source of truth; when this goes red, change the chrome.
 *
 * 🔴 WHY A SOURCE SCAN RATHER THAN AN IMPORT. `SUB_NAV_LINKS` is module-private,
 * and both modules are `.tsx` that pull React, Mantine and tRPC — importing either
 * into the node project to read a table would drag a browser-shaped dependency
 * graph in for no gain. The cost of scanning text is that the scanner can silently
 * match nothing, so every extraction step below is fed a fixture it MUST parse
 * before any count it returns from the real files is believed.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHROME = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const SUBNAV = path.join(REPO_ROOT, 'src/components/Apps/AppsSubNav.tsx');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent file
  // reports zero of everything, which reads as a clean pass.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments. Every token searched for below is also discussed
 *  at length in the prose around it — including, in the chrome, a comment that
 *  names all four icons. A rule must never be satisfiable by prose ABOUT the rule.
 *
 *  🔴 JSX COMMENTS ARE REMOVED WHOLE, BRACES INCLUDED. A `{/* … *\/}` is a comment
 *  wrapped in an expression container, so stripping only the `/* … *\/` leaves a
 *  bare `{}` sitting in the element's children — which then reads as part of the
 *  label text. That is not hypothetical: it is exactly what this guard returned on
 *  its first run against the real file (`'{}\n Marketplace'`), and had the
 *  assertion been a `toContain` rather than an exact match it would have passed
 *  while parsing the element wrong. */
function code(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

type NavEntry = { href: string; label: string; icon: string };

/**
 * The `SUB_NAV_LINKS` table as `{href, label, icon}` rows.
 *
 * Entries are split on `href:` rather than on braces: the table's rows are a mix of
 * one-liners and multi-line objects, and several carry nested arrow functions
 * (`visible: (s, c) => ...`), so brace-counting would need a real parser to be
 * correct and a wrong one would silently drop rows.
 */
function parseSubNav(src: string): NavEntry[] {
  const start = src.indexOf('SUB_NAV_LINKS');
  expect(
    start,
    '`SUB_NAV_LINKS` was not found in AppsSubNav.tsx — if the table moved or was renamed, ' +
      're-point this guard rather than deleting it: it is the only BLOCKING check that the ' +
      'app-block chrome and the store subnav agree on their shared destinations.'
  ).toBeGreaterThan(-1);
  const body = src.slice(start);
  const end = body.indexOf('\n];');
  const table = end === -1 ? body : body.slice(0, end);

  const chunks = table.split(/\bhref:\s*/).slice(1);
  return chunks
    .map((chunk) => {
      const href = /^'([^']+)'/.exec(chunk)?.[1];
      const label = /\blabel:\s*'([^']+)'/.exec(chunk)?.[1];
      const icon = /\bicon:\s*(Icon\w+)/.exec(chunk)?.[1];
      return href && label && icon ? { href, label, icon } : null;
    })
    .filter((e): e is NavEntry => e !== null);
}

/**
 * The chrome's PLATFORM-NAV items, as `{href, label, icon}` rows.
 *
 * 🔴 SCOPED TO THE PLATFORM-NAV SECTION, WHICH IS NOT COSMETIC. The chrome also
 * renders the ⋮ overflow's "Manage apps", which points at the SAME
 * `/apps/installed` with a different, deliberate label. A whole-file scan would key
 * both onto one href and either compare the wrong row or clobber it. The slice is
 * anchored on the `Civitai Apps` label, which is the section's own heading.
 *
 * 🔴 F3 RE-POINTED BOTH ENDS OF THE SLICE, AND CHANGED WHAT BOUNDS IT. The items are
 * `<ChromeSurfaceItem>`s now, not `<Menu.Item>`s: below the `sm` breakpoint this
 * section is rendered as rows of a bottom sheet rather than a dropdown, and a
 * `Menu.Item` THROWS outside a `<Menu>` context, so it could not be re-parented (see
 * `ChromeSurface.tsx`). The rule this guard pins — the chrome and the store subnav
 * draw a shared route with a shared glyph — is completely unchanged; only the element
 * carrying it moved.
 *
 * The bound moved for a related reason. `</Menu.Dropdown>` no longer exists in this
 * file (the primitive owns it), so the section is bounded by the NEXT
 * `<ChromeSurfaceLabel>` instead — which is `Recently run`, whose items build their
 * hrefs from a template literal and are correctly skipped by the literal-href filter
 * below either way. That is a TIGHTER bound than the old one, not a looser one.
 */
function parsePlatformNav(src: string): NavEntry[] {
  const anchor = '<ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>';
  const start = src.indexOf(anchor);
  expect(
    start,
    `the platform-nav anchor \`${anchor}\` was not found in IframeHost.tsx — the section was ` +
      'restructured past this scanner. Re-point the anchor; do not delete the guard.'
  ).toBeGreaterThan(-1);
  const rest = src.slice(start + anchor.length);
  const end = rest.indexOf('<ChromeSurfaceLabel');
  expect(
    end,
    'the platform-nav section is not followed by another `<ChromeSurfaceLabel>` — the slice is ' +
      'unbounded and would swallow the ⋮ overflow’s own items.'
  ).toBeGreaterThan(-1);
  const region = rest.slice(0, end);

  return [...region.matchAll(/<ChromeSurfaceItem\b([\s\S]*?)<\/ChromeSurfaceItem>/g)]
    .map((m) => {
      const block = m[1];
      // A literal string href only. The "Recently run" items build theirs from a
      // template literal (`/apps/run/${r.blockId}`) and are not platform routes.
      const href = /href="([^"]+)"/.exec(block)?.[1];
      const icon = /leftSection=\{<(Icon\w+)/.exec(block)?.[1];
      if (!href || !icon) return null;
      // The label is the element's text: everything after the opening tag closes.
      // The opening tag's `>` is the first one at brace depth 0 — `leftSection={<Icon
      // ... />}` contains a `>` that is NOT the end of the tag, so a naive
      // `indexOf('>')` truncates the item and loses the label entirely.
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
      if (tagEnd === -1) return null;
      const label = block.slice(tagEnd + 1).trim();
      return label ? { href, label, icon } : null;
    })
    .filter((e): e is NavEntry => e !== null);
}

/**
 * EVERY chrome item that carries a LITERAL href, across both surfaces — not just the
 * platform-nav one.
 *
 * 🔴 THIS IS THE REPO-WIDE HALF, AND IT EXISTS BECAUSE THE SCOPED HALF MISSED A
 * SITE. The platform-nav-scoped parser above deliberately ignores the ⋮ overflow
 * menu so that two items pointing at one route cannot be keyed onto each other —
 * but that same scoping meant the ⋮ menu's "Manage apps" (`/apps/installed`) was
 * invisible to the icon rule, and re-iconing only the platform nav left ONE route
 * wearing TWO glyphs a few pixels apart in one bar. The same-route rule has to be
 * enforced over the whole component or it just relocates the drift.
 *
 * A literal href only: the "Recently run" items build theirs from a template
 * literal (`/apps/run/${r.blockId}`), which is not a platform route and has no
 * subnav row, and the store popover's link is built by `getListingDetailHref`.
 * Neither is a stand-alone destination this rule governs.
 */
function chromeBody(): string {
  const src = code(read(CHROME));
  const start = src.indexOf('export function AppBlockChrome');
  expect(
    start,
    'the `AppBlockChrome` declaration was not found in IframeHost.tsx — if it moved or was ' +
      'renamed, re-point this guard rather than deleting it.'
  ).toBeGreaterThan(-1);
  // Bounded by the NEXT top-level export: `IframeHost` lives in the same module and
  // renders no chrome menus of its own, so this keeps the rule about the chrome
  // rather than about the whole 5k-line file.
  const rest = src.slice(start + 'export function AppBlockChrome'.length);
  const nextExport = rest.indexOf('\nexport function ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

function parseAllChromeLinks(src: string): NavEntry[] {
  return [...src.matchAll(/<ChromeSurfaceItem\b([\s\S]*?)<\/ChromeSurfaceItem>/g)]
    .map((m) => {
      const block = m[1];
      const href = /href="([^"]+)"/.exec(block)?.[1];
      const icon = /leftSection=\{<(Icon\w+)/.exec(block)?.[1];
      if (!href || !icon) return null;
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
      if (tagEnd === -1) return null;
      const label = block.slice(tagEnd + 1).trim();
      return label ? { href, label, icon } : null;
    })
    .filter((e): e is NavEntry => e !== null);
}

describe('the app-block chrome platform nav agrees with the store subnav', () => {
  it('both extractors can actually parse their own shape — positive control', () => {
    // A guard built on a regex that matches nothing reports a confident, empty,
    // fully-green set. Feed each parser a shape it MUST find, INCLUDING the two
    // shapes that broke naive versions of them: a multi-line row with a nested
    // arrow function, and a `leftSection` whose JSX contains a `>` of its own.
    const subnav = parseSubNav(`
      const SUB_NAV_LINKS: SubNavLink[] = [
        { href: '/apps', label: 'Marketplace', icon: IconBuildingStore, visible: () => true },
        {
          href: '/apps/review',
          label: 'Review',
          icon: IconGavel,
          visible: (s, c) => c.isAuthor && s.isReviewer,
        },
      ];
    `);
    expect(subnav).toEqual([
      { href: '/apps', label: 'Marketplace', icon: 'IconBuildingStore' },
      { href: '/apps/review', label: 'Review', icon: 'IconGavel' },
    ]);

    const chrome = parsePlatformNav(`
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      <ChromeSurfaceItem
        href="/apps"
        leftSection={<IconBuildingStore size={14} stroke={1.5} />}
      >
        Marketplace
      </ChromeSurfaceItem>
      <ChromeSurfaceLabel>Recently run</ChromeSurfaceLabel>
    `);
    expect(chrome).toEqual([{ href: '/apps', label: 'Marketplace', icon: 'IconBuildingStore' }]);

    // The comment stripper's own control. This is the defect this guard shipped
    // with on its first run: a JSX comment left a bare `{}` in the children, so
    // the extracted label was `'{}\n Marketplace'`. Both files carry JSX comments
    // directly above the elements being parsed, so this path is always exercised.
    expect(code('<Text>{/* explain */}Marketplace</Text>')).toBe('<Text>Marketplace</Text>');
    expect(code('a /* block */ b\n  // line\nc')).toBe('a  b\n\nc');

    // …and the scope control: an item in a LATER section must not be picked up. This
    // is the fixture that would catch the F3 bound going wrong — the ⋮ overflow's own
    // `/apps/installed` sits after its own `<ChromeSurfaceLabel>App</…>`, and if the
    // slice ran past that label the two entries for one route would be keyed onto
    // each other and the icon comparison would be against the wrong row.
    const scoped = parsePlatformNav(`
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps" leftSection={<IconBuildingStore />}>Marketplace</ChromeSurfaceItem>
      <ChromeSurfaceLabel>App</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/installed" leftSection={<IconApps />}>Manage apps</ChromeSurfaceItem>
    `);
    expect(scoped.map((e) => e.href)).toEqual(['/apps']);
  });

  it('every platform-nav destination exists in the subnav and uses the subnav ICON', () => {
    const subnav = parseSubNav(code(read(SUBNAV)));
    const nav = parsePlatformNav(code(read(CHROME)));

    // Both tables were actually read. A zero here is indistinguishable from a
    // parser wired to nothing, so it must never be the thing that makes this pass.
    expect(subnav.length, 'parsed no rows out of SUB_NAV_LINKS').toBeGreaterThanOrEqual(7);
    expect(nav.length, 'parsed no items out of the chrome platform nav').toBe(4);

    const bySubNavHref = new Map(subnav.map((e) => [e.href, e]));

    for (const item of nav) {
      const store = bySubNavHref.get(item.href);
      expect(
        store,
        `the chrome platform nav offers \`${item.href}\`, which the store subnav does not list. ` +
          'Either the destination belongs in `SUB_NAV_LINKS` too, or this menu is inventing a ' +
          'route the store has no tab for — decide deliberately.'
      ).toBeDefined();
      expect(
        item.icon,
        `icon drift on \`${item.href}\`: the chrome draws it with \`${item.icon}\`, the store ` +
          `subnav with \`${store?.icon}\`. The SUBNAV is the source of truth — change the chrome.`
      ).toBe(store?.icon);
    }
  });

  it('the four shared destinations are the expected ones, drawn with the expected glyphs', () => {
    // The relationship test above is the real guard; this one names the resolved
    // values so a failure reads as a diff rather than sending you to two files.
    // It is NOT redundant coverage — it is what makes the other test's message
    // actionable, and it fails if the SHARED SET changes rather than just an icon.
    const nav = parsePlatformNav(code(read(CHROME)));
    expect(nav).toEqual([
      { href: '/apps', label: 'Marketplace', icon: 'IconBuildingStore' },
      { href: '/apps/installed', label: 'Installed apps', icon: 'IconPlugConnected' },
      { href: '/apps/mine', label: 'My apps', icon: 'IconApps' },
      { href: '/apps/review', label: 'Review', icon: 'IconGavel' },
    ]);
  });

  it('the marketplace LABEL is shared verbatim; the other three stay chrome-specific', () => {
    const subnav = parseSubNav(code(read(SUBNAV)));
    const nav = parsePlatformNav(code(read(CHROME)));
    const navByHref = new Map(nav.map((e) => [e.href, e]));
    const subByHref = new Map(subnav.map((e) => [e.href, e]));

    // "Apps home" named a destination the store itself stopped calling that. This
    // one label must track the subnav.
    expect(
      navByHref.get('/apps')?.label,
      'the chrome and the subnav must call `/apps` the same thing'
    ).toBe(subByHref.get('/apps')?.label);
    expect(navByHref.get('/apps')?.label).toBe('Marketplace');

    // 🔴 THE OTHER THREE DELIBERATELY DIFFER, so this pins the chrome's own copy
    // rather than asserting equality. The subnav's tabs sit under an "Apps"
    // heading and can afford one-word labels ("Installed", "Review"); these items
    // stand alone in a dropdown over a running app and need the noun. Asserting
    // equality here would force a wrong "fix" in one file or the other.
    expect(navByHref.get('/apps/installed')?.label).toBe('Installed apps');
    expect(navByHref.get('/apps/mine')?.label).toBe('My apps');
    expect(navByHref.get('/apps/review')?.label).toBe('Review');
    expect(subByHref.get('/apps/installed')?.label).toBe('Installed');
  });

  it('ONE ROUTE, ONE ICON — every literal-href item in the chrome, both dropdowns', () => {
    // 🔴 THE RULE THIS PR EXISTS TO ENFORCE, APPLIED TO THE WHOLE COMPONENT. Two
    // items may legitimately carry different LABELS for one destination ("Manage
    // apps" from inside a running app vs "Installed apps" as a destination); they
    // may not carry different PICTURES, because the two dropdowns open a few pixels
    // apart in the same bar. Fixing only the platform nav would have relocated the
    // drift rather than removed it, which is what this test is here to prevent.
    const subnav = parseSubNav(code(read(SUBNAV)));
    const links = parseAllChromeLinks(chromeBody());
    const bySubNavHref = new Map(subnav.map((e) => [e.href, e]));

    expect(links.length, 'parsed no literal-href items out of the chrome').toBe(5);

    // (a) Every route the chrome links to is a route the store actually has.
    for (const link of links) {
      expect(
        bySubNavHref.get(link.href),
        `the chrome links to \`${link.href}\` ("${link.label}"), which the store subnav does ` +
          'not list. Either it belongs in `SUB_NAV_LINKS`, or the chrome is inventing a ' +
          'destination the store has no tab for — decide deliberately.'
      ).toBeDefined();
    }

    // (b) …and draws it with the store's glyph, wherever in the chrome it appears.
    for (const link of links) {
      expect(
        link.icon,
        `same-route icon drift: "${link.label}" links to \`${link.href}\` with \`${link.icon}\`, ` +
          `but the store subnav draws that route with \`${bySubNavHref.get(link.href)?.icon}\`. ` +
          'One route must not wear two glyphs in one bar.'
      ).toBe(bySubNavHref.get(link.href)?.icon);
    }

    // (c) The pair that actually collided, named explicitly so the regression is
    // legible: two items, one route, and now one icon.
    const installed = links.filter((l) => l.href === '/apps/installed');
    expect(
      installed.map((l) => l.label).sort(),
      'the chrome should still offer BOTH `/apps/installed` entries — this rule is about ' +
        'their icons, not about removing one of them (that would be a behaviour change).'
    ).toEqual(['Installed apps', 'Manage apps']);
    expect(new Set(installed.map((l) => l.icon)).size).toBe(1);
  });

  it('the whole-chrome parser sees BOTH sections — positive control', () => {
    // The scoped parser stops at the next `<ChromeSurfaceLabel>` by design. If this
    // one inherited that bound it would silently score the ⋮ overflow's items as
    // absent and the rule above would pass over exactly the site it was written for.
    const found = parseAllChromeLinks(`
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/installed" leftSection={<IconPlugConnected />}>Installed apps</ChromeSurfaceItem>
      <ChromeSurfaceLabel>App</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/installed" leftSection={<IconApps />}>Manage apps</ChromeSurfaceItem>
    `);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.label)).toEqual(['Installed apps', 'Manage apps']);
    // …and it skips a template-literal href (the "Recently run" shape).
    expect(
      parseAllChromeLinks(
        '<ChromeSurfaceItem href={`/apps/run/${r.blockId}`} leftSection={<IconApps />}>x</ChromeSurfaceItem>'
      )
    ).toHaveLength(0);
  });

  it('the breadcrumb’s first crumb reads "Marketplace" and still links to /apps', () => {
    const src = code(read(CHROME));
    const anchor = 'data-testid="app-block-breadcrumb-apps"';
    const at = src.indexOf(anchor);
    expect(at, `${anchor} was not found in IframeHost.tsx`).toBeGreaterThan(-1);

    // The crumb element: from the testid forward to the closing </Anchor>.
    //
    // 🔴 THE CLOSING TAG IS PART OF THIS ASSERTION'S CORRECTNESS, NOT AN INCIDENTAL
    // DETAIL. This crumb is rendered with the site's `Anchor`; it used to be a
    // hand-styled `Text component={Link}`. A stale `</Text>` here does NOT fail
    // loudly — `indexOf` simply runs on to the NEXT `</Text>` in the file, which is
    // the dimmed `/` separator a few lines below, and `label` then picks up the
    // whole span between them. The failure message would talk about the crumb's
    // COPY while the real cause was the tag. If this crumb is ever re-homed onto a
    // different element, this string moves with it.
    const region = src.slice(at, src.indexOf('</Anchor>', at));
    const label = region.slice(region.indexOf('>') + 1).trim();
    expect(
      label,
      'the leading breadcrumb crumb must name `/apps` the way the store does ("Marketplace"), ' +
        'not "Apps" — a trail that names the page differently from the page’s own tab reads ' +
        'as leading somewhere else.'
    ).toBe('Marketplace');

    // …and it is still the LINK, not restyled into text.
    expect(src.slice(Math.max(0, at - 400), at)).toContain('href="/apps"');
  });
});
