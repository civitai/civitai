import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 THE USER-MENU `/apps` ENTRY — ONE ROW, TWO DESTINATIONS.
 *
 * WHAT CHANGED. `useGetMenuItems` used to carry TWO adjacent App-Blocks rows:
 * "Build apps" → `/apps/get-started` (gated on `appsNav.getStarted`) and "Apps" →
 * `/apps` (gated on `appsNav.marketplace`). A moderator holds both flags, so they
 * saw two near-identical rows for one product. "Build apps" moved into the shared
 * `/apps/*` sub-nav (`SUB_NAV_LINKS` in `~/components/Apps/AppsSubNav`), leaving
 * ONE dropdown row whose href is chosen from the same two booleans:
 *
 *   visible = marketplace || getStarted
 *   href    = marketplace ? '/apps' : '/apps/get-started'
 *
 * The fallback is not cosmetic. A viewer holding `appBlocksGetStarted` WITHOUT a
 * store flag cannot load `/apps` at all — its `getServerSideProps` runs
 * `resolveAppsPageAccess`, which returns `notFound`. Sending them at `/apps` would
 * be a menu entry into a 404.
 *
 * 🔴 WHY A SOURCE SCAN RATHER THAN A RENDER. `useGetMenuItems` is a heavy hook —
 * router, session, Mantine theme, tRPC — and the menu table is a 40-entry literal
 * inside it. Mounting it to observe two expressions would drag that whole graph
 * into the node `unit` project (the tier that BLOCKS) for no gain, and the browser
 * tier that could mount it is report-only. `appsStoreAccessCallSites.test.ts` names
 * this exact seam as untested: "that `useGetMenuItems` hands it the real
 * `useFeatureFlags()` object and wires `appsNav.marketplace` to the right menu
 * item". This closes the second half of it.
 *
 * 🔴 AND IT IS BEHAVIOURAL, NOT A SPELLING CHECK. The two expressions are EXTRACTED
 * from the real source and then EVALUATED against every combination of the two
 * booleans. A reworded-but-equivalent implementation passes; a wrong one fails. A
 * guard that merely grepped for the literal ternary would be satisfied by the text
 * and blind to `appsNav.getStarted ? '/apps' : …`.
 */

const HOOKS = path.resolve(__dirname, 'hooks.tsx');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent file
  // finds zero entries, which would read as "exactly one" failing for the wrong
  // reason — or, for a `length >= 0` style check, as a clean pass.
  expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

type MenuEntry = {
  /** Source text of the `href:` initializer, e.g. `"appsNav.marketplace ? '/apps' : …"`. */
  href: string;
  /** Source text of the `visible:` initializer, or `null` when the row has none. */
  visible: string | null;
  /** Source text of the `label:` initializer, quotes included. */
  label: string | null;
};

/**
 * Every object literal in `hooks.tsx` that has an `href` property, as source text.
 *
 * Uses the real TypeScript parser rather than a regex: the menu table nests object
 * literals inside array literals inside a hook body, several rows carry template
 * literals and ternaries, and a brace-counting scanner would drop rows silently —
 * the failure mode that makes a "no match" indistinguishable from a clean result.
 */
