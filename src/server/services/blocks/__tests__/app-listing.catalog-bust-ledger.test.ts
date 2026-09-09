import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';

/**
 * 🔴 `bustAppListingCatalogCache` CALL-SITE LEDGER — fails when the set GROWS or SHRINKS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The `/apps` catalog is served from a 180s `queryCache` entry (#529). That cache has
 * two halves, and only one of them had coverage:
 *
 *   · CORRECTNESS OF THE KEY — that two viewers can never share an entry. Guarded by
 *     `app-listing.catalog-cache.test.ts`.
 *   · FRESHNESS — that every mutation which changes catalog membership or a cached
 *     axis deletes the entry. Guarded by NOTHING, until this file. Measured: replacing
 *     every `await bustAppListingCatalogCache().catch(() => undefined);` in the tree
 *     with a no-op left the whole blocks tier green — 160 files, 3742 tests.
 *
 * That gap is not hypothetical, and it is not the kind a behavioural test finds either.
 * It shipped in the very change that introduced the cache: `approveExternalRequest`
 * `return`s into `applyApprovedRevision` for every approval of an edit to an
 * already-live listing, BEFORE reaching its own bust, and `applyApprovedRevision` had
 * none. The offsite branch there writes `contentRating` (the maturity gate),
 * `category` (a cached filter) and `name` (the `sort='name'` sort key) straight onto
 * the LIVE parent. A `g`→`r` re-rating sat in the cached SFW page for the full TTL.
 *
 * A per-mutation behavioural test would not have caught it: nobody writes a test for
 * the function they forgot. What catches it is an ASSERTED SET — a ledger that goes red
 * when a new listing mutation appears without a bust (GROWS), and equally red when an
 * existing bust is deleted (SHRINKS).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES AND DOES NOT CLAIM
 * ─────────────────────────────────────────────────────────────────────────────
 * It pins WHERE the buster is called, by `<file>::<enclosing top-level function>`. It
 * is STRUCTURAL, and a structural check type-checks straight past a buster that passes
 * the wrong tag — so the behavioural half lives in
 * `app-listing.catalog-cache.test.ts` ("the buster busts the CATALOG tag"), and the
 * behavioural regression test for the revision path lives in
 * `offsite-listing.onsite-revision.service.test.ts`.
 *
 * It also does NOT claim every entry is load-bearing. Several are deliberately INERT
 * (a bust on a `draft`/`pending`/`removed` row the approved-only query already
 * excludes) and are kept so the rule stays mechanical rather than a per-branch
 * judgement; each such site says so at the call site. The ledger's job is that adding
 * or removing one is a DECISION someone made on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHEN THIS GOES RED
 * ─────────────────────────────────────────────────────────────────────────────
 * · You added a listing mutation and a bust → add its `<file>::<fn>` to `LEDGER`.
 * · You added a bust you did NOT intend → that is the finding; remove it.
 * · You removed a bust → prove the mutation cannot change catalog membership or a
 *   CACHED axis (`al.status`, `al.kind`, `al.category`, `al.content_rating`,
 *   `al.revision_of_id`, `ab.current_version_deployed_at`, or the `sort_key` inputs
 *   `al.name` / `al.created_at` / the metric rollup) — remembering that every
 *   PROJECTION field on the card is hydrated live and can never be stale — then delete
 *   the row here in the same commit.
 * · You RENAMED the buster → the scan finds zero and the positive control below fires
 *   first, naming the instrument rather than the code.
 */

const ROOT = process.cwd();

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    // Dot-dirs cover `.git`, `.next`, `.turbo` in one rule.
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

/** Every repo root that could hold a caller. `src` is where they all are today. */
const ROOTS = ['src', 'apps', 'packages', 'scripts'];

const FILES = ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .map((f) => relative(ROOT, f).split(sep).join('/'))
  // Tests are excluded: a spec asserting ON the buster is not a production caller, and
  // counting one would let a deleted production bust be masked by its own test.
  .filter((f) => !/(^|\/)(__tests__|__mocks__|tests?)\/|\.(test|spec)\.tsx?$/.test(f));

/**
 * A CALL, not a mention. `stripCommentsAndStrings` removes the prose (this codebase
 * discusses the buster at length in comments), and the `\(` requires an invocation, so
 * the `import { … }` line and the `export async function` definition are both excluded.
 */
