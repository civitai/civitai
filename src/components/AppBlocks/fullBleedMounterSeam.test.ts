import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE `page.fullBleed` MOUNTER SEAM — the relationship no single component owns.
 *
 * 🔴 THE DEFECT THIS EXISTS FOR, MEASURED, NOT IMAGINED. Replacing ALL FIVE
 * mounter-side forwardings of the resolved `fullBleed` value with a literal `false`
 * made the feature inert on all three surfaces — the public run page, the author dev
 * tunnel and the moderator review preview — and THE NODE TIER DID NOT NOTICE. Every
 * component was hermetically covered: `PageBlockHost` has a measured two-point width
 * case (`PageBlockHostMaxWidth.browser.test.tsx`), the manifest read has resolver
 * tests, the validator has schema tests. None of them ever built the COMBINED state,
 * because each fixture supplied the prop itself. The bug lives in the wiring between
 * them, which is exactly the surface nobody's test loads.
 *
 * ⚠️ THE SCOPE OF THAT CLAIM, BECAUSE AN EARLIER VERSION OF THIS PARAGRAPH QUOTED
 * TWO COUNTS WITHOUT ONE. It read "left 302 node files / 6,475 tests AND 26/26
 * browser tests GREEN". Both were narrowed runs stated as if they were tiers: the
 * node tier is ~1,787 files, so 302 of them is roughly a sixth of it, and the 26 was
 * two browser files.
 *
 *   · THE NODE HALF HOLDS AT TIER SCOPE — re-measured, not inherited. With all five
 *     forwardings set to `false` AND THIS FILE DELETED (so it cannot be the thing
 *     catching the mutation), the whole `unit*` project ran 1,786 files / 40,666
 *     tests and returned three failures, all three in
 *     `src/server/__tests__/eventloop-watchdog.capture.test.ts` — a wall-clock file
 *     whose unmutated baseline on the same tree was already two failures out of the
 *     same nine, at 1,787 files / 40,678 tests. Nothing else moved. (Those totals are
 *     a scope marker for the run, not a target: they drift with every commit and
 *     nothing fails when they do.)
 *   · THE BROWSER HALF IS NOT RESTATED, BECAUSE IT NO LONGER HOLDS AND MUST NOT BE
 *     RE-DERIVED. The commit that added this file also added `a mint that DECLARES
 *     page.fullBleed reaches the host, and one that does not DOES NOT` to
 *     `ReviewBlockPreviewHost.browser.test.tsx`, which closes site 5. Measured on the
 *     current tree with the same five-site mutation and this file deleted, those two
 *     browser files come back 1 failed / 23 passed and the failure is that case — so
 *     a browser run does not sit green through this mutation any more, and the
 *     historical "26/26" cannot be reproduced without deleting that case too. Sites
 *     1–4 were NOT re-measured at browser-tier scope; no claim is made about them
 *     there.
 *
 * The existing structural pin — "`fullBleed` is a REQUIRED prop"
 * (`pageBlockHostMaxWidth.test.ts`) — catches an OMITTED prop via `tsc` and can
 * never catch a WRONG one: `fullBleed={false}` type-checks everywhere.
 *
 * WHAT THIS FILE PINS, AND WHY IN THIS SHAPE.
 *
 *   1. THE LEDGER (a RELATIONSHIP, and it fails on GROWTH and on SHRINK). Every
 *      mounter of `PageBlockHost` in the tree, and every SSR props projection under
 *      `src/pages/apps` that carries the sibling field, is DISCOVERED by parsing
 *      the tree and then compared against an asserted list. A new mounting surface
 *      that forwards a constant fails here on the day it lands rather than on the
 *      day someone remembers this file; a removed one fails too, so the ledger
 *      cannot quietly describe a tree that no longer exists.
 *
 *   2. EACH SITE'S EXPRESSION, TWICE OVER. Once against the pinned normalised
 *      string, and once against the SIBLING FIELD `bootSkeleton` — `fullBleed` must
 *      be forwarded by the same expression with the identifier renamed. The sibling
 *      check is what makes this more than a spelling pin: `bootSkeleton` travels the
 *      identical path for the identical reason (it is the other manifest-declared
 *      presentation field), so "these two must agree" is a claim that survives a
 *      refactor of either one, while a lone hardcoded string only survives until
 *      someone reformats. Neither check alone is enough — the sibling check passes
 *      if BOTH fields are broken together, and the string check passes if the
 *      expression is reworded into something equally wrong-but-parallel.
 *
 *   3. BEHAVIOUR, TWO-POINT, ON ALL FOUR PAGE-SIDE SITES. A structural check
 *      type-checks straight past a wrong argument, so the two page mounters are
 *      actually EXERCISED: their `getServerSideProps` resolvers are run (sites 1 and
 *      3) and their components are rendered (sites 2 and 4), each with a declaring
 *      AND a non-declaring input through the SAME path, asserting the two outcomes
 *      DIFFER. A single-point case ("declares true → full bleed") passes against an
 *      implementation hardcoded to `true`, so no case here has one.
 *
 * The fifth site — `ReviewBlockPreviewHost` — is exercised behaviourally in
 * `src/components/Apps/ReviewBlockPreviewHost.browser.test.tsx` (the browser tier is
 * where that component's sibling `bootSkeleton` coverage already lives, and where a
 * real mount is cheap). It is in this file's ledger for the structural half only.
 *
 * ⚠️ WHAT THIS FILE DOES **NOT** CLAIM, stated so nobody reads more into it.
 *
 *   · IT NEVER MEASURES A WIDTH — no node-tier test can. `data-full-bleed` is the
 *     attribute `PageBlockHost` stamps from the prop, so what Part 3 asserts is
 *     "the declaration reaches the host". The separate claim "the host then omits
 *     the cap" belongs to `PageBlockHostMaxWidth.browser.test.tsx`'s MANIFEST case.
 *     Two claims, two tiers — and the whole point of this file is that holding both
 *     of those was not enough.
 *
 *   · THE SSR HALF OF THE DISCOVERY IS SCOPED TO `src/pages/apps`. An SSR projection
 *     added under some other route root would not be enumerated here. Its JSX
 *     consumer still would be — the `PageBlockHost` scan is over all of `src/` — so
 *     the mounter cannot hide, but the props hop feeding it could. Widening the scan
 *     to every page in the repo costs a parse of the whole `src/pages` tree for a
 *     case that does not exist today; if a second app route root ever appears, add
 *     it to `sourceFiles('src/pages/apps', …)` rather than assuming it is covered.
 *
 *   · IT SAYS NOTHING ABOUT THE SERVICE PROJECTIONS that produce the value in the
 *     first place. Those are owned by `block-registry.resolve-page.test.ts`,
 *     `block-registry.resolve-dev.test.ts` (both dev-tunnel reads) and
 *     `publish-request.mintReviewToken.test.ts`.
 *
 * 🔴 WHY THIS FILE IS **NOT** UNDER `__tests__/` LIKE ITS SIBLING SOURCE GUARDS.
 * `tsconfig.json` excludes `src/**' + '/__tests__/**`, so a guard placed there is never
 * typechecked. Measured, not assumed: a planted `const x: number = 'str'` in this
 * file under `__tests__/` left `pnpm run typecheck` reporting `OK — 0 type errors`,
 * while the identical line at THIS path fails it with TS2322 (rc=2). Every pin below
 * reads the tree through the TypeScript compiler API and grades it against typed
 * ledger entries, so type coverage is part of what keeps it honest —
 * `PageBlockHostMaxWidth.browser.test.tsx` sits outside `__tests__` for the same
 * structural reason. If you move this file, fix `REPO_ROOT`'s depth and re-run the
 * mutation matrix.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PART 3's harness. Both page modules are imported for real, with their server
