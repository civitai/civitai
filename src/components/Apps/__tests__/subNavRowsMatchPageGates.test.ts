import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';

/**
 * 🔒 EVERY SUB-NAV ROW'S `visible` PREDICATE, EVALUATED AGAINST THE GATE ON THE PAGE IT
 * POINTS AT.
 *
 * THE DEFECT CLASS. A tab offered to a cohort whose destination answers `notFound`. It
 * has shipped here twice — #3899 ("Create" was store-gated while `/apps/submit` is
 * author-gated) and again as a deploy-blocking finding on PR #4668 — and a third instance
 * sat in the table KNOWINGLY for months: Marketplace was `visible: () => true` while
 * `/apps` gates on `resolveAppsPageAccess`, written up on three separate files as a
 * documented, deliberately-unfixed exposure. Every one of them passed the whole suite,
 * because nothing compared the two rules.
 *
 * 🔴 THIS IS THE ASSERTION WITH A MEASURED RED ON PRE-CHANGE CODE. Run verbatim against
 * `origin/main`, the Marketplace case FAILS: the extracted expression evaluates `true` for
 * a viewer `resolveAppsPageAccess` refuses. That is what makes this regression coverage
 * rather than an invariant guard — the rest of this PR's new tests cover new modules and
 * are new-feature coverage, and are labelled as such.
 *
 * 🔴 WHY A SOURCE SCAN AND AN `eval`, RATHER THAN A RENDER. `SUB_NAV_LINKS` is
 * module-private and `AppsSubNav.tsx` pulls React, Mantine and tRPC, so importing it into
 * the node `unit` project — the tier that actually blocks — is not possible. The browser
 * tier that could mount it is report-only. `appsMenuEntry.test.ts` solves the identical
 * problem the identical way, for the same reason.
 *
 * 🔴 AND IT IS BEHAVIOURAL, NOT A SPELLING CHECK. The predicate is EXTRACTED from the real
 * source and then EVALUATED across the flag space. A reworded-but-equivalent
 * implementation passes; a wrong one fails. A guard that grepped for the literal
 * `c.canSeeStore` would be satisfied by the text and blind to `c.canSeeStore || true`.
 */

const SUBNAV = path.resolve(__dirname, '../AppsSubNav.tsx');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent file finds
  // zero rows, and a loop over zero rows is a clean pass.
  expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip comments — this table's prose discusses every predicate it declares. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

type Row = { href: string; label: string; visible: string };

/**
 * The `SUB_NAV_LINKS` rows as `{href, label, visible}`, `visible` kept as SOURCE TEXT.
 *
 * Split on `href:` rather than on braces, for the reason `chromeNavAlignsWithSubNav`
 * records: the rows mix one-liners with multi-line objects carrying nested arrow
 * functions, so brace-counting needs a real parser and a wrong one drops rows silently.
 * The `visible` initializer runs to the end of its chunk's line-or-object, so it is taken
 * up to the trailing `,\n` that closes the property.
 */
function parseRows(src: string): Row[] {
  const start = src.indexOf('SUB_NAV_LINKS');
  expect(start, '`SUB_NAV_LINKS` was not found in AppsSubNav.tsx').toBeGreaterThan(-1);
  const body = src.slice(start);
  const end = body.indexOf('\n];');
  const table = end === -1 ? body : body.slice(0, end);

  return table
    .split(/\bhref:\s*/)
    .slice(1)
    .map((chunk) => {
      const href = /^'([^']+)'/.exec(chunk)?.[1];
      const label = /\blabel:\s*'([^']+)'/.exec(chunk)?.[1];
      // Everything after `visible:` up to the line's end, minus a trailing comma or `},`.
      const visible = /\bvisible:\s*([^\n]+?),?\s*$/m.exec(chunk)?.[1]?.replace(/\s*\},?$/, '');
      return href && label && visible ? { href, label, visible } : null;
    })
    .filter((r): r is Row => r !== null);
}

type Summary = Record<string, boolean>;
type Context = Record<string, boolean>;

/**
 * Evaluate an extracted `visible` expression against stub `(s, c)` objects.
 *
 * A thrown `ReferenceError` means the predicate grew a dependency this test does not
 * model, which is itself worth failing on — so it is re-thrown with the offending source
 * rather than swallowed into a falsy answer.
 */
function evaluate(expr: string, s: Summary, c: Context): boolean {
  try {
    return !!new Function('s', 'c', `return (${expr})(s, c);`)(s, c);
  } catch (err) {
    throw new Error(
      `could not evaluate a \`visible\` predicate against stub (s, c):\n  ${expr}\n` +
        `If a row now reads something beyond the summary and the context, this guard must ` +
        `be re-pointed — do not delete it.\n  cause: ${String(err)}`
    );
  }
}

/** Every summary flag false; every context capability false. */
const NO_SUMMARY: Summary = {
  hasInstalls: false,
  hasSubmissions: false,
  hasApprovedApps: false,
  isReviewer: false,
  hasEditableApps: false,
  hasPendingInvites: false,
};
const ALL_SUMMARY: Summary = Object.fromEntries(
  Object.keys(NO_SUMMARY).map((k) => [k, true])
) as Summary;

/**
 * A context carrying EVERY key any revision of `AppsNavContext` has used, so this file
 * evaluates the same way against the pre-change table (`canGetStarted`) and the current
 * one (`canBuild` / `canSeeStore`). That is what lets the red be measured by running this
 * exact text at `origin/main`.
 */
