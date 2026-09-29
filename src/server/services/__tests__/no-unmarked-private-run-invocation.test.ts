import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { blankComments, callSites, topLevelPropertyText } from '~/test-utils/routerSourceRegions';

/**
 * 🔴 THE CROSS-FILE LEDGER FOR THE PRIVATE-RUN AUDIT MARKER.
 *
 * ── THE PRODUCT PROPERTY IT PROTECTS ────────────────────────────────────────────
 * A private run is a moderator (or the app's owner, or an accepted listing collaborator)
 * running a DELISTED / suspended App Block's already-deployed bundle so a takedown can be
 * diagnosed or appealed. The operator decision is that such a run must be invisible to that
 * app's owner INCLUDING IN ANALYTICS — a visible review run tells a bad actor exactly when
 * review is happening.
 *
 * A `block_scope_invocations` row carries the app's REAL id and the viewer's REAL user id,
 * deliberately: a synthetic id would break per-app storage namespacing, the ban-revocation
 * instance id and every runtime metric label. So the row lands squarely inside the
 * `appBlockId IN (ownedIds)` aggregates that `app-analytics.service.ts` serves to the owner,
 * and the ONLY thing that keeps it out is the `source` marker this guard ledgers.
 *
 * ── WHY A LEDGER AND NOT A UNIT TEST ────────────────────────────────────────────
 * 🔴 A FIELD THAT EXISTS IN A DTO IS NOT A GUARD — ONLY A BRANCH ON IT IS, and the branch
 * here lives in ONE place (`recordScopeInvocation` maps the claim to the column value)
 * while the claim must arrive from NINE call sites across FOUR files. Every one of those is
 * a place the optional field can be silently omitted: the call type-checks (the field must
 * be optional so existing callers are unaffected), the writer keeps its branch, the
 * behavioural suites stay green — and the marker is simply absent on that path. That is the
 * "verified in isolation" shape: the writer and the reader are each tested, and the defect
 * lives in the seam neither owns.
 *
 * So this pins a RELATIONSHIP over a whole population: the set of `recordScopeInvocation`
 * call sites, derived by walking the tree rather than hand-listed, with per-file counts so
 * it fails when the set GROWS (a new writer added without the marker) as well as when it
 * SHRINKS.
 *
 * ── THE ONE EXEMPTION, AND WHY IT IS STRUCTURAL RATHER THAN ASSERTED ────────────
 * The external-OAuth audit writer is exempt: it records a standard OAuth ACCESS token's
 * call, which can never carry a block-token claim, and it writes no `appBlockId` at all, so
 * its row cannot appear in any owner aggregate. That justification is not taken on trust —
 * the exemption case below reads the site and requires both halves of it to still be true.
 *
 * ── RELATIONSHIP TO THE SIBLING GUARD ───────────────────────────────────────────
 * `no-unthreaded-private-run-claim.test.ts` also governs this router's five sites, because
 * its TOTAL assertion counts every threading in `blocks.router.ts` and would otherwise be
 * wrong. The overlap is deliberate and the cost is stated: adding a router writer means
 * bumping a count in two files. This file is the one that closes the population across ALL
 * four files; that one is the one that keeps the router's total honest.
 *
 * ── WHAT THIS DOES *NOT* CLOSE ──────────────────────────────────────────────────
 * It finds sites written `recordScopeInvocation({`. A site reformatted to put its argument
 * object on the next line, reached through an aliased import, or written with an explicit
 * type argument is invisible to it — the first of those is pinned below, the other two are
 * not and have no instance today. It also says nothing about whether the marker VALUE is
 * right; that is the behavioural half, in
 * `blocks/__tests__/private-run-invocation-marker.test.ts`.
 */

const OPENER = 'recordScopeInvocation({';

/**
 * The exact threading expressions. 🔴 PINNED AS WHOLE STRINGS, NOT AS THE FIELD NAME.
 * `toContain('privateRun')` would be satisfied by `privateRun: false`, `privateRun: true`,
 * or a local that has drifted from the claim — three spellings that each disable the marker
 * (or wrongly enable it, deleting an owner's real usage data) while reading as correctly
 * wired. The claim is the only value an RS256 signature has vouched for.
 *
 * Three spellings are accepted because the verified claim reaches the writers three ways:
 * as a local `claims`, on an options bag (`opts.claims`), and — on the storage path only —
 * destructured off the resolver that performed the verification, because those two writers
 * never see the claims object at all.
 */