// and component dependencies stubbed — `~/server/db/client`, `~/env/server`,
// `~/server/redis/client` and `~/server/logging/client` are already registered
// canonically in `src/__tests__/setup.ts`, so they are deliberately NOT mocked
// here (`no-direct-shared-module-mock.test.ts` fails a file that does).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BOTH resolvers, captured off the shared `createServerSideProps` factory.
 *
 * Routed by module-evaluation order (the run page's import statement precedes the
 * dev page's below, and ESM evaluates in source order). That assumption is not
 * trusted: each SSR test asserts its OWN registry mock was called, so a swap would
 * fail loudly instead of silently grading the other page.
 */
const capture = vi.hoisted(() => ({
  resolvers: [] as Array<(c: any) => Promise<any>>,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capture.resolvers.push(opts.resolver);
    return async () => ({ props: {} });
  },
}));

const registry = vi.hoisted(() => ({
  resolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  resolveDevPageBlockForAuthor: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/services/block-registry.service', () => ({ BlockRegistry: registry }));

vi.mock('~/server/services/blocks/app-listing-beta.service', () => ({
  readListingBetaBySlugForRender: vi.fn(async () => ({ isBeta: false, betaMessage: null })),
}));
vi.mock('~/server/services/blocks/app-listing-icon.service', () => ({
  readListingIconBySlugForRender: vi.fn(async () => null),
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/server-domain', () => ({ ratingAllowedOnHost: () => true }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: vi.fn(async () => true),
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: vi.fn(async () => null),
}));

/**
 * 🔴 THE INSTRUMENT FOR PART 3. The stub reports the prop it was handed as a DOM
 * attribute rather than swallowing it, which is the single thing whose absence made
 * all four page-side sites reversible: every other stub of this component in the
 * repo renders `null`, so a forwarding could be replaced by a constant with nothing
 * to read it back.
 *
 * `data-full-bleed` is deliberately the SAME attribute the real `PageBlockHost`
 * stamps, so this assertion and the browser-tier width assertion and a human
 * debugging the live page are all pointed at one signal.
 */
vi.mock('~/components/AppBlocks/PageBlockHost', async () => {
  const react = await import('react');
  return {
    PageBlockHost: (props: { fullBleed?: unknown; bootSkeleton?: unknown }) =>
      react.createElement('div', {
        'data-testid': 'page-host',
        'data-full-bleed': String(props.fullBleed),
        'data-boot-skeleton': String(props.bootSkeleton),
      }),
  };
});

vi.mock('~/components/AppBlocks/useBlockToken', () => ({
  // A token that resolved cleanly: the dev page renders `PageBlockHost` only when
  // `iframeSrc` is set AND `error == null`, so a mint-failure shape would make both
  // arms of its two-point case render the failure card and agree vacuously.
  useBlockToken: () => ({
    token: 'tok_seam',
    expiresAt: '2099-01-01T00:00:00Z',
    needsConsent: false,
    missingScopes: [],
    domain: null,
    maxBrowsingLevel: 1,
    effectiveBrowsingLevel: 1,
    error: null,
    terminal: false,
    refresh: () => undefined,
  }),
}));

vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('~/components/AppBlocks/blockPreconnect', () => ({ blockPreconnectHint: () => null }));
vi.mock('~/components/Apps/recentlyOpenedAppsStore', () => ({
  recordRecentlyOpenedApp: vi.fn(),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// Wholesale factory (the real module throws without a provider). BOTH flag hooks
// are named because a wholesale replacement that omits one makes this file fail to
// IMPORT the day anything in its graph reaches for the other — zero tests collected,
// zero failures reported, which reads exactly like a pass.
// `featureFlagsMockCompleteness.test.ts` enforces it, and caught this file.
// `vi.hoisted`, not a plain module-scope const: `vi.mock` factories are hoisted
// above every declaration in this file, so a bare const read from inside one is a
// TDZ error at import time — which surfaces as a COLLECTION failure (zero tests),
// the exact silent shape the guard above is about.
const flags = vi.hoisted(() => ({
  appBlocks: true,
  appBlocksPages: true,
  appBlocksAuthor: true,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => flags,
  useOptionalFeatureFlags: () => flags,
}));

/**
 * Mantine, reduced to the layout primitives the two pages use. `Box` MUST render
 * its children: on the run page the host lives inside one, so a `() => null` stub
 * (the spelling every other page test in this repo uses, because none of them
 * render) would delete the element under test and leave both arms matching zero.
 */
vi.mock('@mantine/core', async () => {
  const react = await import('react');
  const passthrough = (name: string) => {
    const C = ({ children }: { children?: React.ReactNode }) =>
      react.createElement('div', { 'data-mantine': name }, children);
    C.displayName = name;
    return C;
  };
  return {
    Alert: passthrough('Alert'),
    Box: passthrough('Box'),
    Code: passthrough('Code'),
    Group: passthrough('Group'),
    Stack: passthrough('Stack'),
    Text: passthrough('Text'),
    Title: passthrough('Title'),
    useComputedColorScheme: () => 'dark',
  };
});

// Only the run page's beta-notice glyph is reachable from either module.
vi.mock('@tabler/icons-react', () => ({ IconFlask: () => null }));

// eslint-disable-next-line import/first
import RunPage from '~/pages/apps/run/[slug]/[[...path]]';
// eslint-disable-next-line import/first
import DevTunnelPage from '~/pages/apps/dev/[blockId]';

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 + 2: the ledger and the pinned expressions.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RUN_PAGE = 'src/pages/apps/run/[slug]/[[...path]].tsx';
const DEV_PAGE = 'src/pages/apps/dev/[blockId].tsx';
const REVIEW_HOST = 'src/components/Apps/ReviewBlockPreviewHost.tsx';

/**
 * 🔴 THE ASSERTED LEDGER. Every place a resolved `page.fullBleed` is handed onward
 * on the mounter side, with the exact expression that must carry it.
 *
 * `kind` is how the site is FOUND, not a label: `jsx` sites are located by parsing
 * for a `<PageBlockHost>` element anywhere in `src/`, `ssr` sites by parsing for an
 * object literal that carries the sibling `bootSkeleton` key anywhere under
 * `src/pages/apps/`. So the discovery is over the TREE and this list is what the
 * tree is compared against — growth and shrink both fail.
 */
const LEDGER: Array<{ file: string; kind: 'jsx' | 'ssr'; expr: string }> = [
  // 1. The public run page's SSR projection — the manifest value leaving the server.
  { file: RUN_PAGE, kind: 'ssr', expr: 'page.fullBleed' },
  // 2. The same page's JSX prop — the value reaching the host.
  { file: RUN_PAGE, kind: 'jsx', expr: 'fullBleed={fullBleed}' },
  // 3. The author dev tunnel's SSR projection.
  { file: DEV_PAGE, kind: 'ssr', expr: 'app.fullBleed' },
  // 4. The author dev tunnel's JSX prop.
  { file: DEV_PAGE, kind: 'jsx', expr: 'fullBleed={fullBleed}' },
  // 5. The moderator review preview — the surface that IS the approval gate for
  //    this field, since the manifest declaration replaced a platform-side CSS
  //    ledger only a deploy could change.
  { file: REVIEW_HOST, kind: 'jsx', expr: 'fullBleed={mintData.fullBleed === true}' },
];

/** Collapse whitespace so a pin grades the EXPRESSION, never its formatting. */
const norm = (src: string) => src.replace(/\s+/g, ' ').trim();

const repoPath = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

/** Every non-test source file under a repo-relative root, recursively. */
function sourceFiles(rel: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      if (!exts.some((e) => entry.name.endsWith(e))) continue;
      out.push(abs);
    }
  };
  walk(path.join(REPO_ROOT, rel));
  return out.sort();
}

function parse(abs: string): ts.SourceFile {
  return ts.createSourceFile(
    abs,
    fs.readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

type Site = { file: string; kind: 'jsx' | 'ssr'; fullBleed?: string; bootSkeleton?: string };

/**
 * DISCOVERY — a real parse, never a text search.
 *
 * A text search cannot tell `fullBleed={fullBleed}` on the host from the same
 * characters inside a comment or a neighbouring element, and this repo has already
 * had two source guards defeated by exactly where characters fell. It also cannot
 * answer "is this attribute on THIS element", which is the whole question.
 */
function discover(): Site[] {
  const sites: Site[] = [];

  // JSX: every `<PageBlockHost …>` anywhere in src/, test files excluded.
  for (const abs of sourceFiles('src', ['.tsx'])) {
    const text = fs.readFileSync(abs, 'utf8');
    // Cheap pre-filter only — anything it lets through is still parsed, and
    // anything it rejects provably contains no such element.
    if (!text.includes('PageBlockHost')) continue;
    const sf = parse(abs);
    const visit = (n: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        n.tagName.getText() === 'PageBlockHost'
      ) {
        const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
        const pick = (name: string) => {
          const a = attrs.find((x) => x.name.getText() === name);
          return a ? norm(a.getText()) : undefined;
        };
        sites.push({
          file: repoPath(abs),
          kind: 'jsx',
          fullBleed: pick('fullBleed'),
          bootSkeleton: pick('bootSkeleton'),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // SSR: every object literal under src/pages/apps carrying the sibling key.
  for (const abs of sourceFiles('src/pages/apps', ['.tsx', '.ts'])) {
    const sf = parse(abs);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const props = n.properties.filter(ts.isPropertyAssignment);
        const pick = (name: string) => {
          const p = props.find((x) => x.name.getText() === name);
          return p ? norm(p.initializer.getText()) : undefined;
        };
        const bootSkeleton = pick('bootSkeleton');
        if (bootSkeleton !== undefined) {
          sites.push({
            file: repoPath(abs),
            kind: 'ssr',
            fullBleed: pick('fullBleed'),
            bootSkeleton,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  return sites;
}

describe('page.fullBleed — the mounter seam', () => {
  /**
   * POSITIVE CONTROL FOR THE WALK ITSELF. Every claim below is about a discovered
   * SET; if the walk returns nothing — a moved directory, a rename, a `readdirSync`
   * that silently found no `.tsx` — the ledger comparison would be the only thing
   * that failed, and the per-site checks would be vacuously true. Asserting the walk
   * saw a realistic slice of the tree first means a zero can never read as a pass.
   */
  it('CONTROL — the tree walk actually reached the source tree', () => {
    const tsx = sourceFiles('src', ['.tsx']);
    expect(
      tsx.length,
      'the walk over src/ found almost no .tsx files — it is looking at the wrong place, and ' +
        'every discovery-based assertion in this file is vacuous'
    ).toBeGreaterThan(500);
    const pages = sourceFiles('src/pages/apps', ['.tsx', '.ts']);
    expect(pages.length, 'the walk over src/pages/apps found nothing').toBeGreaterThan(3);
  });

  /**
   * 🔴 THE LEDGER, FAILING IN BOTH DIRECTIONS.
   *
   * GROWTH is the direction that matters most and the one a hand-written list
   * cannot have: `fullBleed` is a required prop, so a fourth mounting surface
   * compiles the moment it passes ANY boolean — including `false`. It appears here
   * the day it lands, with a message telling its author what the obligation is.
   *
   * SHRINK matters because a ledger describing a tree that no longer exists reads as
   * coverage while providing none: a site deleted or renamed would leave its pin
   * grading nothing, silently.
   */
  it('LEDGER — the tree forwards `fullBleed` at exactly the five asserted sites, no more and no fewer', () => {
    const found = discover()
      .map((s) => `${s.kind}:${s.file}`)
      .sort();
    const expected = LEDGER.map((s) => `${s.kind}:${s.file}`).sort();
    expect(
      found,
      'the set of places that forward the resolved `page.fullBleed` onward has CHANGED.\n' +
        'EXTRA entries: a new surface mounts `PageBlockHost` (or a new SSR projection carries ' +
        '`bootSkeleton`) and is not in this file\'s LEDGER. It must be added AND given a ' +
        'two-point behavioural case — `fullBleed` is a required prop, so the new surface ' +
        'compiles while passing a constant, and an app that declared the field renders capped ' +
        'there with every gate green. That is the exact defect this file exists for.\n' +
        'MISSING entries: a forwarding was deleted or renamed. Re-point the LEDGER ' +
        'deliberately — a pin that grades nothing reads as coverage and is worse than none.'
    ).toEqual(expected);
  });

  /**
   * 🔴 EACH SITE'S EXPRESSION, PINNED TWO WAYS.
   *
   * The literal pin catches the mutation this file was written for — every one of
   * the five replaced by `false` was green across both tiers — and it catches
   * `true` just as well, which a "the identifier appears" check would not.
   *
   * The SIBLING pin is the half that is a relationship rather than a spelling.
   * `bootSkeleton` is the other manifest-declared presentation boolean and travels
   * the identical path for the identical reason, so `fullBleed` must be forwarded by
   * the same expression with the identifier renamed. A refactor that legitimately
   * changes how these values travel changes both and stays green; a change that
   * touches only one is either a defect or a deliberate divergence that should be
   * re-pinned here on purpose.
   *
   * ⚠️ AND NEITHER IS SUFFICIENT ALONE, WHICH IS WHY BOTH ARE HERE. The sibling
   * check alone passes when BOTH fields are broken together (`bootSkeleton={false}
   * fullBleed={false}` is perfectly parallel). The literal check alone passes when
   * the expression is reformatted into something equally wrong that happens to match
   * a stale pin. They fail on different mutations.
   */
  it.each(LEDGER.map((s) => [`${s.kind} @ ${s.file}`, s] as const))(
    'SITE %s forwards the resolved value, pinned against the literal AND against `bootSkeleton`',
    (label, expectedSite) => {
      const site = discover().find(
        (s) => s.file === expectedSite.file && s.kind === expectedSite.kind
      );
      expect(site, `${label} was not found in the tree at all — see the LEDGER test`).toBeDefined();

      expect(
        site!.fullBleed,
        `${label} no longer forwards \`fullBleed\` with the pinned expression. A literal ` +
          '(`false` or `true`) type-checks here and makes the app\'s own manifest declaration ' +
          'inert on this surface with every node and browser test still green — measured, on ' +
          'all five sites at once. If the expression changed legitimately, re-pin it.'
      ).toBe(expectedSite.expr);

      expect(
        site!.bootSkeleton,
        `${label} no longer forwards \`bootSkeleton\`, so the sibling comparison below has ` +
          'nothing to compare against and this site is pinned by the literal only'
      ).toBeDefined();

      // The relationship: same expression, one identifier renamed.
      const parallel = site!.bootSkeleton!.replace(/\bbootSkeleton\b/g, 'fullBleed');
      expect(
        site!.fullBleed,
        `${label} forwards \`fullBleed\` by a DIFFERENT route than \`bootSkeleton\`. The two ` +
          'are the manifest-declared presentation fields and travel the same path for the same ' +
          `reason; \`bootSkeleton\` here is \`${site!.bootSkeleton}\`, which makes the parallel ` +
          `\`${parallel}\`. A divergence is either a defect or something to re-pin on purpose.`
      ).toBe(parallel);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 3: the two page mounters, actually exercised.
// ─────────────────────────────────────────────────────────────────────────────

/** The one attribute under test, read back out of the rendered markup. */
function fullBleedOf(markup: string): string {
  const matches = [...markup.matchAll(/data-full-bleed="([^"]*)"/g)];
  expect(
    matches.length,
    `expected exactly ONE \`data-full-bleed\` in the rendered page, found ${matches.length}. ` +
      'Zero means the host never rendered — the assertion below would be vacuous rather than ' +
      'false. More than one means this read is grading an arbitrary occurrence. Markup was:\n' +
      markup.slice(0, 600)
  ).toBe(1);
  return matches[0][1];
}

const RUN_PAGE_PROPS = {
  appBlockId: 'apb_seam',
  blockId: 'seam-app',
  appId: 'app_seam',
  appName: 'Seam App',
  pageTitle: 'Seam App',
  iframeSrc: 'https://seam-app.civit.ai/',
  bootSkeleton: false,
  fullBleed: false,
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  slug: 'seam-app',
  scopes: [] as string[],
  isBeta: false,
  betaMessage: null,
  iconUrl: undefined,
};

const DEV_PAGE_PROPS = {
  appBlockId: 'apb_seam',
  blockId: 'seam-app',
  appId: 'app_seam',
  appName: 'Seam App',
  pageTitle: 'Seam App',
  status: 'pending',
  trustTier: 'unverified' as const,
  sandbox: 'allow-scripts',
  scopes: [] as string[],
  iframeSrc: 'https://dev-0123456789abcdef.civit.ai/?dev=tok',
  bootSkeleton: false,
  fullBleed: false,
  host: 'dev-0123456789abcdef.civit.ai',
};

/**
 * The resolved page the run route's registry hands back. Only `fullBleed` moves
 * between the two arms of every case below.
 */
const RESOLVED_PAGE = {
  appBlockId: 'apb_seam',
  blockId: 'seam-app',
  appId: 'app_seam',
  name: 'Seam App',
  pageTitle: 'Seam App',
  iframeSrc: 'https://seam-app.civit.ai/',
  bootSkeleton: false,
  fullBleed: false,
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  scopes: [] as string[],
  contentRating: 'g',
};

const RESOLVED_DEV_APP = {
  appBlockId: 'apb_seam',
  blockId: 'seam-app',
  appId: 'app_seam',
  status: 'pending',
  trustTier: 'unverified' as const,
  name: 'Seam App',
  pageTitle: 'Seam App',
  sandbox: 'allow-scripts',
  scopes: [] as string[],
  bootSkeleton: false,
  fullBleed: false,
  contentRating: null,
};

function runCtx() {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    session: { user: { id: 555, username: 'dev', isModerator: false } },
    ctx: { params: { slug: 'seam-app' }, req: { headers: { host: 'civitai.com' } } },
  };
}

function devCtx() {
  return {
    features: { appBlocks: true, appBlocksAuthor: true },
    session: { user: { id: 555, username: 'dev', isModerator: false } },
    ctx: {
      params: { blockId: 'seam-app' },
      resolvedUrl: '/apps/dev/seam-app',
      req: { headers: { host: 'civitai.com' } },
      res: { setHeader: () => undefined },
    },
  };
}

describe('page.fullBleed — the mounter seam, exercised', () => {
  beforeEach(() => {
    registry.resolvePageBlockBySlug.mockReset();
    registry.resolveDevPageBlockForAuthor.mockReset();
  });

  it('CONTROL — both page modules registered a getServerSideProps resolver', () => {
    // Without this the two SSR cases below would fail with "resolver not captured",
    // which reads as a harness fault rather than as the claim they make.
    expect(
      capture.resolvers.length,
      'the two page modules did not both call `createServerSideProps` — the capture mock is ' +
        'not intercepting, and the SSR cases below are testing nothing'
    ).toBe(2);
  });

  /**
   * SITE 1 — `/apps/run/[slug]`, the SSR projection. TWO POINTS through the same
   * resolver; the resolved page differs in one field.
   */
  it('SITE 1 (run page SSR) carries the resolved `fullBleed` through to the page props', async () => {
    const resolver = capture.resolvers[0];
    registry.resolvePageBlockBySlug.mockResolvedValue({ ...RESOLVED_PAGE, fullBleed: true });
    const declared = await resolver(runCtx());
    expect(
      registry.resolvePageBlockBySlug,
      'the FIRST captured resolver is not the run page\'s — the two page modules evaluated in ' +
        'the other order and every claim in this test is about the wrong route'
    ).toHaveBeenCalled();
    expect(
      declared.props.fullBleed,
      'an app whose approved manifest declares `page.fullBleed` reaches the run page with ' +
        '`fullBleed: false`. The declaration dies in `getServerSideProps` and the app renders ' +
        'capped on the PUBLIC surface, with nothing failing.'
    ).toBe(true);

    registry.resolvePageBlockBySlug.mockResolvedValue({ ...RESOLVED_PAGE, fullBleed: false });
    const undeclared = await resolver(runCtx());
    expect(
      undeclared.props.fullBleed,
      'an app that declares NOTHING reaches the run page with `fullBleed: true` — the ' +
        'projection is hardcoded or inverted and the cap is no longer the default'
    ).toBe(false);

    expect(
      declared.props.fullBleed === undeclared.props.fullBleed,
      'both arms produced the same value, so the resolved manifest is not what moves it'
    ).toBe(false);
  });

  /**
   * SITE 2 — `/apps/run/[slug]`, the JSX prop. The page COMPONENT is rendered, so a
   * prop replaced by a constant is visible even though the SSR projection above is
   * still correct. Those are genuinely different failures at the same route.
   */
  it('SITE 2 (run page render) hands its `fullBleed` prop to the host', () => {
    const declared = fullBleedOf(
      renderToStaticMarkup(
        React.createElement(RunPage as any, { ...RUN_PAGE_PROPS, fullBleed: true })
      )
    );
    expect(
      declared,
      'the run page rendered with `fullBleed: true` still hands the host `false`. The page ' +
        'props are right and the JSX forwarding is a constant, so the public surface is capped ' +
        'for every app regardless of its manifest.'
    ).toBe('true');

    const undeclared = fullBleedOf(
      renderToStaticMarkup(
        React.createElement(RunPage as any, { ...RUN_PAGE_PROPS, fullBleed: false })
      )
    );
    expect(
      undeclared,
      'the run page rendered with `fullBleed: false` hands the host `true` — the forwarding is ' +
        'a constant in the other direction and every app is uncapped'
    ).toBe('false');

    expect(
      declared === undeclared,
      'both arms handed the host the same value, so the page prop is not what moves it'
    ).toBe(false);
  });

  /**
   * SITE 3 — `/apps/dev/[blockId]`, the SSR projection. This is the surface an
   * author checks their OWN app on before submitting, so a constant here is the one
   * that makes them conclude the manifest field does nothing.
   */
  it('SITE 3 (dev tunnel SSR) carries the resolved `fullBleed` through to the page props', async () => {
    const resolver = capture.resolvers[1];
    registry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...RESOLVED_DEV_APP,
      fullBleed: true,
    });
    const declared = await resolver(devCtx());
    expect(
      registry.resolveDevPageBlockForAuthor,
      'the SECOND captured resolver is not the dev tunnel\'s — the modules evaluated in the ' +
        'other order and this test is about the wrong route'
    ).toHaveBeenCalled();
    expect(
      declared.props.fullBleed,
      'an app whose manifest declares `page.fullBleed` reaches the DEV TUNNEL with ' +
        '`fullBleed: false`. The one surface that exists to show an author their own app ' +
        'pre-approval is the one surface that cannot show them this field.'
    ).toBe(true);

    registry.resolveDevPageBlockForAuthor.mockResolvedValue({
      ...RESOLVED_DEV_APP,
      fullBleed: false,
    });
    const undeclared = await resolver(devCtx());
    expect(
      undeclared.props.fullBleed,
      'an app that declares nothing reaches the dev tunnel with `fullBleed: true`'
    ).toBe(false);

    expect(
      declared.props.fullBleed === undeclared.props.fullBleed,
      'both arms produced the same value, so the resolution is not what moves it'
    ).toBe(false);
  });

  /** SITE 4 — `/apps/dev/[blockId]`, the JSX prop. */
  it('SITE 4 (dev tunnel render) hands its `fullBleed` prop to the host', () => {
    const declared = fullBleedOf(
      renderToStaticMarkup(
        React.createElement(DevTunnelPage as any, { ...DEV_PAGE_PROPS, fullBleed: true })
      )
    );
    expect(
      declared,
      'the dev tunnel page rendered with `fullBleed: true` still hands the host `false` — the ' +
        'author checking their own app sees the capped column the run page will not give them'
    ).toBe('true');

    const undeclared = fullBleedOf(
      renderToStaticMarkup(
        React.createElement(DevTunnelPage as any, { ...DEV_PAGE_PROPS, fullBleed: false })
      )
    );
    expect(
      undeclared,
      'the dev tunnel page rendered with `fullBleed: false` hands the host `true`'
    ).toBe('false');

    expect(
      declared === undeclared,
      'both arms handed the host the same value, so the page prop is not what moves it'
    ).toBe(false);
  });
});