function context(opts: { store: boolean; author: boolean; getStarted: boolean }): Context {
  return {
    isAuthor: opts.author,
    canSeeStore: opts.store,
    canGetStarted: opts.getStarted,
    canBuild: opts.store && (opts.author || opts.getStarted),
  };
}

describe('the extractor (validate the instrument before reading its verdict)', () => {
  it('🔴 POSITIVE CONTROL: it parses a table shaped like the real one', () => {
    const rows = parseRows(
      code(`
      const SUB_NAV_LINKS: SubNavLink[] = [
        { href: '/apps', label: 'Marketplace', icon: IconBuildingStore, visible: () => true },
        {
          href: '/apps/review',
          label: 'Review',
          icon: IconGavel,
          visible: (s, c) => c.isAuthor && s.isReviewer,
        },
      ];
    `)
    );
    expect(rows.map((r) => r.href)).toEqual(['/apps', '/apps/review']);
    expect(
      evaluate(
        rows[0].visible,
        NO_SUMMARY,
        context({ store: false, author: false, getStarted: false })
      )
    ).toBe(true);
    expect(
      evaluate(
        rows[1].visible,
        ALL_SUMMARY,
        context({ store: true, author: true, getStarted: true })
      )
    ).toBe(true);
    expect(
      evaluate(
        rows[1].visible,
        NO_SUMMARY,
        context({ store: true, author: true, getStarted: true })
      )
    ).toBe(false);
  });

  it('🔴 NEGATIVE CONTROL: the evaluator can return FALSE for a real expression', () => {
    // Without this, every "the tab is hidden" assertion below could be satisfied by an
    // evaluator that always returns falsy — a reassuring zero.
    expect(
      evaluate(
        '(_s, c) => c.canSeeStore',
        NO_SUMMARY,
        context({ store: false, author: true, getStarted: true })
      )
    ).toBe(false);
    expect(
      evaluate(
        '(_s, c) => c.canSeeStore',
        NO_SUMMARY,
        context({ store: true, author: false, getStarted: false })
      )
    ).toBe(true);
  });

  it('the real table yields a plausible number of rows, Marketplace among them', () => {
    const rows = parseRows(code(read(SUBNAV)));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => r.href)).toContain('/apps');
  });
});

describe('🔴 no sub-nav row offers a page its own gate would refuse', () => {
  const rows = parseRows(code(read(SUBNAV)));

  /**
   * 🔴 THE MARKETPLACE ROW, WHICH IS THE ONE WITH A MEASURED RED AT `origin/main`.
   *
   * `/apps` gates on `resolveAppsPageAccess` → `hasAppsStoreAccess`. The row must
   * therefore be hidden for a viewer with none of the three store flags. On `origin/main`
   * that row reads `visible: () => true` and this fails; on this branch it reads
   * `visible: (_s, c) => c.canSeeStore` and passes.
   *
   * Asserted across the WHOLE (store × author × getStarted) space, both summaries, so a
   * predicate that merely happened to be false for the one cohort someone hand-picked
   * would not survive it.
   */
  it('Marketplace is visible exactly when /apps admits the viewer', () => {
    const row = rows.find((r) => r.href === '/apps');
    expect(row, 'the Marketplace row is missing from SUB_NAV_LINKS').toBeDefined();

    for (const summary of [NO_SUMMARY, ALL_SUMMARY])
      for (const store of [false, true])
        for (const author of [false, true])
          for (const getStarted of [false, true]) {
            const tabVisible = evaluate(
              row!.visible,
              summary,
              context({ store, author, getStarted })
            );
            // The page's real gate, with a flag object that produces this store term.
            const pageAdmits =
              'props' in resolveAppsPageAccess({ features: { appListings: store } });
            expect(
              pageAdmits,
              `store=${store} author=${author} getStarted=${getStarted}: the Marketplace TAB ` +
                `is ${tabVisible ? 'VISIBLE' : 'hidden'} while \`/apps\` ` +
                `${pageAdmits ? 'admits' : 'answers notFound for'} this viewer. A tab into a ` +
                `404 is the #3899 / #4668 defect class; an unreachable page with no tab is ` +
                `its mirror.`
            ).toBe(tabVisible);
          }
  });

  it('positive control: the store gate really does refuse someone', () => {
    // Guards the loop above against BOTH sides having become constant.
    expect(hasAppsStoreAccess({ appListings: false })).toBe(false);
    expect(hasAppsStoreAccess({ appListings: true })).toBe(true);
  });

  /**
   * 🔴 THE STRUCTURAL HALF: no row may be UNCONDITIONAL. Marketplace was the only
   * `() => true` in the table and it was exactly the row that was wrong. A predicate that
   * ignores both arguments cannot be tracking any page's gate, so it is a defect
   * regardless of which page it points at — pinned as a property of the TABLE rather than
   * as a fact about one row, so a future unconditional row fails here too.
   */
  it('🔴 no row is unconditionally visible', () => {
    const unconditional = rows
      .filter(
        (r) =>
          evaluate(
            r.visible,
            NO_SUMMARY,
            context({ store: false, author: false, getStarted: false })
          ) &&
          evaluate(r.visible, ALL_SUMMARY, context({ store: true, author: true, getStarted: true }))
      )
      .map((r) => `${r.label} → ${r.href} (visible: ${r.visible})`);
    expect(
      unconditional,
      'a sub-nav row is visible to EVERY viewer. Every `/apps/*` page has a gate, so an ' +
        'unconditional row is offering at least one cohort a page that answers notFound. ' +
        'Give the row the predicate its page enforces — see `canAccessAppsBuild` for the ' +
        'shared-predicate pattern.'
    ).toEqual([]);
  });
});