const THREADED_SPELLINGS = [
  'privateRun: claims.privateRun === true',
  'privateRun: opts.claims.privateRun === true',
  'privateRun: privateRun === true',
] as const;

/**
 * Every file that writes a `block_scope_invocations` row, with the site count and why the
 * file is in the set.
 *
 * 🔴 THE COUNTS ARE THE POINT. If you are here because a count is off by one, the fix is to
 * MARK the new call site, not to bump the number.
 */
const LEDGER = [
  {
    file: 'src/server/middleware/block-scope.middleware.ts',
    count: 1,
    why:
      'THE BROADEST SITE. One write per scope-gated REST call, for every wrapped route. An ' +
      "omission here leaks the entire REST surface into the delisted app owner's analytics " +
      'rather than one path.',
  },
  {
    file: 'src/server/routers/blocks.router.ts',
    count: 5,
    why:
      'The tRPC bridge paths: the block-post writer plus the four workflow-submit arms ' +
      '(txt2img, registry step, custom comfy, pass-through). These do NOT pass through the ' +
      'REST middleware, so the middleware site above does not cover them.',
  },
  {
    file: 'src/server/services/apps/app-storage.service.ts',
    count: 2,
    why:
      'The storage set + delete writers. 🔴 A REST storage write produces TWO audit rows — ' +
      "this one and the middleware's access row — so marking only one still leaves an " +
      'unmarked row in the owner aggregates.',
  },
  {
    file: 'src/server/services/blocks/user-settings.service.ts',
    count: 1,
    why: 'The viewer-settings write, reachable under any private-run token.',
  },
  {
    file: 'src/server/services/oauth/oauth-scope-audit.ts',
    count: 1,
    exempt: true,
    why:
      'EXEMPT. Records an EXTERNAL OAuth access token call: it can never carry a block-token ' +
      'claim, and it writes no `appBlockId`, so the row cannot reach any owner aggregate. ' +
      'Both halves of that reasoning are re-checked below rather than trusted.',
  },
] as const;

/** Where the marker's single spelling lives, so this guard and the code cannot disagree. */
const PREDICATE_MODULE = 'src/server/services/blocks/scope-activity-predicate.ts';

/** The owner-visible reads that must carry the exclusion, and how many of them there are. */
const ANALYTICS_MODULE = 'src/server/services/blocks/app-analytics.service.ts';
const OWNER_VISIBLE_PRISMA_READS = 4;

const read = (rel: string) => blankComments(readFileSync(path.join(process.cwd(), rel), 'utf8'));

