import { readFileSync, statSync, globSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_RUN_THREADED_SPELLINGS,
  blankComments,
  callSites,
  topLevelPropertyText,
} from '~/test-utils/routerSourceRegions';
import { OWNER_VISIBLE_INVOCATION_FILTER } from '~/server/services/blocks/scope-activity-predicate';

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
 * call sites, with per-file counts so it fails when the set GROWS (a new writer added
 * without the marker) as well as when it SHRINKS.
 *
 * 🔴 AND THE FILE SET IS DISCOVERED BY WALKING `src/`, NOT TAKEN FROM `LEDGER` — because
 * an earlier revision of this paragraph claimed the population was "derived by walking the
 * tree" while the implementation read five HARDCODED paths, and a review lane caught the
 * gap. Under the hand-listed version, a `recordScopeInvocation` call added in a NEW file —
 * the mint route, a shared-storage writer — left BOTH ledgers green and every private-run
 * call on that path wrote an unmarked row into the owner's aggregates. The instrument
 * control could not see it either: proving five listed files load says nothing about a
 * sixth. `discoverWriterFiles()` below is what makes the docblock's own sentence true, and
 * the per-file counts are then a second, narrower claim on top of it.
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
 * Two layers with DIFFERENT blind spots, which is deliberate. The discovery walk matches the
 * bare `recordScopeInvocation(`, so it sees a call however its argument object is formatted;
 * the per-site slicing matches `recordScopeInvocation({` and cannot read a call whose object
 * starts on the next line. So a reformatted call is DISCOVERED but not SLICED, and the
 * per-file bare-vs-slice equality case is what turns that disagreement into a red test
 * instead of a silent hole.
 *
 * Genuinely open, with no instance today: a call reached through an ALIASED import
 * (`recordScopeInvocation as log`) or written with an explicit type argument
 * (`recordScopeInvocation<T>({`) is invisible to both layers, because both key on the
 * literal function name.
 *
 * And it says nothing about whether the marker VALUE is right; that is the behavioural half,
 * in `blocks/__tests__/record-scope-invocation-private-run.test.ts`.
 */

const OPENER = 'recordScopeInvocation({';

/**
 * 🔴 IMPORTED, NOT RE-DECLARED. This list was declared here with three members while the
 * sibling router ledger declared two, over the same router text — so a writer using the
 * third spelling passed here, went uncounted there, and reddened that file with a message
 * naming the wrong fix. One list lives in `routerSourceRegions`, and the property both
 * ledgers' exact totals rest on (no member is a substring of another) is proven in that
 * module's own test rather than restated in each consumer.
 */
const THREADED_SPELLINGS = PRIVATE_RUN_THREADED_SPELLINGS;

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

/**
 * 🔴 THE CARRIER, AND IT CLOSES A MUTANT THAT SURVIVED THE WHOLE SUITE.
 *
 * Two of the nine writers — the storage set and delete audit rows — never see the claims
 * object, so they thread a LOCAL destructured off the resolver that verified the token. The
 * accepted-spellings list admits that local by name, which means the per-site check above
 * accepts `privateRun: privateRun === true` without tracing where `privateRun` came from —
 * precisely the "a local that has drifted from the claim" case the spellings docblock
 * disclaims.
 *
 * Measured: flipping `resolveStorageContext`'s two returns to `privateRun: false` left the
 * suite at 65/65 green, and 255/255 over a much wider set. Both REST storage audit rows then
 * land UNMARKED on every private run, so the leak survives across the entire REST storage
 * path with nothing red. A review lane found it by mutation; no assertion could have.
 *
 * So the local's PROVENANCE is ledgered here: the resolver must derive it from the verified
 * claim on every return path, and the two writers must take it from that resolver rather
 * than from anything else. Behavioural coverage of the same seam lives in
 * `apps/__tests__/app-storage.private-run-marker.test.ts`; this half is what fails when a
 * return path is added or re-pointed.
 */
const STORAGE_CARRIER = {
  file: 'src/server/services/apps/app-storage.service.ts',
  /** The resolver that performs the ONE token verification on the storage path. */
  resolver: 'async function resolveStorageContext',
  /** How many of its return statements must carry the claim — one per resolve branch. */
  returns: 2,
} as const;

/** The owner-visible reads that must carry the exclusion, and how many of them there are. */
const ANALYTICS_MODULE = 'src/server/services/blocks/app-analytics.service.ts';
const OWNER_VISIBLE_PRISMA_READS = 4;

const read = (rel: string) => blankComments(readFileSync(path.join(process.cwd(), rel), 'utf8'));