function parseMenuEntries(source: string, fileName = 'hooks.tsx'): MenuEntry[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: MenuEntry[] = [];

  const prop = (obj: ts.ObjectLiteralExpression, name: string): string | null => {
    for (const member of obj.properties) {
      if (
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === name
      ) {
        return member.initializer.getText(sf);
      }
    }
    return null;
  };

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const href = prop(node, 'href');
      if (href !== null)
        out.push({ href, visible: prop(node, 'visible'), label: prop(node, 'label') });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Rows whose href expression mentions an `/apps` route, in source order. */
function appsEntries(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter((e) => /['"`]\/apps(\/|['"`])/.test(e.href));
}

/**
 * Evaluate an extracted expression against a stub `appsNav`.
 *
 * A `ReferenceError` here means the expression grew a dependency this test does not
 * model (e.g. it started reading `features` directly instead of the pure
 * `appsNavVisibility` helper), which is itself worth failing on — so the error is
 * re-thrown with the offending source rather than swallowed.
 */
function evaluate(expr: string, appsNav: { marketplace: boolean; getStarted: boolean }): unknown {
  try {
    return new Function('appsNav', `return (${expr});`)(appsNav);
  } catch (err) {
    throw new Error(
      `could not evaluate the extracted expression against a stub \`appsNav\`:\n  ${expr}\n` +
        `If the entry now reads something other than \`appsNav\`, this test must be ` +
        `re-pointed — do not delete it.\n  cause: ${String(err)}`
    );
  }
}

const CASES = [
  { marketplace: true, getStarted: true },
  { marketplace: true, getStarted: false },
  { marketplace: false, getStarted: true },
  { marketplace: false, getStarted: false },
] as const;

describe('the extractor (validate the instrument before reading its verdict)', () => {
  it('🔴 POSITIVE CONTROL: it parses a table shaped like the real one', () => {
    const entries = parseMenuEntries(
      `
      const items = [
        { href: '/user/vault', visible: features.vault, icon: IconCloudLock, label: 'My Vault' },
        {
          // a comment mentioning href: '/apps/decoy' which must not be parsed
          href: appsNav.marketplace ? '/apps' : '/apps/get-started',
          visible: appsNav.marketplace || appsNav.getStarted,
          icon: IconPlugConnected,
          label: 'Apps',
        },
      ];
    `,
      'probe.tsx'
    );
    expect(entries).toHaveLength(2);
    expect(appsEntries(entries)).toHaveLength(1);
    expect(appsEntries(entries)[0].label).toBe(`'Apps'`);
  });

  it('🔴 NEGATIVE CONTROL: it reports TWO when the table carries two /apps rows', () => {
    // The pre-change shape. Without this, "exactly one" could be satisfied by a
    // parser that only ever finds one thing.
    const entries = appsEntries(
      parseMenuEntries(
        `
        const items = [
          { href: '/apps/get-started', visible: appsNav.getStarted, label: 'Build apps' },
          { href: '/apps', visible: appsNav.marketplace, label: 'Apps' },
        ];
      `,
        'probe.tsx'
      )
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual([`'Build apps'`, `'Apps'`]);
  });

  it('does NOT read a lookalike route as an /apps route', () => {
    // `/appsomething` and `/user/apps` are not the store. A `\/apps/`-prefix test
    // without the boundary would claim both.
    const entries = appsEntries(
      parseMenuEntries(
        `const items = [{ href: '/appsomething' }, { href: '/user/apps' }];`,
        'probe.tsx'
      )
    );
    expect(entries).toEqual([]);
  });

  it('the evaluator really evaluates (it is not returning the source text)', () => {
    expect(
      evaluate(`appsNav.marketplace ? '/apps' : '/apps/get-started'`, {
        marketplace: true,
        getStarted: false,
      })
    ).toBe('/apps');
    expect(
      evaluate(`appsNav.marketplace ? '/apps' : '/apps/get-started'`, {
        marketplace: false,
        getStarted: true,
      })
    ).toBe('/apps/get-started');
    expect(
      evaluate(`appsNav.marketplace || appsNav.getStarted`, {
        marketplace: false,
        getStarted: false,
      })
    ).toBe(false);
  });

  it('the real hooks.tsx yields a plausible number of menu rows', () => {
    // A floor well below the live count. Its job is to prove the walk reached the
    // real table, so that every count below is a fact about the code rather than
    // about a parser that returned nothing.
    expect(parseMenuEntries(read(HOOKS)).length).toBeGreaterThanOrEqual(20);
  });
});

describe('🔒 the user menu offers exactly ONE /apps entry', () => {
  const entries = appsEntries(parseMenuEntries(read(HOOKS)));

  it('🔴 exactly one — the two adjacent rows were consolidated', () => {
    expect(
      entries.map((e) => `${e.label} → ${e.href}`),
      'the user-menu dropdown must carry a single `/apps*` row. Two rows for one ' +
        'product is the duplication this change removed; adding a second one back ' +
        'needs a deliberate decision, not a merge.'
    ).toHaveLength(1);
  });

  it('is labelled "Apps"', () => {
    expect(entries[0].label).toBe(`'Apps'`);
  });

  it('🔴 href: /apps WITH store access, /apps/get-started WITHOUT', () => {
    const href = (nav: (typeof CASES)[number]) => evaluate(entries[0].href, nav);

    // Store access wins regardless of the get-started flag — the marketplace is the
    // richer landing and "Build apps" is one click away in the sub-nav.
    expect(href({ marketplace: true, getStarted: true })).toBe('/apps');
    expect(href({ marketplace: true, getStarted: false })).toBe('/apps');

    // 🔴 THE CASE THE FALLBACK EXISTS FOR. This viewer cannot load `/apps`:
    // `resolveAppsPageAccess` returns `notFound` without a store flag. A ternary
    // written the other way round, or a plain `'/apps'`, fails here.
    expect(href({ marketplace: false, getStarted: true })).toBe('/apps/get-started');
  });

  it('🔴 visible: whenever EITHER destination is reachable, and never otherwise', () => {
    const visible = entries[0].visible;
    expect(
      visible,
      'the entry must carry a `visible` predicate — an absent one is always shown'
    ).not.toBeNull();

    for (const nav of CASES) {
      expect(
        evaluate(visible as string, nav),
        `visible for marketplace=${nav.marketplace} getStarted=${nav.getStarted}`
      ).toBe(nav.marketplace || nav.getStarted);
    }
  });

  it('the href it resolves to is one the same flags actually admit', () => {
    // The relationship, not the two expressions separately: for every combination in
    // which the row is shown, the destination must be one the viewer's flags permit.
    // This is what a pair of independently-correct-looking expressions can still get
    // wrong — visible on `||`, href hardcoded to `/apps`.
    for (const nav of CASES) {
      if (!evaluate(entries[0].visible as string, nav)) continue;
      const href = evaluate(entries[0].href, nav);
      const admitted = href === '/apps' ? nav.marketplace : nav.getStarted;
      expect(admitted, `the row links to ${String(href)} for a viewer who cannot load it`).toBe(
        true
      );
    }
  });

  it('the expired `newUntil` badge from the retired "Build apps" row is gone', () => {
    // The consolidated row keeps the marketplace row's own 2026-07-01 badge; the
    // 2026-08-01 one belonged to the row that no longer exists.
    expect(read(HOOKS)).not.toContain("newUntil: new Date('2026-08-01')");
  });
});