describe('every block_scope_invocations writer carries the private-run marker', () => {
  it('[INV] every ledgered file loaded and is non-trivial (instrument control)', () => {
    // Without this, a path typo makes every assertion below vacuous over an empty string
    // rather than red. A reassuring zero is indistinguishable from a guard wired to nothing.
    for (const { file } of LEDGER) {
      expect(read(file).length, `${file} must load`).toBeGreaterThan(1_000);
    }
  });

  describe.each(LEDGER)('$file', ({ file, count, why, ...rest }) => {
    const exempt = 'exempt' in rest && rest.exempt === true;
    const source = read(file);
    const sites = callSites(source, OPENER);

    it(`[INV] the extractor finds exactly ${count} call site(s) — fails if the set GROWS or SHRINKS`, () => {
      expect(sites, why).toHaveLength(count);
      // EVERY slice must look like a real argument object, not stray text that matched —
      // `statusCode` is a field every writer in the codebase already carries.
      expect(
        sites.filter((s) => !s.includes('statusCode')),
        'every slice must be a real argument object (containing `statusCode`)'
      ).toEqual([]);
    });

    it('[INV] no call site is written `fn(<newline>{` — which would hide it from every other check', () => {
      // 🔴 THE HOLE THAT DEFEATS THIS WHOLE FILE AT ONCE. `callSites` matches the literal
      // `<fn>({`, so a site reformatted as `recordScopeInvocation(\n  {` is not in `sites`
      // at all — invisible to the COUNT (which reads one fewer and could be "fixed" by
      // lowering the number) and to the threading check. Prettier's object-hugging is the
      // only thing preventing it today, which is a convention, not a guard.
      const bare = source.split('recordScopeInvocation(').length - 1;
      expect(
        bare,
        `recordScopeInvocation( occurs ${bare} times in ${file} but only ${sites.length} ` +
          'are written as `recordScopeInvocation({`.'
      ).toBe(sites.length);
    });

    if (exempt) {
      it('[INV] the exemption is still structurally justified — no appBlockId, external-oauth source', () => {
        // 🔴 AN EXEMPTION IS A CLAIM ABOUT THE CODE, SO CHECK THE CODE. Both halves must
        // hold: if this writer ever gained an `appBlockId` its rows could reach an owner
        // aggregate, and if it stopped tagging `external-oauth` the population would no
        // longer be disjoint from the block-token one. Either change must force a decision
        // here rather than silently widening the exemption.
        for (const site of sites) {
          const top = topLevelPropertyText(site);
          expect(top, 'the exempt writer must still tag external-oauth').toContain(
            "source: 'external-oauth'"
          );
          expect(top, 'the exempt writer must still write no appBlockId').not.toContain(
            'appBlockId'
          );
        }
      });
    } else {
      it('[REG] every call site threads the VERIFIED claim, not a literal', () => {
        // 🔴 CHECKED AT THE ARGUMENT OBJECT'S OWN DEPTH. A `callSites` slice contains nested
        // objects and nested calls, so a slice-wide `includes` is satisfied by a match at
        // ANY depth — e.g. inside the `detail: { … }` object — which is the
        // field-exists-but-nothing-branches-on-it failure one nesting level down.
        const unthreaded = sites.filter(
          (site) => !THREADED_SPELLINGS.some((t) => topLevelPropertyText(site).includes(t))
        );
        expect(
          unthreaded,
          `${unthreaded.length} \`${OPENER}\` call site(s) in ${file} do not pass the ` +
            'verified private-run claim as a TOP-LEVEL property. Mark the path rather than ' +
            `exempting it: ${why}`
        ).toEqual([]);
      });
    }
  });

  it('[INV] the depth filter is real — a NESTED match does not satisfy the check', () => {
    // 🔴 THE NEGATIVE CONTROL, because "I added a depth filter" and "the depth filter works"
    // are different claims. Built from a LITERAL, not from a real site: mutating a real
    // site's text would make this test depend on the threading already existing, so it
    // would go red at the base ref for a mechanical reason and be mislabelled.
    const t = THREADED_SPELLINGS[0];
    const flat = `${OPENER} statusCode: 200, ${t}, z: 2 }`;
    const nested = `${OPENER} statusCode: 200, detail: { ${t} }, z: 2 }`;
    // A naive slice-wide grep is satisfied by BOTH…
    expect(flat).toContain(t);
    expect(nested).toContain(t);
    // …the depth check accepts only the one where the field is on the object itself.
    expect(topLevelPropertyText(flat)).toContain(t);
    expect(topLevelPropertyText(nested)).not.toContain(t);
  });

  it('[INV] the accepted spellings cannot double-count one site', () => {
    // The `claims` spelling is not a substring of the `opts.claims` one, nor of the
    // destructured one. Were that false, a count over spellings would be inflated and the
    // ledger would need a wrong number to stay green.
    for (const a of THREADED_SPELLINGS) {
      for (const b of THREADED_SPELLINGS) {
        if (a === b) continue;
        expect(b, `\`${a}\` must not be a substring of \`${b}\``).not.toContain(a);
      }
    }
  });
});