/**
 * 🔴 EVERY NON-TEST FILE UNDER `src/` THAT CALLS THE WRITER, DISCOVERED RATHER THAN LISTED.
 * This is what closes the population: `LEDGER` is then checked AGAINST this, so a writer in
 * a file nobody ledgered is red instead of invisible.
 *
 * Comments are blanked before matching, so a docblock that merely NAMES the call — there
 * are several — cannot manufacture a phantom file. Test files are excluded because they
 * legitimately call the writer to test it; a new test is not a new production writer.
 *
 * ⚠️ `globSync` here, not a `grep -r`: this repo's interactive `grep` honours `.gitignore`,
 * and a walk that silently skips a path returns a reassuring zero.
 *
 * 🔴 IT MATCHES THE BARE `recordScopeInvocation(`, NOT the `({` opener, so a call
 * reformatted onto the next line is still DISCOVERED even though `callSites` cannot slice
 * it. The two checks then disagree loudly — the file is ledgered, its per-file bare-vs-slice
 * equality case goes red — instead of the call vanishing from both.
 *
 * 🔴 AND THE DECLARATION IS SUBTRACTED, not matched. `export async function
 * recordScopeInvocation(` contains the same text, so the first version of this walk
 * "discovered" the module that DEFINES the writer and calls it nowhere. Counting total
 * occurrences minus declarations, rather than excluding that path by name, keeps the check
 * honest in the dangerous direction: if a real call is ever added inside the definer, the
 * remainder is non-zero and the file must be ledgered like any other.
 */
const CALL_TOKEN = 'recordScopeInvocation(';
const DECL_TOKEN = 'function recordScopeInvocation(';

/** How many CALLS (not declarations) of the writer a source text contains. */
function callCount(source: string): number {
  const total = source.split(CALL_TOKEN).length - 1;
  const decls = source.split(DECL_TOKEN).length - 1;
  return total - decls;
}

function discoverWriterFiles(): string[] {
  const files = globSync('src/**/*.{ts,tsx}', { cwd: process.cwd() });
  const found: string[] = [];
  for (const rel of files) {
    const file = rel.replace(/\\/g, '/');
    if (file.includes('/__tests__/') || /\.(test|spec)\.tsx?$/.test(file)) continue;
    const abs = path.join(process.cwd(), file);
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    if (callCount(blankComments(readFileSync(abs, 'utf8'))) > 0) found.push(file);
  }
  return found.sort();
}

