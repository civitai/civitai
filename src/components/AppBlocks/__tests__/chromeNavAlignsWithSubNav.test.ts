import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The app-block host chrome's platform-nav dropdown must draw the store's
 * destinations the way the STORE draws them. Node `unit` project — the GATING
 * tier (the Vitest browser-mode `component` project is report-only in CI, so the
 * behavioural companion in `AppBlockChromePlatformNav.browser.test.tsx` cannot
 * block a merge).
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
 * The chrome's PLATFORM-NAV `<Menu.Item>`s, as `{href, label, icon}` rows.
 *
 * 🔴 SCOPED TO THE PLATFORM-NAV DROPDOWN, WHICH IS NOT COSMETIC. The chrome renders
 * a SECOND dropdown (the ⋮ overflow menu) whose "Manage apps" item also points at
 * `/apps/installed` — with a different, deliberate icon. A whole-file scan would
 * key both onto one href and either compare the wrong row or clobber it. The slice
 * is anchored on the `Civitai Apps` menu label, which is the dropdown's own
 * heading.
 */
function parsePlatformNav(src: string): NavEntry[] {
  const anchor = '<Menu.Label>Civitai Apps</Menu.Label>';
  const start = src.indexOf(anchor);
  expect(
    start,
    `the platform-nav anchor \`${anchor}\` was not found in IframeHost.tsx — the dropdown was ` +
      'restructured past this scanner. Re-point the anchor; do not delete the guard.'
  ).toBeGreaterThan(-1);
  const rest = src.slice(start + anchor.length);
  const end = rest.indexOf('</Menu.Dropdown>');
  expect(end, 'the platform-nav dropdown never closes — the slice is unbounded.').toBeGreaterThan(
    -1
  );
  const region = rest.slice(0, end);

  return [...region.matchAll(/<Menu\.Item\b([\s\S]*?)<\/Menu\.Item>/g)]
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
      <Menu.Label>Civitai Apps</Menu.Label>
      <Menu.Item
        component={Link}
        href="/apps"
        leftSection={<IconBuildingStore size={14} stroke={1.5} />}
      >
        Marketplace
      </Menu.Item>
      </Menu.Dropdown>
    `);
    expect(chrome).toEqual([{ href: '/apps', label: 'Marketplace', icon: 'IconBuildingStore' }]);

    // The comment stripper's own control. This is the defect this guard shipped
    // with on its first run: a JSX comment left a bare `{}` in the children, so
    // the extracted label was `'{}\n Marketplace'`. Both files carry JSX comments
    // directly above the elements being parsed, so this path is always exercised.
    expect(code('<Text>{/* explain */}Marketplace</Text>')).toBe('<Text>Marketplace</Text>');
    expect(code('a /* block */ b\n  // line\nc')).toBe('a  b\n\nc');

    // …and the scope control: an item in a LATER dropdown must not be picked up.
    const scoped = parsePlatformNav(`
      <Menu.Label>Civitai Apps</Menu.Label>
      <Menu.Item component={Link} href="/apps" leftSection={<IconBuildingStore />}>Marketplace</Menu.Item>
      </Menu.Dropdown>
      <Menu.Item component={Link} href="/apps/installed" leftSection={<IconApps />}>Manage apps</Menu.Item>
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

  it('the breadcrumb’s first crumb reads "Marketplace" and still links to /apps', () => {
    const src = code(read(CHROME));
    const anchor = 'data-testid="app-block-breadcrumb-apps"';
    const at = src.indexOf(anchor);
    expect(at, `${anchor} was not found in IframeHost.tsx`).toBeGreaterThan(-1);

    // The crumb element: from the testid forward to the closing </Text>.
    const region = src.slice(at, src.indexOf('</Text>', at));
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