describe('the marker has ONE spelling and every owner-visible read excludes it', () => {
  it('[REG] the marker value and the exclusion predicate are defined exactly once', () => {
    // 🔴 ONE RULE, ONE PLACE. A second literal `'private-run'` anywhere in the writer or the
    // readers is the drift that makes a filter and a writer disagree while both look right.
    const predicate = read(PREDICATE_MODULE);
    expect(predicate).toContain("export const PRIVATE_RUN_INVOCATION_SOURCE = 'private-run'");
    expect(predicate).toContain('export const OWNER_VISIBLE_INVOCATION_FILTER');
    // The value appears exactly once in the tree outside its own definition module and the
    // tests: as the definition. Everything else must import it.
    const writer = read('src/server/services/blocks/user-app-surface.service.ts');
    const analytics = read(ANALYTICS_MODULE);
    expect(
      writer.split("'private-run'").length - 1,
      'the writer must use PRIVATE_RUN_INVOCATION_SOURCE, never a second literal'
    ).toBe(0);
    expect(
      analytics.split("'private-run'").length - 1,
      'analytics must use the shared predicate, never a second literal'
    ).toBe(0);
  });

  it(`[REG] all ${OWNER_VISIBLE_PRISMA_READS} Prisma engagement reads spread OWNER_VISIBLE_INVOCATION_FILTER`, () => {
    // 🔴 THE SET MUST STAY COMPLETE. Five owner-visible reads aggregate this table: four
    // Prisma calls (api-call count, error count, top scopes, top endpoints) and one raw
    // `count(DISTINCT user_id)`. Miss ONE and the leak survives in whichever number it
    // feeds. Counted structurally because `getMyAppAnalytics` cannot be invoked without a
    // database.
    const analytics = read(ANALYTICS_MODULE);
    const spreads = analytics.split('...OWNER_VISIBLE_INVOCATION_FILTER').length - 1;
    const reads = analytics.split('dbRead.blockScopeInvocation.').length - 1;
    // Positive control: the reads themselves are findable, so a zero below would be a real
    // absence rather than a wrong pattern.
    expect(reads, 'the engagement reads must be findable at all').toBe(OWNER_VISIBLE_PRISMA_READS);
    expect(
      spreads,
      `${reads} Prisma engagement reads exist but only ${spreads} exclude private-run rows`
    ).toBe(OWNER_VISIBLE_PRISMA_READS);
  });

  it('[REG] the raw count(DISTINCT user_id) read excludes private-run rows too', () => {
    // The one read the spread above cannot cover: it is raw SQL, so it needs the literal
    // column predicate, parameterised from the same exported constant.
    const analytics = read(ANALYTICS_MODULE);
    const start = analytics.indexOf('count(DISTINCT "user_id")');
    expect(start, 'the distinct-user read must still exist under this shape').toBeGreaterThan(0);
    const stmt = analytics.slice(start, start + 600);
    expect(stmt, 'the distinct-user read must be over the invocations table').toContain(
      '"block_scope_invocations"'
    );
    expect(
      stmt,
      'the distinct-user read must exclude private-run rows, parameterised from the ' +
        'shared constant rather than a second literal'
    ).toContain('"source" <> ${PRIVATE_RUN_INVOCATION_SOURCE}');
  });

  it('[INV] the viewer-own reads are deliberately NOT filtered', () => {
    // 🔴 THE OVER-FILTERING HAZARD, PINNED. Three reads are keyed on `userId` — the viewer
    // looking at their OWN rows: the Activity feed, the "which apps acted on me" grouping
    // and the nav `hasActivity` probe. A moderator must keep seeing what they themselves
    // did; filtering there would delete the reviewer's own audit trail to solve an
    // owner-visibility problem. This fails if someone "completes" the filter by adding it,
    // which is the change that looks like a fix and is not.
    const surface = read('src/server/services/blocks/user-app-surface.service.ts');
    const router = read('src/server/routers/blocks.router.ts');
    expect(
      surface.split('OWNER_VISIBLE_INVOCATION_FILTER').length - 1,
      'user-app-surface.service.ts serves the VIEWER their own rows and must not filter'
    ).toBe(0);
    expect(
      router.split('OWNER_VISIBLE_INVOCATION_FILTER').length - 1,
      "blocks.router.ts's hasActivity probe is self-scoped and must not filter"
    ).toBe(0);
    // Positive control: these files really do read the table, so the zeros above are about
    // the filter and not about a file that stopped querying.
    expect(surface).toContain('dbRead.blockScopeInvocation.');
    expect(router).toContain('dbRead.blockScopeInvocation.');
  });
});
