import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';
import { resolveCanonicalListingOwner } from '~/server/services/blocks/app-access.service';
import { canonicallyOwnedAppBlock } from '../publisher-ban-revocation.service';

/**
 * 🔴 SEAM GUARD: the set of blockInstanceId NAMESPACES a publisher ban must reach.
 *
 * The behavioural suite (`services/__tests__/ban-revokes-block-instances.test.ts`)
 * proves the writer marks the ids it is given. What no behavioural test can express is
 * the property that decayed here once already and shipped: that the writer's notion of
 * "every live instance" is CLOSED over the namespaces the guards actually see.
 *
 * The first version of `revokeBlockInstancesForPublisher` selected
 * `blockInstanceId: { not: null }` and covered exactly ONE of five. Its own comment
 * said a blanket subscription "has no minted token keyed to a stored one" — true, and
 * irrelevant, because the token is keyed to the SYNTHESISED id and
 * `isRevoked(claims.blockInstanceId)` compares that string verbatim. Four namespaces
 * went unrevoked while the guard comment, the service docblock and the commit message
 * all said "every live instance of every block the banned user OWNS". Nothing in the
 * compiler, and nothing in a fixture built from the same wrong assumption, could see
 * it.
 *
 * So this pins the RELATIONSHIP rather than the component: the writer's namespace set
 * against `deriveScopeFromInstanceId`, which is the canonical PARSER
 * (`~/server/schema/blocks/attribution.schema`) and the thing
 * `BlockRegistry.resolveBlockInstance` dispatches in lockstep with. It fails when the
 * parser learns a prefix the writer does not emit (GROWTH — a new surface mints tokens
 * a ban cannot reach) and when the writer emits one the parser does not know (SHRINK,
 * or a typo'd prefix — a marker under an id no token ever carries refuses nothing and
 * reads as coverage).
 */

const WRITER = 'src/server/services/blocks/publisher-ban-revocation.service.ts';

/**
 * Every prefix the writer must be able to produce, with the source that produces it.
 * `mbi_` is deliberately absent from the emitted set: it is a legacy STORED value read
 * straight off the column, not a prefix this writer ever constructs.
 */
const NAMESPACES = [
  { prefix: 'bki_', synthesised: false, source: 'BlockUserSubscription.blockInstanceId (pinned)' },
  { prefix: 'mbi_', synthesised: false, source: 'BlockUserSubscription.blockInstanceId (legacy)' },
  { prefix: 'bus_pub_', synthesised: true, source: 'blanket publisher_all_my_models subscription' },
  { prefix: 'bus_view_', synthesised: true, source: 'viewer_personal subscription' },
  { prefix: 'pdb_', synthesised: true, source: 'PlatformDefaultBlock promotion' },
  { prefix: 'page_', synthesised: true, source: 'the <slug>.civit.ai full-page surface' },
] as const;

const SOURCE = readFileSync(join(process.cwd(), WRITER), 'utf8');

/** The writer's own source with comments stripped, so a prefix NAMED in prose but never
 * constructed cannot satisfy the emission check below. That is the exact failure this
 * guard exists for — the broken version described all five namespaces accurately in a
 * comment while emitting one. */