const CALL_RE = /\bbustAppListingCatalogCache\s*\(/g;

/**
 * The enclosing TOP-LEVEL declaration for a match at `index` WITHIN `haystack`.
 *
 * 🔴 Anchored at column 0 (`^` with `m`) on purpose. A first version also accepted a
 * two-space-indented `name(` so it could name a class method — and that alternative
 * matched `  if (` and `  switch (`, so four real mutations were attributed to a
 * function called `if`. There is no class-method call site left, and a ledger that
 * reports a keyword as a producer is worse than one that reports `<module scope>`.
 */
const enclosingFn = (haystack: string, index: number) => {
  const decls = [
    ...haystack
      .slice(0, index)
      .matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = /gm),
  ];
  const last = decls[decls.length - 1];
  return last ? last[1] ?? last[2] : '<module scope>';
};

const findCallSites = () => {
  const found: string[] = [];
  for (const file of FILES) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    // Cheap pre-filter: skip the ~99% of files that never mention it at all.
    if (!source.includes('bustAppListingCatalogCache')) continue;
    const code = stripCommentsAndStrings(source);
    for (const m of code.matchAll(CALL_RE)) {
      // 🔴 The buster's own DECLARATION in `app-listing.service` matches `name\s*\(` too.
      // Skipping on `enclosingFn(...) === 'bustAppListingCatalogCache'` does NOT work:
      // `enclosingFn` scans BACKWARD from the match, and at the declaration the match IS
      // the declaration, so it reports whatever precedes it — which silently listed a
      // neighbouring helper as a bust site. Test the text immediately before instead.
      if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      found.push(`${file}::${enclosingFn(code, m.index)}`);
    }
  }
  return [...new Set(found)].sort();
};

/**
 * 🔴 THE LEDGER. `<file>::<enclosing top-level function>`, sorted.
 *
 * Deduplicated on purpose: `updateListing` calls the buster from four of its status
 * branches, and a fifth branch would be a code review question, not a ledger change.
 * What the ledger pins is WHICH MUTATIONS bust, not how many `await`s each contains.
 */
const LEDGER = [
  // The ONE non-tRPC writer of `current_version_deployed_at` — the onsite deploy gate
  // in the cached statement. Without it a freshly-deployed app is simply absent.
  'src/pages/api/internal/blocks/build-callback.ts::watchApplyJobAndRecord',
  // Mints rows at `status:'approved'` — a go-live path, not a data migration.
  'src/server/services/blocks/app-listing-backfill.service.ts::backfillAppListings',
  // All three run `reDeriveContentRatingForModLiveEdit` inside their tx, which can RAISE
  // `content_rating` — the `listingMatureFilter` axis.
  'src/server/services/blocks/app-listing-assets.service.ts::addListingScreenshot',
  'src/server/services/blocks/app-listing-assets.service.ts::setListingCover',
  'src/server/services/blocks/app-listing-assets.service.ts::setListingIcon',
  // Catalog membership + the live-parent scalar writes.
  'src/server/services/blocks/offsite-listing.service.ts::applyApprovedRevision',
  'src/server/services/blocks/offsite-listing.service.ts::approveExternalRequest',
  'src/server/services/blocks/offsite-listing.service.ts::rejectExternalRequest',
  'src/server/services/blocks/offsite-listing.service.ts::submitListingRevision',
  'src/server/services/blocks/offsite-listing.service.ts::updateListing',
  // Moderator + owner state transitions — every one of these is catalog membership.
  'src/server/services/blocks/offsite-moderation.service.ts::claimListing',
  'src/server/services/blocks/offsite-moderation.service.ts::delistListing',
  'src/server/services/blocks/offsite-moderation.service.ts::purgeListing',
  'src/server/services/blocks/offsite-moderation.service.ts::relistListing',
  'src/server/services/blocks/offsite-moderation.service.ts::republishOwnListing',
  'src/server/services/blocks/offsite-moderation.service.ts::resetListingToPending',
  'src/server/services/blocks/offsite-moderation.service.ts::resetOnsiteListingToPending',
  'src/server/services/blocks/offsite-moderation.service.ts::unpublishOwnListing',
  // Onsite approve mints/flips the AppListing to `approved`.
  'src/server/services/blocks/publish-request.service.ts::approveRequest',
].sort();

