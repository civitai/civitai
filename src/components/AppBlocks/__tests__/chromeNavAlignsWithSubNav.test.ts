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
 * `/apps/activity` with a different, deliberate label. A whole-file scan would key
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
 * but that same scoping meant the ⋮ menu's "Manage apps" (`/apps/activity`) was
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

/** A link site in the chrome. `label` and `icon` are OPTIONAL because a real link in
 *  this file may carry neither — see `parseAllChromeLinks`. */
type ChromeLink = { tag: string; href: string; label: string | null; icon: string | null };

/** Drop every `{…}` expression from an attribute list, so `href="…"` is matched only
 *  when it is a LITERAL attribute of this tag. Two things this rules out: a
 *  `href={`/apps/run/${r.blockId}`}` template (not a platform route), and a nested
 *  `someProp={<Foo href="…"/>}` being attributed to the OUTER element. */
function stripAttrExpressions(attrs: string): string {
  let out = '';
  let depth = 0;
  for (const ch of attrs) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * EVERY element in the chrome that carries a LITERAL `href="…"` — whatever tag it is
 * written as, and whether or not it carries a `leftSection` glyph.
 *
 * 🔴 ROUND 4 WIDENED THIS, BECAUSE (d)'s MESSAGE CLAIMED A SET THIS PARSER DID NOT OWN.
 * The previous version matched `<ChromeSurfaceItem …>text</ChromeSurfaceItem>` and then
 * dropped anything without BOTH a literal href AND a `leftSection={<IconX`. Two ordinary
 * shapes walked straight through it, both measured surviving as mutants:
 *
 *   • `<ActionIcon component={Link} href="/apps/invites" …>` in the ⋮ overflow — and
 *     that is not an exotic shape, it is the one the chrome ALREADY uses for its `/apps`
 *     back-link (the compact-mode chevron);
 *   • `<ChromeSurfaceItem href="/apps/invites">Invites</ChromeSurfaceItem>` with no
 *     `leftSection` — which compiles, because `ChromeSurface.tsx` types that prop
 *     `leftSection?: ReactNode`, and which is the very element (d) claims to enumerate.
 *
 * Either one is a door out of a running app into a flag-gated route, offered
 * unconditionally, with all 8 tests green. So the parser now scans TAGS rather than one
 * tag name, and treats the glyph as optional metadata rather than a condition of
 * inclusion. What that costs is stated where it is paid: rule (b) below can only compare
 * a glyph an element actually HAS, so it now skips the icon-less links that (d) still
 * counts.
 *
 * 🔴 `icon` IS THE `leftSection` GLYPH ONLY — deliberately not "any Icon inside the
 * element". The back chevron renders `<IconChevronLeft/>` as its CHILD; that is a
 * directional affordance, not this route's glyph, and scoring it as one would make the
 * same-route rule red on correct code. The rule (b) enforces is about the picture in a
 * menu ROW, which is what `leftSection` is.
 *
 * Mechanics: an opening tag ends at the first `>` at brace depth 0 (`leftSection={<Icon
 * … />}` contains a `>` that is not the end of the tag), and scanning resumes AFTER that
 * `>` — so a nested `<Icon…>` inside the attribute region is never itself opened as an
 * element. The label is the element's text with nested tags removed, falling back to
 * `aria-label` (the back chevron has no text at all, and a null label would make (a)/(b)'s
 * failure messages name nothing). `</tag>` is matched by name, which is exact here because
 * none of these tags nest inside themselves; if one ever does, the LABEL is what goes
 * wrong, never the href set (d) owns.
 */
function parseAllChromeLinks(src: string): ChromeLink[] {
  const out: ChromeLink[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    const tag = /^[A-Za-z][\w.]*/.exec(src.slice(i + 1))?.[0];
    if (!tag) {
      i += 1;
      continue;
    }
    let depth = 0;
    let tagEnd = -1;
    for (let j = i + 1 + tag.length; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        tagEnd = j;
        break;
      }
    }
    if (tagEnd === -1) break;
    const attrs = src.slice(i + 1 + tag.length, tagEnd);
    const selfClosing = src[tagEnd - 1] === '/';
    i = tagEnd + 1;

    const href = /\bhref="([^"]+)"/.exec(stripAttrExpressions(attrs))?.[1];
    if (!href) continue;
    const icon = /\bleftSection=\{<(Icon\w+)/.exec(attrs)?.[1] ?? null;

    let label: string | null = null;
    if (!selfClosing) {
      const close = src.indexOf(`</${tag}>`, tagEnd);
      if (close !== -1) {
        label =
          src
            .slice(tagEnd + 1, close)
            .replace(/<[^>]*>/g, '')
            .trim() || null;
      }
    }
    if (!label) label = /\baria-label="([^"]+)"/.exec(attrs)?.[1] ?? null;

    out.push({ tag, href, label, icon });
  }
  return out;
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
    // `/apps/activity` sits after its own `<ChromeSurfaceLabel>App</…>`, and if the
    // slice ran past that label the two entries for one route would be keyed onto
    // each other and the icon comparison would be against the wrong row.
    const scoped = parsePlatformNav(`
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps" leftSection={<IconBuildingStore />}>Marketplace</ChromeSurfaceItem>
      <ChromeSurfaceLabel>App</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/activity" leftSection={<IconApps />}>Manage apps</ChromeSurfaceItem>
    `);
    expect(scoped.map((e) => e.href)).toEqual(['/apps']);
  });

  it('every platform-nav destination exists in the subnav and uses the subnav ICON', () => {
    const subnav = parseSubNav(code(read(SUBNAV)));
    const nav = parsePlatformNav(code(read(CHROME)));

    // 🔴 PARSE CONTROLS ONLY — deliberately far below the live counts. A zero is
    // indistinguishable from a parser wired to nothing, so it must never be the thing
    // that makes this pass; but a control pinned ON the live count STEALS the failure
    // from the rule below, reporting a parse problem for what is really a nav change.
    // The exact chrome set is owned by the `expected glyphs` test; the exact excluded
    // set by the ledger.
    expect(subnav.length, 'parsed no rows out of SUB_NAV_LINKS').toBeGreaterThanOrEqual(1);
    expect(nav.length, 'parsed no items out of the chrome platform nav').toBeGreaterThanOrEqual(1);

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

  /**
   * 🔴 THE EXCLUSION LEDGER — the half this guard could not previously express.
   *
   * The rule above is ONE-DIRECTIONAL: every chrome destination must exist in the
   * subnav, never the reverse. That is correct — the chrome is deliberately a strict
   * SUBSET (Invites / Revenue have always been subnav-only) — but it means a new
   * `SUB_NAV_LINKS` row is scored identically whether its absence from the chrome was a
   * decision or an oversight. Both readings pass, silently, which is the exact shape of
   * an unpinned decision.
   *
   * 🔴 THE SET SHRANK FROM FOUR TO TWO, AND NOT BY ADDING ANYTHING TO THE CHROME. The
   * store consolidated three subnav rows — "Build apps" (`/apps/get-started`), "Create"
   * (`/apps/submit`) and "My apps" (`/apps/mine`) — into ONE state-aware `/apps/build`.
   * Two of the three excluded routes therefore stopped being subnav rows at all, and the
   * chrome's `/apps/mine` item was REPOINTED to `/apps/build` rather than deleted (the
   * ledger's own message argues against deleting a door out of a running app, and
   * `/apps/mine` 301s there anyway, so leaving it would have made every press a redirect
   * hop). What survives is the pre-existing pair: authoring/owner-management surfaces
   * that do not belong in a menu opening over a RUNNING app.
   *
   * ⚠️ THE OLD RATIONALE'S SECOND LIMB IS RETIRED, AND IT IS WORTH SAYING WHY RATHER THAN
   * DELETING IT SILENTLY. It ran: `/apps/get-started` sits behind the
   * `appBlocksGetStarted` KILL SWITCH, this section reads no flags, so mirroring the entry
   * would keep offering a page that has been switched off. That argument was about a route
   * the chrome did not carry. Its successor `/apps/build` IS carried — but the chrome
   * already carried `/apps/mine`, which was itself flag-gated (`appBlocksAuthor` +
   * `isAppDeveloper`, a hard `notFound`), so an ungated link to a gated destination is the
   * STATUS QUO here and not something the repoint introduced. The behaviour change is
   * strictly in the harmless direction: a non-author pressing that item used to get a 404
   * and, if they hold `appBlocksGetStarted`, now gets a public pitch with no private data
   * on it. The PAGE decides, not the link.
   *
   * So this asserts the excluded SET, and fails when it GROWS (a new subnav row nobody
   * decided about) or SHRINKS (an entry added to the chrome without updating the note).
   * It is the deliberate alternative to loosening the guard.
   */
  it('🔴 the subnav rows deliberately ABSENT from the chrome are exactly these', () => {
    const subnav = parseSubNav(code(read(SUBNAV)));
    const nav = parsePlatformNav(code(read(CHROME)));
    const inChrome = new Set(nav.map((e) => e.href));

    // 🔴 PARSE CONTROLS, NOT LEDGERS — and the floors are deliberately far below the
    // live counts (8 and 4). Pinned ON those counts they MASK the ledger they were
    // meant to protect: adding a chrome item made `toBe(4)` fail first, with the
    // message "parsed no items out of the chrome platform nav: expected 5 to be 4" —
    // which states the opposite of what happened — and the `toEqual` below never ran,
    // leaving the ledger's SHRINK direction unproven. A zero on either side would make
    // the difference below trivially "everything" or "nothing", and that is all these
    // two are here to rule out; the SET is the `toEqual`'s to own, in both directions.
    expect(subnav.length, 'parsed no rows out of SUB_NAV_LINKS').toBeGreaterThanOrEqual(1);
    expect(inChrome.size, 'parsed no items out of the chrome platform nav').toBeGreaterThanOrEqual(
      1
    );

    expect(
      subnav.map((e) => e.href).filter((h) => !inChrome.has(h)),
      'a store subnav destination is missing from the app-block chrome. If that is ' +
        'deliberate, add it here WITH the reason; if it is not, add it to the chrome ' +
        '(the subnav is the source of truth, so the chrome follows).'
    ).toEqual([
      // Owner-management surfaces. Pre-existing exclusions: the chrome is navigation for
      // someone RUNNING an app, not managing one.
      //
      // 🔴 `/apps/invites` AND `/apps/submit` LEFT THIS LIST BY BEING DELETED FROM THE
      // SUBNAV, NOT BY BEING ADDED TO THE CHROME. Both routes were consolidated into
      // `/apps/build`, which the chrome DOES carry (repointed from `/apps/mine`) — so the
      // set shrank from four to two because `SUB_NAV_LINKS` shrank, which is exactly the
      // direction this ledger is meant to make visible.
      '/apps/invites',
      '/apps/revenue',
    ]);
  });

  it('the four shared destinations are the expected ones, drawn with the expected glyphs', () => {
    // The relationship test above is the real guard; this one names the resolved
    // values so a failure reads as a diff rather than sending you to two files.
    // It is NOT redundant coverage — it is what makes the other test's message
    // actionable, and it fails if the SHARED SET changes rather than just an icon.
    const nav = parsePlatformNav(code(read(CHROME)));
    expect(nav).toEqual([
      { href: '/apps', label: 'Marketplace', icon: 'IconBuildingStore' },
      { href: '/apps/activity', label: 'App activity', icon: 'IconPlugConnected' },
      { href: '/apps/build', label: 'My apps', icon: 'IconCode' },
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
    // heading and can afford one-word labels ("Activity", "Review"); these items
    // stand alone in a dropdown over a running app and need the noun. Asserting
    // equality here would force a wrong "fix" in one file or the other.
    expect(navByHref.get('/apps/activity')?.label).toBe('App activity');
    expect(navByHref.get('/apps/build')?.label).toBe('My apps');
    expect(navByHref.get('/apps/review')?.label).toBe('Review');
    expect(subByHref.get('/apps/activity')?.label).toBe('Activity');
  });

  it('ONE ROUTE, ONE ICON — every literal-href item in the chrome, both dropdowns', () => {
    // 🔴 THE RULE THIS PR EXISTS TO ENFORCE, APPLIED TO THE WHOLE COMPONENT. Two
    // items may legitimately carry different LABELS for one destination ("Manage
    // apps" from inside a running app vs "App activity" as a destination); they
    // may not carry different PICTURES, because the two dropdowns open a few pixels
    // apart in the same bar. Fixing only the platform nav would have relocated the
    // drift rather than removed it, which is what this test is here to prevent.
    const subnav = parseSubNav(code(read(SUBNAV)));
    const links = parseAllChromeLinks(chromeBody());
    const bySubNavHref = new Map(subnav.map((e) => [e.href, e]));

    // 🔴 PARSE CONTROL ONLY — AND, UNLIKE THE OTHER TWO FLOORS IN THIS FILE, IT HAS NO
    // SIBLING `toEqual` ELSEWHERE TO INHERIT ITS SET FROM. The floors in the two tests
    // above are safe to relax because something else owns their sets outright (the exact
    // 4-item platform nav; the exact excluded set). Nothing owned THIS parser's set, so
    // relaxing this one alone deleted a live detection — see (d), which was added to
    // restore it. A zero here is still indistinguishable from a regex wired to nothing,
    // and ruling that out is all this floor does; pinned on the live count it would
    // instead steal the failure from the rules below and report a nav change as a parse
    // error.
    expect(links.length, 'parsed no literal-href items out of the chrome').toBeGreaterThanOrEqual(
      1
    );

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
    //
    // 🔴 SCOPED TO THE LINKS THAT HAVE A `leftSection` GLYPH, which since round 4 is a
    // SUBSET of `links` rather than all of it. An element with no glyph cannot be drawing
    // the route with the WRONG one, so there is nothing here to compare; its presence in
    // the chrome is still owned outright by (d). The two live examples are the compact
    // back chevron and the breadcrumb crumb, neither of which is a menu row.
    for (const link of links.filter((l) => l.icon !== null)) {
      expect(
        link.icon,
        `same-route icon drift: "${link.label}" links to \`${link.href}\` with \`${link.icon}\`, ` +
          `but the store subnav draws that route with \`${bySubNavHref.get(link.href)?.icon}\`. ` +
          'One route must not wear two glyphs in one bar.'
      ).toBe(bySubNavHref.get(link.href)?.icon);
    }

    // (c) The pair that actually collided, named explicitly so the regression is
    // legible: two items, one route, and now one icon.
    const installed = links.filter((l) => l.href === '/apps/activity');
    expect(
      installed.map((l) => l.label).sort(),
      'the chrome should still offer BOTH `/apps/activity` entries — this rule is about ' +
        'their icons, not about removing one of them (that would be a behaviour change).'
    ).toEqual(['App activity', 'Manage apps']);
    expect(new Set(installed.map((l) => l.icon)).size).toBe(1);

    // (d) 🔴 THE LEDGER — the SET of routes the chrome links to, owned outright, so this
    // fails when it GROWS or SHRINKS.
    //
    // (a) and (b) are PER-LINK, so they catch an addition only when the added link is
    // itself wrong — an invented route, or the store's route under the wrong glyph. A new
    // item pointing at a route `SUB_NAV_LINKS` already carries, wearing that row's own
    // glyph, satisfies both and is invisible to them. Nor does anything else here close
    // the gap — the `expected glyphs` test enumerates the PLATFORM-NAV slice only, and (c)
    // enumerates the two `/apps/activity` LABELS only. So an item added to the ⋮ overflow
    // was invisible to every assertion in this file. Measured on the PRE-(d) tree: adding
    // `<ChromeSurfaceItem href="/apps/invites" leftSection={<IconMail …/>}>Invites
    // </ChromeSurfaceItem>` to the overflow passed all 8 tests. (d) kills that one now.
    //
    // 🔴 AND (d) ALONE WAS STILL NOT ENOUGH, WHICH IS WHY THIS COMMENT IS NOT THE END OF
    // THE STORY. Round 4 measured two FURTHER shapes surviving with (d) in place, because
    // the PARSER feeding it required both a literal `href` and a `leftSection` glyph — an
    // `<ActionIcon component={Link} href>` and a `leftSection`-less `<ChromeSurfaceItem>`.
    // Both are ordinary; the first is the shape the chrome already uses for its `/apps`
    // back-link. The ledger is only ever as wide as `parseAllChromeLinks` — read its
    // header before trusting the sentence below. (The fixture route in those two controls
    // is `/apps/invites`; it was `/apps/get-started` until that route was consolidated
    // away. The shapes are what the controls pin — the route is arbitrary, and must simply
    // be one the repo-wide retired-link sweep in `__tests__/pages/apps-build-redirects`
    // does not report.)
    //
    // That is not bookkeeping. `/apps/invites` is gated on `appBlocksAuthor`, and NO
    // literal-href item in this chrome is gated by a FEATURE FLAG except the
    // moderator-gated `/apps/review` — no flag decides whether a LINK here is offered.
    // (Two ARE conditional, on LAYOUT rather than a flag: the compact back chevron renders
    // only under `compact`, the breadcrumb crumb only under `isPage`. Neither can be
    // switched off in Flipt, which is what this argument turns on — so say "gated by no
    // flag", never "rendered unconditionally". Four earlier drafts of this sentence
    // overstated it in exactly that way.)
    //
    // 🔴 `/apps/build` IS IN THIS SET AND IS ITSELF FLAG-GATED (`canAccessAppsBuild`), SO
    // READ THE SENTENCE ABOVE PRECISELY: it is about whether a flag decides the LINK, not
    // the destination. That has been true here since before the consolidation — the item
    // this one replaced pointed at `/apps/mine`, gated on `appBlocksAuthor` — so the
    // repoint changed the route, not the property. The DELIBERATE SUBSET note above the
    // platform nav in `IframeHost.tsx` carries the full argument, including why the
    // repoint is a strict improvement (a refused viewer now gets a public pitch instead
    // of a 404) rather than a widening.
    //
    // 🔴 THAT IS NOT "THIS SURFACE CANNOT READ FLAGS" — it can, and the repo demonstrates
    // it a few lines away. `<ChromeReviewMenuItem>` (`IframeHost.tsx`) calls
    // `useOptionalFeatureFlags()` and returns null without `hasAppsStoreAccess(features)`,
    // and its `useCanReviewListing` narrows again through `resolveClientStoreScope`. It
    // carries no `href`, which is why it is not in this set — and it is exactly the shape a
    // gated door WOULD take. So a maintainer this ledger stops has two honest options, not
    // one: exclude the route, or add it gated the way that item is. What is not an option
    // is adding it as a plain link.
    //
    // SORTED, so a re-ORDER cannot report a route change that did not happen — this rule
    // is about the SET, and the platform-nav slice's own `toEqual` is what governs order
    // there. DUPLICATES KEPT: `/apps` and `/apps/activity` each legitimately appear more
    // than once, and collapsing to a Set would hide an extra item hung on a listed route.
    expect(
      links.map((l) => l.href).sort(),
      'the set of routes the app-block chrome links to has changed. Adding one is a ' +
        'product decision rather than a detail: NO literal-href item in this chrome is ' +
        'gated by a FEATURE FLAG except the moderator-gated `/apps/review`, so a ' +
        'flag-gated destination added here as a plain link keeps being offered after its ' +
        'flag goes down (that is why `/apps/invites` is excluded; see the DELIBERATE ' +
        'SUBSET note in `IframeHost.tsx`). The surface CAN read flags — ' +
        '`ChromeReviewMenuItem` gates itself on `hasAppsStoreAccess(useOptionalFeatureFlags())` ' +
        '— so "add it GATED, the way that item is" is a real third option alongside ' +
        'excluding it; adding it ungated is not. Removing one deletes a door out of a ' +
        'running app. Update this list deliberately, WITH the reason.'
    ).toEqual([
      '/apps', // Marketplace — platform nav
      '/apps', // the compact back chevron — `<ActionIcon component={Link}>`, no leftSection
      '/apps', // the breadcrumb's first crumb — `<Anchor component={Link}>`, no leftSection
      // 🔴 REPOINTED TWICE, AND THE SORT POSITION MOVED BOTH TIMES — the list is
      // `.sort()`ed, so neither move is a second change to review. `/apps/mine` →
      // `/apps/build` (301) sorted it before `/apps/installed`; `/apps/installed` →
      // `/apps/activity` (301) then sorted the pair back before it ('a' < 'b').
      '/apps/activity', // App activity — platform nav
      '/apps/activity', // Manage apps — ⋮ overflow; the pair (c) governs their labels
      '/apps/build', // My apps — platform nav; the store calls this row "Build"
      '/apps/review', // Review — platform nav, moderator-gated
    ]);
  });

  it('the whole-chrome parser sees BOTH sections — positive control', () => {
    // The scoped parser stops at the next `<ChromeSurfaceLabel>` by design. If this
    // one inherited that bound it would silently score the ⋮ overflow's items as
    // absent and the rule above would pass over exactly the site it was written for.
    const found = parseAllChromeLinks(`
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/activity" leftSection={<IconPlugConnected />}>App activity</ChromeSurfaceItem>
      <ChromeSurfaceLabel>App</ChromeSurfaceLabel>
      <ChromeSurfaceItem href="/apps/activity" leftSection={<IconApps />}>Manage apps</ChromeSurfaceItem>
    `);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.label)).toEqual(['App activity', 'Manage apps']);
    // …and it skips a template-literal href (the "Recently run" shape).
    expect(
      parseAllChromeLinks(
        '<ChromeSurfaceItem href={`/apps/run/${r.blockId}`} leftSection={<IconApps />}>x</ChromeSurfaceItem>'
      )
    ).toHaveLength(0);

    // 🔴 THE TWO SHAPES ROUND 4 ADDED, AS FIXTURES. Both were measured SURVIVING as
    // mutants against the pre-round-4 parser (8 passed, the fixture route invisible to
    // every assertion in this file). A widened parser that silently stopped matching them
    // again would restore that hole while looking exactly like this — so the shapes are
    // pinned here, not merely described in the comment above.
    //
    // P1: the `<ActionIcon component={Link} href>` shape, which the chrome ALREADY uses
    // for its `/apps` back-link. No text child and no `leftSection`, so the label comes
    // from `aria-label` and the icon is null.
    expect(
      parseAllChromeLinks(
        '<ActionIcon component={Link} href="/apps/invites" aria-label="Invites">' +
          '<IconCode size={16} stroke={1.5} /></ActionIcon>'
      )
    ).toEqual([{ tag: 'ActionIcon', href: '/apps/invites', label: 'Invites', icon: null }]);

    // P2: a `ChromeSurfaceItem` with NO `leftSection` — legal, because the primitive types
    // it `leftSection?: ReactNode`. The old parser required the glyph for INCLUSION.
    expect(
      parseAllChromeLinks('<ChromeSurfaceItem href="/apps/invites">Invites</ChromeSurfaceItem>')
    ).toEqual([{ tag: 'ChromeSurfaceItem', href: '/apps/invites', label: 'Invites', icon: null }]);

    // …and the negative control for `stripAttrExpressions`: an href nested inside ANOTHER
    // element in the attribute region is that element's, not this one's. Without the
    // strip, the outer tag would be reported as linking to `/apps/invites`.
    expect(
      parseAllChromeLinks(
        '<ChromeSurfaceItem leftSection={<Foo href="/apps/invites" />}>x</ChromeSurfaceItem>'
      )
    ).toEqual([]);
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