describe('every block_scope_invocations writer carries the private-run marker', () => {
  it('[INV] every ledgered file loaded and is non-trivial (instrument control)', () => {
    // Without this, a path typo makes every assertion below vacuous over an empty string
    // rather than red. A reassuring zero is indistinguishable from a guard wired to nothing.
    for (const { file } of LEDGER) {
      expect(read(file).length, `${file} must load`).toBeGreaterThan(1_000);
    }
  });

  it('[INV] the walk finds writer files at all (positive control for the discovery)', () => {
    // 🔴 THE CONTROL THAT MUST COME BEFORE THE SET COMPARISON. If `globSync` matched nothing
    // — a wrong cwd, a wrong pattern, an `fs.globSync` that is not available — the discovered
    // set would be EMPTY, the comparison below would then be "[] vs LEDGER" and would fail
    // for the wrong reason, or worse, a future refactor comparing only one direction would
    // pass vacuously. A floor well under the real count, so ordinary growth never trips it.
    expect(discoverWriterFiles().length).toBeGreaterThanOrEqual(LEDGER.length);
  });

  it('[REG] the LEDGER names EVERY file in src/ that calls the writer — discovered, not listed', () => {
    // 🔴 THIS IS THE ASSERTION THAT CLOSES THE POPULATION, and the guard had none until a
    // review lane pointed out that the docblock claimed a tree walk while the code read five
    // hardcoded paths. Without it, a `recordScopeInvocation` call in a NEW file is invisible
    // to BOTH ledgers: `test:lint-rules` stays green and every private-run call on that path
    // writes an unmarked row into the delisted app owner's own analytics.
    //
    // It fails in BOTH directions on purpose. A file that GAINED a writer must be ledgered
    // (and therefore threaded, or explicitly exempted with a reason); a file that LOST its
    // last writer must leave, so the ledger cannot keep asserting a count over a population
    // that no longer exists and read as coverage.
    const discovered = discoverWriterFiles();
    const ledgered = LEDGER.map((e) => e.file).sort();
    expect(
      discovered.filter((f) => !ledgered.includes(f)),
      'these files call `recordScopeInvocation` and are in NEITHER ledger. Add each to ' +
        'LEDGER and thread the verified claim — or, if a file genuinely cannot carry a ' +
        'block-token claim, mark it `exempt: true` with the reason, which the exemption ' +
        'case re-derives from its source rather than trusting.'
    ).toEqual([]);
    expect(
      ledgered.filter((f) => !discovered.includes(f)),
      'these files are ledgered but no longer call `recordScopeInvocation`. Remove them, ' +
        'or the per-file count below asserts something about a population that is gone.'
    ).toEqual([]);
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
      const bare = callCount(source);
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

  it('[INV] callCount separates a CALL from the DECLARATION (discovery negative control)', () => {
    // 🔴 THE CONTROL FOR THE SUBTRACTION, because "I subtracted declarations" and "the
    // subtraction is right" are different claims — and getting it wrong in the other
    // direction would make the discovery walk find NOTHING and every set comparison above
    // pass vacuously over an empty list. Built from literals, so it is a property of the
    // function at any ref.
    expect(callCount('export async function recordScopeInvocation(opts: {')).toBe(0);
    expect(callCount('await recordScopeInvocation({ statusCode: 200 })')).toBe(1);
    // A definer that ALSO calls it is one call, not zero — the dangerous direction.
    expect(
      callCount('function recordScopeInvocation(o) {} \n await recordScopeInvocation({})')
    ).toBe(1);
    // And the reformatted `fn(<newline>{` shape is still counted as a call, which is what
    // makes it DISCOVERABLE even though `callSites` cannot slice it.
    expect(callCount('await recordScopeInvocation(\n  { statusCode: 200 }\n)')).toBe(1);
  });

  it('[INV] every accepted spelling is actually USED by production code', () => {
    // 🔴 A PRODUCT CLAIM, NOT A CLAIM ABOUT THIS FILE'S OWN VOCABULARY — which is what the
    // first version of this case was, and a meta-guard of exactly the shape PR 1 added and
    // then deleted after five review rounds. It also doubles as the instrument control the
    // import needs: a truncated shared list would make the per-site checks above fail
    // closed with "this site is not threaded", sending the reader to the wrong file.
    //
    // Each accepted spelling must appear somewhere in the ledgered production files. A
    // spelling nobody uses is dead vocabulary that only widens what the per-site check
    // accepts — and the destructured one is the loosest of the three, so it must earn its
    // place rather than sit there admitting an untraceable local.
    const all = LEDGER.map((e) => read(e.file)).join('\n');
    for (const spelling of THREADED_SPELLINGS) {
      expect(
        all.split(spelling).length - 1,
        `no production writer uses \`${spelling}\` — remove it from the shared list rather ` +
          'than leaving a spelling the per-site check accepts and nothing produces'
      ).toBeGreaterThan(0);
    }
  });
});

describe('the storage path carries the VERIFIED claim, not just a local', () => {
  const source = read(STORAGE_CARRIER.file);

  it('[REG] every return of the storage resolver derives privateRun from the verified claim', () => {
    // 🔴 THE ASSERTION THAT KILLS THE SURVIVING MUTANT. `resolveStorageContext` is the only
    // place on this path that holds the claims, so if ANY of its return branches stops
    // deriving the value from `claims.privateRun`, both downstream audit rows go unmarked
    // and every behavioural test still passes — the writers dutifully thread a local that is
    // now a constant.
    const at = source.indexOf(STORAGE_CARRIER.resolver);
    expect(at, `${STORAGE_CARRIER.resolver} must still exist under this name`).toBeGreaterThan(0);
    // Bound the region at the next top-level declaration so this reads the resolver only.
    const after = source.slice(at + STORAGE_CARRIER.resolver.length);
    const nextDecl = after.search(/\n(?:export )?(?:async )?function |\ntype |\nconst /);
    const body = nextDecl === -1 ? after : after.slice(0, nextDecl);

    // Positive control: the region really is the resolver, not an empty or wrong slice.
    expect(body, 'the resolver region must contain its own verification').toContain(
      'verifyBlockToken(blockToken)'
    );

    const derived = body.split('privateRun: claims.privateRun === true').length - 1;
    expect(
      derived,
      `${STORAGE_CARRIER.returns} resolve branches must each carry ` +
        '`privateRun: claims.privateRun === true`. A branch that returns a literal, or omits ' +
        'the field, silently unmarks BOTH storage audit rows for every private run while the ' +
        'writers below still look correctly threaded.'
    ).toBe(STORAGE_CARRIER.returns);

    // 🔴 AND NO BRANCH MAY RETURN A LITERAL. The count above would still pass if someone
    // ADDED a third branch carrying a literal, so the negative half is asserted separately.
    expect(body, 'no resolve branch may hardcode the marker').not.toContain('privateRun: false');
    expect(body, 'no resolve branch may hardcode the marker').not.toContain('privateRun: true');
  });

  it('[REG] both storage writers take the value from that resolver, not from elsewhere', () => {
    // The other end of the seam: a writer that computed `privateRun` itself — from a second
    // `verifyBlockToken`, or from a field it happened to have — would pass the spelling check
    // while bypassing the one verification this path performs.
    const destructures = source.split('} = await resolveStorageContext(').length - 1;
    expect(
      destructures,
      'both storage writers must destructure their context from `resolveStorageContext`'
    ).toBeGreaterThanOrEqual(STORAGE_CARRIER.returns);
    expect(
      source.split('verifyBlockToken(').length - 1,
      'the storage path must verify the token EXACTLY once, in the resolver — a second ' +
        'verification is a second place the claim can be read differently'
    ).toBe(1);
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

  it('[REG] the shared filter constrains ONLY `source` — nothing that could scope a read', () => {
    // 🔴 THE ASSERTION THAT MAKES THE SPREAD ORDER SAFE RATHER THAN MERELY CORRECT TODAY.
    // `appBlockId: idIn` is the only thing scoping those four reads to the caller's own
    // apps, and `satisfies Prisma.BlockScopeInvocationWhereInput` constrains the constant's
    // SHAPE, not which keys it may hold — so a future edit adding `appBlockId` or
    // `invokedAt` to the filter would compile clean and silently widen four aggregates
    // served to app developers. The reads now spread it FIRST so explicit keys win, and
    // this pins the key set so the hazard cannot reappear from the other direction either.
    // Order-independent, and loud on any widening.
    expect(Object.keys(OWNER_VISIBLE_INVOCATION_FILTER)).toEqual(['source']);
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

  it('[REG] the Prisma model documents ALL THREE source values', () => {
    // 🔴 THE `///` COMMENT ON THE COLUMN IS NOT A COMMENT — it is the single source for the
    // generated type docs in `packages/civitai-db-schema/src/kysely/types.ts`, i.e. the
    // documentation every future reader of this column is handed. It enumerated two values
    // while the column had three, which is the "a comment is a claim too" failure on the
    // one surface a maintainer is most likely to trust. Pinned so a fourth value cannot
    // land without updating it.
    const schema = readFileSync(
      path.join(process.cwd(), 'packages/civitai-db-schema/prisma/schema.full.prisma'),
      'utf8'
    );
    const at = schema.indexOf('model BlockScopeInvocation {');
    expect(at, 'the model must still exist under this name').toBeGreaterThan(0);
    const body = schema.slice(at, schema.indexOf('\n}', at));
    // Positive control: the region really is the model, not an empty slice.
    expect(body).toContain('@@map("block_scope_invocations")');
    for (const value of ["'app-block'", "'external-oauth'", "'private-run'"]) {
      expect(body, `the source column's doc comment must name ${value}`).toContain(value);
    }
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

  it('[INV] the viewer-own reads are deliberately NOT filtered — by IDENTIFIER or by LITERAL', () => {
    // 🔴 THE OVER-FILTERING HAZARD, PINNED. Three reads are keyed on `userId` — the viewer
    // looking at their OWN rows: the Activity feed, the "which apps acted on me" grouping
    // and the nav `hasActivity` probe. A moderator must keep seeing what they themselves
    // did; filtering there would delete the reviewer's own audit trail to solve an
    // owner-visibility problem. This fails if someone "completes" the filter by adding it,
    // which is the change that looks like a fix and is not.
    //
    // 🔴 A SPELLED GUARD IS WALKABLE BY RESPELLING, AND THIS ONE WAS. The first version
    // counted only the identifier `OWNER_VISIBLE_INVOCATION_FILTER`, so a mutant adding the
    // literal `source: { not: 'private-run' }` to the nav probe SURVIVED the whole suite —
    // measured by a review lane. The marker's NAME is what must be absent from these reads,
    // in any spelling, not one import of it.
    const surface = read('src/server/services/blocks/user-app-surface.service.ts');
    const router = read('src/server/routers/blocks.router.ts');
    for (const [label, src] of [
      ['user-app-surface.service.ts', surface],
      ['blocks.router.ts', router],
    ] as const) {
      expect(
        src.split('OWNER_VISIBLE_INVOCATION_FILTER').length - 1,
        `${label} serves the VIEWER their own rows and must not spread the owner filter`
      ).toBe(0);
      // The respelled forms: the marker as a literal, and the column named in a `where`.
      expect(
        src,
        `${label} must not exclude the marker by a literal either — a private run is the ` +
          "reviewer's OWN activity on these reads, and hiding it deletes their audit trail"
      ).not.toContain("'private-run'");
      expect(
        src.split('source: {').length - 1,
        `${label} must not constrain the \`source\` column at all on a self-scoped read`
      ).toBe(0);
    }
    // Positive control: these files really do read the table, so the zeros above are about
    // the filter and not about a file that stopped querying.
    expect(surface).toContain('dbRead.blockScopeInvocation.');
    expect(router).toContain('dbRead.blockScopeInvocation.');
  });
});