describe('🔴 bustAppListingCatalogCache CALL-SITE LEDGER', () => {
  const SITES = findCallSites();

  /**
   * 🔴 INSTRUMENT FIRST. Every assertion below is a set comparison, and a scan wired to
   * nothing produces an EMPTY set — which reads as "the ledger shrank", i.e. a confident
   * finding about the code that is really a fact about the walk. Prove the walk found a
   * real population and the regex can match before reading any verdict.
   */
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/offsite-listing.service.ts');
    expect(SITES.length).toBeGreaterThan(10);
    for (const root of ROOTS) {
      expect(FILES.some((f) => f.startsWith(`${root}/`))).toBe(true);
    }
  });

  /**
   * 🔴 POSITIVE CONTROL ON THE REGEX + STRIPPER + `enclosingFn`, through the same code
   * path the file scan uses. A `.catch(...)`-suffixed call, a bare `await` call and a
   * class-method enclosure are all shapes present in the real tree; a prose mention and
   * the import line are shapes that must NOT match.
   */
  it('POSITIVE CONTROL: the matcher matches calls, and only calls, and names them right', () => {
    const sample = [
      "import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';",
      '// A comment naming bustAppListingCatalogCache() must not count.',
      // The DECLARATION must not count either — and note the helper before it, which is
      // exactly what a backward scan reports if the declaration slips through.
      'function neighbouringHelper() { return 1; }',
      'export async function bustAppListingCatalogCache(): Promise<void> {}',
      'export async function realCaller() {',
      '  if (cond) {',
      '    switch (x) {',
      '      default:',
      '        await bustAppListingCatalogCache().catch(() => undefined);',
      '    }',
      '  }',
      '}',
      'export async function secondCaller() {',
      '  await bustAppListingCatalogCache();',
      '}',
    ].join('\n');
    const code = stripCommentsAndStrings(sample);
    const hits: string[] = [];
    for (const m of code.matchAll(CALL_RE)) {
      if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
      hits.push(enclosingFn(code, m.index));
    }
    expect(
      hits,
      'the matcher missed a real call shape, counted prose/an import/the declaration, ' +
        'or attributed a call to an enclosing `if`/`switch` instead of its function.'
    ).toEqual(['realCaller', 'secondCaller']);
  });

  /**
   * 🔴 NEGATIVE CONTROL. A ledger that cannot go red is decorative. Perturb the SET the
   * way a regression would — one entry removed (a deleted bust) and one added (a new
   * mutation with a bust nobody recorded) — and confirm the comparison notices both.
   * This is the mutation the assertion below is claimed to survive; run it, don't assume
   * it.
   */
  it('NEGATIVE CONTROL: the comparison detects both a shrink and a growth', () => {
    expect(SITES.slice(1)).not.toEqual(LEDGER);
    expect([...SITES, 'src/server/services/blocks/new.service.ts::newMutation'].sort()).not.toEqual(
      LEDGER
    );
  });

  it('the set of catalog-bust call sites is EXACTLY the ledger', () => {
    const missing = LEDGER.filter((e) => !SITES.includes(e));
    const extra = SITES.filter((e) => !LEDGER.includes(e));
    expect(
      SITES,
      'the set of `bustAppListingCatalogCache()` call sites changed.\n' +
        `  REMOVED (a bust that was here and is gone): ${JSON.stringify(missing)}\n` +
        `  ADDED   (a bust nobody recorded):           ${JSON.stringify(extra)}\n` +
        'A REMOVAL means some listing mutation no longer invalidates the /apps catalog ' +
        'entry, so the store grid can serve a delisted / re-rated / re-categorised row ' +
        'for the whole CacheTTL.sm window. An ADDITION is fine — record it here in the ' +
        'same commit, with one line saying which CACHED axis it moves (or that it is a ' +
        'deliberately inert uniform-rule site). See this file`s header.'
    ).toEqual(LEDGER);
  });

  /**
   * 🔴 THE ENTRY THIS LEDGER WAS BUILT FOR, called out by name.
   *
   * `approveExternalRequest` returns into `applyApprovedRevision` before reaching its
   * own bust, for EVERY approval of an edit to an already-live listing. The set
   * assertion above covers it, but it covers it anonymously — this pins it so a future
   * "tidy the ledger" pass cannot drop the row without reading why it is there.
   */
  it('🔴 `applyApprovedRevision` is in the ledger (it is NOT covered by its caller)', () => {
    expect(
      SITES,
      '`applyApprovedRevision` does not bust. `approveExternalRequest` RETURNS into it ' +
        'for every listing with `revisionOfId != null`, i.e. every approval of an edit ' +
        'to an already-live listing, BEFORE reaching its own bust. Its offsite branch ' +
        'writes contentRating (the maturity gate), category (a cached filter) and name ' +
        '(the sort key) onto the LIVE parent.'
    ).toContain('src/server/services/blocks/offsite-listing.service.ts::applyApprovedRevision');
  });
});