/**
 * Comments removed. ONE definition, used by the writer-source checks below AND by the
 * mint-site ledger — a second ad-hoc copy is how the ledger came to run over raw source
 * and accept a comment as a construction.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE = stripComments(SOURCE);

describe('the ban writer is closed over every blockInstanceId namespace', () => {
  it('POSITIVE CONTROL: the comment stripper left real code behind', () => {
    // Without this, every "emits X" assertion below could pass vacuously on an empty
    // string, or fail vacuously on a stripper that ate the file.
    expect(CODE).toContain('revokeBlockInstancesForPublisher');
    expect(CODE).toContain('BlockRevocation.revokeInstanceForBan');
    // …and it really did remove the prose, so the checks below are about code.
    expect(SOURCE).toContain('THE BAN WRITER');
    expect(CODE).not.toContain('THE BAN WRITER');
  });

  it('NEGATIVE CONTROL: a prefix that exists nowhere is not claimed as emitted', () => {
    expect(CODE).not.toContain('nosuchprefix_');
    expect(deriveScopeFromInstanceId('nosuchprefix_abc')).toBeNull();
  });

  it.each(NAMESPACES.map((n) => [n.prefix, n.source] as const))(
    'the canonical parser still recognises %s (%s)',
    (prefix) => {
      expect(
        deriveScopeFromInstanceId(`${prefix}01JEXAMPLE`),
        `deriveScopeFromInstanceId no longer maps "${prefix}" to a scope — either the ` +
          `namespace was retired (drop it here) or the parser regressed`
      ).not.toBeNull();
    }
  );

  it.each(NAMESPACES.filter((n) => n.synthesised).map((n) => [n.prefix, n.source] as const))(
    'the writer CONSTRUCTS %s (%s)',
    (prefix) => {
      expect(
        CODE.includes(`\`${prefix}$`),
        `${WRITER} never builds a "${prefix}" id, so a publisher ban leaves every ` +
          `${prefix}* instance authenticating until its token expires. Emit it, or ` +
          `remove it from NAMESPACES with a stated reason.`
      ).toBe(true);
    }
  );

  it('reads the stored column for the non-synthesised namespaces', () => {
    // The two stored prefixes are never constructed — they are read off
    // `blockInstanceId`. Assert the read exists, or "we cover bki_" would rest on
    // nothing at all.
    expect(CODE).toContain('blockInstanceId: true');
    expect(CODE).toContain('row.blockInstanceId');
  });

  /**
   * 🔴 GROWTH — AND IT MUST WATCH THE *SERVER* RESOLVER, WHICH IS WHAT THE MINT USES.
   *
   * This guard originally pinned only `deriveScopeFromInstanceId`
   * (`attribution.schema.ts`), whose own docblock calls it *"the only client-side code
   * path"*. The mint and the attribution re-derivation dispatch on
   * `BlockRegistry.resolveBlockInstance` instead. Measured: adding a sixth prefix branch
   * to the RESOLVER alone left this file green 18/18 — the guard held its stated growth
   * property only for whichever of the two surfaces happened to learn second, which is
   * the surface you cannot predict.
   *
   * So both are read, and they are pinned against EACH OTHER as well as against the
   * ledger. Three-way equality is the point: a prefix added to either one, or dropped
   * from either one, fails here.
   */
  const RESOLVER_FILE = 'src/server/services/block-registry.service.ts';
  const CLIENT_PARSER_FILE = 'src/server/schema/blocks/attribution.schema.ts';

  /** Prefixes a `startsWith('…')` in the given source region dispatches on. */
  function dispatchedPrefixes(source: string, startMarker: string, endMarker?: string): string[] {
    const from = source.indexOf(startMarker);
    expect(from, `could not find "${startMarker}" — this guard is reading nothing`).toBeGreaterThan(
      -1
    );
    let body = source.slice(from);
    if (endMarker) {
      const to = body.indexOf(endMarker, startMarker.length);
      if (to > -1) body = body.slice(0, to);
    }
    return [
      ...new Set(
        [...body.matchAll(/blockInstanceId\.startsWith\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])
      ),
    ].sort();
  }

  it('POSITIVE CONTROL: both dispatch sites are found and non-empty', () => {
    // Without this, a moved function or a renamed marker would make every equality below
    // compare two empty arrays and pass while checking nothing.
    const resolver = dispatchedPrefixes(
      readFileSync(join(process.cwd(), RESOLVER_FILE), 'utf8'),
      'static async resolveBlockInstance(',
      '\n  static '
    );
    const clientParser = dispatchedPrefixes(
      readFileSync(join(process.cwd(), CLIENT_PARSER_FILE), 'utf8'),
      'export function deriveScopeFromInstanceId'
    );
    expect(resolver.length).toBeGreaterThan(3);
    expect(clientParser.length).toBeGreaterThan(3);
  });

  it('the SERVER resolver knows no prefix this ledger has not enumerated', () => {
    const found = dispatchedPrefixes(
      readFileSync(join(process.cwd(), RESOLVER_FILE), 'utf8'),
      'static async resolveBlockInstance(',
      '\n  static '
    );
    expect(
      found,
      `${RESOLVER_FILE}'s resolveBlockInstance dispatches on a prefix set this guard does ` +
        'not know. This is the surface the MINT uses, so a new shape here mints tokens ' +
        'the ban writer cannot revoke until it is added to NAMESPACES and emitted.'
    ).toEqual(NAMESPACES.map((n) => n.prefix).sort());
  });

  it('the client parser knows no prefix this ledger has not enumerated', () => {
    const found = dispatchedPrefixes(
      readFileSync(join(process.cwd(), CLIENT_PARSER_FILE), 'utf8'),
      'export function deriveScopeFromInstanceId'
    );
    expect(
      found,
      'deriveScopeFromInstanceId dispatches on a prefix set this guard does not know.'
    ).toEqual(NAMESPACES.map((n) => n.prefix).sort());
  });

  it('🔴 the two dispatch surfaces agree with EACH OTHER', () => {
    // The ledger comparisons above would both have to be edited to drift; this one fails
    // the moment the two surfaces disagree, which is the state that actually ships.
    const resolver = dispatchedPrefixes(
      readFileSync(join(process.cwd(), RESOLVER_FILE), 'utf8'),
      'static async resolveBlockInstance(',
      '\n  static '
    );
    const clientParser = dispatchedPrefixes(
      readFileSync(join(process.cwd(), CLIENT_PARSER_FILE), 'utf8'),
      'export function deriveScopeFromInstanceId'
    );
    expect(
      resolver,
      'the server resolver and the client parser dispatch on different prefix sets — one ' +
        'of them has learned an install shape the other has not, and the ban writer is ' +
        'pinned to whichever this guard happens to read'
    ).toEqual(clientParser);
  });

  /**
   * 🔴 SHRINK / TYPO. A marker written under an id no token ever carries refuses
   * nothing, and is indistinguishable from coverage in every behavioural test — the
   * fixture would simply assert the id the writer invented.
   */
  it('every prefix the writer constructs is one the parser recognises', () => {
    // 🔴 `[a-z_-]`, WITH THE HYPHEN. This was `[a-z_]+`, which cannot match
    // `page_ephemeral-` — so the one prefix whose spelling is hyphenated was absent from
    // this guard's results entirely, and a typo'd `page_ephemral-${blockId}` was invisible
    // to the very check whose sentence claims to catch exactly that.
    const emitted = [...CODE.matchAll(/`([a-z_-]+)\$\{/g)].map((m) => m[1]);
    expect(
      emitted.length,
      'the writer constructs no ids at all — this check is inert'
    ).toBeGreaterThan(0);
    for (const prefix of emitted) {
      expect(
        deriveScopeFromInstanceId(`${prefix}01JEXAMPLE`),
        `${WRITER} writes a marker under "${prefix}*", which deriveScopeFromInstanceId ` +
          `does not recognise — no token carries that id, so the marker refuses nothing`
      ).not.toBeNull();
    }
  });
});

/**
 * 🔴 THE "EXACTLY THREE PRODUCTION CALL SITES" SENTENCE, PINNED MECHANICALLY.
 *
 * That enumeration is currently restated in five files — `block-scope.middleware.ts`,
 * `block-revocation.service.ts`, `blocks/block-bridge-auth.service.ts`,
 * `blocks/scope-grant.service.ts`, `routers/apps.router.ts` — and those same comments
 * record that it has already been WRONG TWICE, in both directions: it claimed a ban writer
 * that did not exist, then denied one after it did. A sentence with that history, cited by
 * other files as authoritative and held by nothing but prose, is going to be wrong a third
 * time. This is the cheap thing that makes the third time a red test instead of a false
 * claim a reader acts on.
 */
describe('the revokeInstance call-site ledger', () => {
  /**
   * 🔴 LEDGERED PER METHOD, BECAUSE THE TWO KEYSPACES ARE THE SECURITY BOUNDARY. A single
   * combined ledger would go green if a ban site were rewritten to call the INSTALL
   * writer — which is the exact defect that shipped in this PR's first cut: the install
   * writer's unguarded SET overwrote a ban marker, and `toggleEnabled(true)` then cleared
   * it. Keeping the two sets separate makes that rewrite a red test.
   */
  const INSTALL_WRITER_LEDGER: Record<string, string> = {
    'src/server/services/block-registry.service.ts':
      'TWO sites — uninstallFromModel and toggleEnabled(false). In both the marker is a ' +
      'SIDE EFFECT of a different, user-visible operation (the install goes away or is ' +
      'switched off), and both are clearable by the install CONSUMER via clearInstance. ' +
      'Neither can address the ban keyspace.',
  };

  const BAN_WRITER_LEDGER: Record<string, string> = {
    'src/server/services/blocks/publisher-ban-revocation.service.ts':
      'ONE site — revokeBlockInstancesForPublisher, reached from toggleBan. The only ' +
      'caller whose PURPOSE is revocation, and the only one that can write the ban ' +
      'keyspace. Its mirror clearBlockInstancesForPublisher (unban) is the only clearer.',
  };

  const SCAN_ROOTS = ['src/server', 'src/pages'];

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...walk(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        out.push(full);
      }
    }
    return out;
  }

  const FILES = SCAN_ROOTS.flatMap((r) => walk(join(process.cwd(), r)));
  const callersOf = (re: RegExp) =>
    FILES.filter((f) => re.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).split(sep).join('/'))
      .sort();
  // `revokeInstance` must NOT match `revokeInstanceForBan` — hence the explicit `(`.
  const INSTALL_CALLERS = callersOf(/BlockRevocation\.revokeInstance\s*\(/);
  const BAN_CALLERS = callersOf(/BlockRevocation\.revokeInstanceForBan\s*\(/);

  it('POSITIVE CONTROL: the walk enumerates a real population and the pattern can match', () => {
    // A broken walk or a pattern that matches nothing makes the equality below vacuous.
    expect(FILES.length).toBeGreaterThan(300);
    expect(INSTALL_CALLERS.length).toBeGreaterThan(0);
    expect(BAN_CALLERS.length).toBeGreaterThan(0);
  });

  it('🔴 the two writers have DISJOINT call sites', () => {
    // A file calling both is the shape in which a ban site quietly becomes an install
    // site — the defect this PR's first cut shipped — so it gets looked at.
    expect(INSTALL_CALLERS.filter((f) => BAN_CALLERS.includes(f))).toEqual([]);
  });

  it('NEGATIVE CONTROL: a definitely-absent call does not match', () => {
    const bogus = FILES.filter((f) =>
      /BlockRevocation\.revokeNoSuchThing\s*\(/.test(readFileSync(f, 'utf8'))
    );
    expect(bogus).toEqual([]);
  });

  it('every INSTALL-writer caller is ledgered (fails on GROWTH and SHRINK)', () => {
    expect(
      INSTALL_CALLERS,
      'the set of files calling BlockRevocation.revokeInstance changed. Several files ' +
        'state this enumeration in prose and are cited as the authority on it — update ' +
        'the ledger here AND those comments in the same commit, or the next reader acts ' +
        'on a claim that is false.'
    ).toEqual(Object.keys(INSTALL_WRITER_LEDGER).sort());
  });

  it('every BAN-writer caller is ledgered (fails on GROWTH and SHRINK)', () => {
    expect(
      BAN_CALLERS,
      'the set of files calling BlockRevocation.revokeInstanceForBan changed. This is the ' +
        'keyspace an ordinary install path must never be able to write — a new caller ' +
        'here needs a deliberate decision, not a review nod.'
    ).toEqual(Object.keys(BAN_WRITER_LEDGER).sort());
  });
});

/**
 * 🔴 THE CANONICAL-OWNER PREDICATE, PINNED AGAINST THE RESOLVER IT CLAIMS TO BE.
 *
 * `canonicallyOwnedAppBlock` is a Prisma `where` — three OR branches standing in for
 * `resolveCanonicalListingOwner`. Nothing in the type system says those agree, and the
 * cost of a disagreement is asymmetric and silent: if branch 1 stopped matching, every
 * app block with no listing row — which is most of the fleet — would go unrevoked on a
 * ban, and every fixture that creates a listing would still pass.
 *
 * So this evaluates the predicate's branches AS PREDICATES over a matrix of rows and
 * compares, row by row, against the REAL resolver's answer. No database: the question is
 * whether the branch logic is the resolver's logic.
 *
 * ⚠️ WHAT IT STILL DOES NOT COVER, stated so the green is not read wider than it is:
 * whether Prisma TRANSLATES `appListing: { is: null }` into the `NOT EXISTS` branch 1
 * needs on a to-one back-relation. That needs a real database and is on this PR's
 * NOT-VERIFIED list.
 */
describe('canonicallyOwnedAppBlock is resolveCanonicalListingOwner, branch for branch', () => {
  const ME = 4242;
  const OTHER = 9999;

  type Row = {
    label: string;
    appUserId: number;
    listing: { kind: string; userId: number } | null;
  };

  const ROWS: Row[] = [
    { label: 'no listing, my app', appUserId: ME, listing: null },
    { label: 'no listing, someone else’s app', appUserId: OTHER, listing: null },
    { label: 'onsite listing, my app', appUserId: ME, listing: { kind: 'onsite', userId: ME } },
    {
      label: 'onsite listing whose stale column names someone else — the block wins',
      appUserId: ME,
      listing: { kind: 'onsite', userId: OTHER },
    },
    {
      label: 'onsite listing, someone else’s app',
      appUserId: OTHER,
      listing: { kind: 'onsite', userId: ME },
    },
    {
      label: '🔴 CLAIMED offsite: impersonator still on the app, victim on the listing',
      appUserId: OTHER,
      listing: { kind: 'offsite', userId: ME },
    },
    {
      label: '🔴 the inverse — I am the impersonator, victim owns the listing',
      appUserId: ME,
      listing: { kind: 'offsite', userId: OTHER },
    },
    {
      label: 'an unknown future kind falls to the listing column (fail-closed)',
      appUserId: ME,
      listing: { kind: 'some_future_kind', userId: OTHER },
    },
  ];

  /** Evaluate the generated Prisma `where` against a row, branch by branch. */
  function predicateSelects(where: ReturnType<typeof canonicallyOwnedAppBlock>, row: Row) {
    return (where.OR as Array<Record<string, any>>).some((branch) => {
      if (branch.app && branch.app.userId !== row.appUserId) return false;
      const listingFilter = branch.appListing?.is;
      if (listingFilter === null) return row.listing === null;
      if (listingFilter !== undefined) {
        if (!row.listing) return false;
        const kindFilter = listingFilter.kind;
        if (typeof kindFilter === 'string' && row.listing.kind !== kindFilter) return false;
        if (kindFilter && typeof kindFilter === 'object' && row.listing.kind === kindFilter.not) {
          return false;
        }
        if (listingFilter.userId !== undefined && listingFilter.userId !== row.listing.userId) {
          return false;
        }
      }
      return true;
    });
  }

  it('POSITIVE CONTROL: the matrix contains rows on BOTH sides of the answer', () => {
    // A matrix that was all-true or all-false would make the equality below vacuous.
    const owned = ROWS.filter((r) => predicateSelects(canonicallyOwnedAppBlock(ME), r));
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.length).toBeLessThan(ROWS.length);
  });

  it.each(ROWS.map((r) => [r.label, r] as const))('%s', (_label, row) => {
    const canonicalOwner = resolveCanonicalListingOwner({
      kind: row.listing?.kind ?? 'onsite',
      blockOwnerUserId: row.appUserId,
      listingUserId: row.listing?.userId ?? row.appUserId,
    });
    expect(
      predicateSelects(canonicallyOwnedAppBlock(ME), row),
      'the ban writer’s where-clause and resolveCanonicalListingOwner disagree about who ' +
        'owns this block — one of them is revoking (or sparing) the wrong account'
    ).toBe(canonicalOwner === ME);
  });
});

/**
 * 🔴 THE PREFIX LEDGERS ABOVE ARE STRUCTURALLY BLIND TO A WHOLE CLASS, AND THIS IS THE
 * GUARD FOR IT.
 *
 * Every assertion above compares PREFIX SETS. A new mint surface that reuses an existing
 * prefix therefore changes nothing they can see: `deriveScopeFromInstanceId`
 * ('page_ephemeral-foo') returns `viewer_global` through the bare `page_` branch, and
 * `resolveBlockInstance` dispatches it the same way, so both ledgers stay green while the
 * ban writer reaches none of it.
 *
 * That is not hypothetical — it is how this PR undercounted twice. `page_` was documented
 * as ONE shape, then THREE; it is FIVE, and two of the misses (`page_ephemeral-<blockId>`,
 * the mod review preview `page_<pubreq_ULID>`) add no prefix at all. Both are `dev: true`
 * 4h tokens.
 *
 * So this ledgers the MINT SITES instead of the prefixes: the files that CONSTRUCT a
 * blockInstanceId. A sixth shape has to be built somewhere, and a new file building one —
 * or an existing one losing the ability to — lands here. It cannot tell you that an
 * EXISTING file grew a new shape internally; nothing static can, short of parsing. What it
 * does is make the population of constructors an enumerated, reviewed set rather than an
 * assumption, which is the half that was missing.
 *
 * 🔴 THE RESIDUAL, STATED TRUE OF WHAT SHIPS. This ledger previously claimed its only
 * blind spot was "an EXISTING file grew a new shape internally". That was three ways too
 * narrow, and all three were demonstrated:
 *   - it walked `.ts` ONLY, while the two real constructors are `.tsx` — the ephemeral
 *     shape was minted in a file the population excluded (now `.ts` + `.tsx`);
 *   - `MINT_RE` matched `PAGE_INSTANCE_PREFIX}`, which in `block-tokens/index.ts` occurs
 *     only inside `!==` COMPARISONS, so that file was ledgered as constructing two
 *     shapes it does not construct (the pattern is construction-only now);
 *   - it ran over RAW source, so a single prepended COMMENT satisfied it while the file
 *     constructed nothing (comments are stripped now, via the same helper the first
 *     `describe` uses).
 *
 * What remains genuinely outside it: an already-ledgered file growing an additional shape
 * internally, and any construction that does not go through a `blockInstanceId:`/`=`
 * template or the SQL `AS block_instance_id` alias — e.g. a value assembled in pieces, or
 * built in a package outside `src/server`, `src/pages` and `src/components`.
 */
describe('the blockInstanceId MINT-SITE ledger', () => {
  const MINT_SITE_LEDGER: Record<string, string> = {
    'src/pages/apps/dev/[blockId].tsx':
      'CLIENT-SIDE construction of `page_<appBlockId>` for the dev harness. For an ' +
      'EPHEMERAL app `appBlockId` IS `ephemeral-<slug>`, so this is where ' +
      '`page_ephemeral-<slug>` is actually built — COVERED via ' +
      'listActiveDevTunnelBlockIds (an ephemeral app has no AppBlock row, so the tunnel ' +
      'index is the only server record of it), and the ban marker for it is ' +
      'SUBJECT-SCOPED because the slug is not unique across users.',
    'src/pages/apps/run/[slug]/[[...path]].tsx':
      'CLIENT-SIDE construction of `page_<appBlockId>` for the run surface. Same two ' +
      'shapes and the same coverage as the dev harness above.',
    'src/pages/api/v1/blocks/dev-token.ts':
      'The dev mint — and, unlike `block-tokens/index.ts`, it really does CONSTRUCT. ' +
      'Builds `page_pubreq_<pubreq_ULID>` for a caller-owned PENDING ' +
      'submission (COVERED — note the DOUBLE pubreq_, the id already carries the prefix) ' +
      'and `page_local_<slug>` for an app with NO server row of any kind (NOT COVERED and ' +
      'not coverable from here — nothing ties that slug to a user; see the writer).',
    'src/server/services/blocks/publish-request.service.ts':
      'The MOD review preview: `page_<pubreq_ULID>`, SINGLE pubreq_, so dev-token’s ' +
      'spelling never matches it. COVERED — the writer emits both spellings from the same ' +
      'pending rows.',
    'src/server/services/block-registry.service.ts':
      'The SQL synthesis in listForModel: `bus_pub_ || bus.id`, `bus_view_ || bus.id`, ' +
      '`pdb_ || pdb.app_block_id`. COVERED by the subscription and app-block legs.',
  };

  // 🔴 CONSTRUCTION ONLY. The earlier form also matched `PAGE_INSTANCE_PREFIX}`, which
  // appears in `block-tokens/index.ts` purely inside `!==` COMPARISONS — so that file was
  // ledgered as a constructor of two shapes it does not construct, and the ledger's
  // population was wrong in a way that read as coverage.
  const MINT_RE = /blockInstanceId:\s*`|blockInstanceId = `|AS block_instance_id/;

  const MINT_ROOTS = ['src/server', 'src/pages', 'src/components'];
  const mintWalk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...mintWalk(full));
      } else if (
        // 🔴 `.tsx` TOO. This read `.endsWith('.ts')`, and the two REAL constructors of
        // `page_<appBlockId>` — which for an ephemeral app IS `page_ephemeral-<slug>` —
        // are `src/pages/apps/dev/[blockId].tsx` and
        // `src/pages/apps/run/[slug]/[[...path]].tsx`. So the shape this PR went to the
        // trouble of covering was minted in a file the ledger's own population excluded:
        // a probe constructing a brand-new shape passed as a `.tsx` while the
        // byte-identical `.ts` failed, with the extension the only variable.
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.includes('.test.')
      ) {
        out.push(full);
      }
    }
    return out;
  };
  const ALL_MINT_FILES = MINT_ROOTS.flatMap((r) => mintWalk(join(process.cwd(), r)));

  // 🔴 COMMENTS STRIPPED, the same discipline the first `describe` in this file applies
  // and states. `MINT_RE` ran over RAW source, so replacing the real constructions with a
  // helper turned the ledger red and then ONE PREPENDED COMMENT LINE turned it green
  // again — with the file constructing nothing. A ledger a comment can satisfy is none.
  const MINT_SITES = ALL_MINT_FILES.filter((f) =>
    MINT_RE.test(stripComments(readFileSync(f, 'utf8')))
  )
    .map((f) => relative(process.cwd(), f).split(sep).join('/'))
    .sort();

  it('POSITIVE CONTROL: the pattern finds real constructors', () => {
    expect(ALL_MINT_FILES.length).toBeGreaterThan(300);
    expect(MINT_SITES.length).toBeGreaterThan(2);
  });

  it('NEGATIVE CONTROL: a definitely-absent construction shape matches nothing', () => {
    const bogus = ALL_MINT_FILES.filter((f) =>
      /blockInstanceIdNoSuchThing:\s*`/.test(readFileSync(f, 'utf8'))
    );
    expect(bogus).toEqual([]);
  });

  it('every file that CONSTRUCTS a blockInstanceId is ledgered, with its coverage', () => {
    expect(
      MINT_SITES,
      'a file started (or stopped) constructing blockInstanceIds. Every mint shape has to ' +
        'be reachable by revokeBlockInstancesForPublisher or explicitly recorded as ' +
        'uncovered — the prefix ledgers above CANNOT see a new shape that reuses an ' +
        'existing prefix, which is how `page_` came to be documented as one shape when it ' +
        'is five.'
    ).toEqual(Object.keys(MINT_SITE_LEDGER).sort());
  });
});
