import { describe, expect, it } from 'vitest';
import { scanSource } from '../../../../../test/source-scan';

/**
 * THE SSR⇄MINT SEAM, LEDGERED — and it is the guard this whole feature is shaped
 * around.
 *
 * ── THE DEFECT CLASS, WHICH HAS ALREADY HAPPENED ON THIS EXACT SURFACE ──────────
 * 🔴 THE PRIVATE-RUN BUG TO PREVENT IS AN SSR↔MINT ASYMMETRY. The dev-tunnel SSR route
 * mounts an owned app at ANY status while the page mint required `status: 'approved'`,
 * so the page rendered and then could not authenticate —
 * `tryDevTunnelOwnedNonApprovedMint` exists only to close that gap after the fact. Two
 * surfaces with two independently-written gates regrow it. So this file pins a
 * RELATIONSHIP over a population rather than any one component:
 *
 *   1. the complete set of `resolvePrivateRunAccess` call sites is EXACTLY the three
 *      ledgered below — the two SERVING surfaces (SSR + mint) plus the analytics
 *      impression gate, which decides nothing and only has to AGREE with them;
 *   2. the complete set of `resolvePageBlockBySlug` call sites and of `resolvePageBlock`
 *      call sites are each EXACTLY one, and both of those resolvers stay
 *      `approved`-only — so a future path cannot quietly adopt an approved-only
 *      resolver for a non-approved surface, nor add a third caller to either;
 *   3. `resolvePrivateRunPageBlock` — the non-approved resolver — is reachable from the
 *      predicate and from NOWHERE else, so no route can take the status bypass without
 *      the role check.
 *
 * ── WHY IT IS A SOURCE-TEXT GUARD, AND WHY THAT IS NOT SUFFICIENT ALONE ─────────
 * These handlers cannot be invoked without the whole auth stack, so the ledger is
 * STRUCTURAL — and a structural check TYPE-CHECKS PAST A WRONG ARGUMENT. It cannot see
 * a call site that passes the wrong slug, the wrong pool, or a hardcoded `true` for the
 * flag. That is why the behavioural half — `private-run-seam-agreement.test.ts` — is
 * mandatory, not decorative: it drives ONE fixture through both consumers' argument
 * shapes and asserts they AGREE. Neither half is sufficient: this one cannot see a
 * wrong value, that one cannot see a missing call.
 *
 * ⚠️ `stripCommentsAndStrings` REMOVES STRING LITERALS AS WELL AS COMMENTS, which is
 * what makes the call-site scan immune to a name written in prose — and which means a
 * literal like a status value CANNOT be asserted against `CODE`. Those assertions read
 * `raw()` instead. Getting this wrong is silent in the safe direction here (the
 * assertion fails), but the asymmetry is worth naming.
 */

const ROOT = process.cwd();

/**
 * Where each scanned symbol is DEFINED, excluded from its own caller set.
 *
 * 🔴 A HAND-WRITTEN MAP, NOT A REGEX, AND THE REASON IS A BUG THIS FILE ALREADY HAD. The
 * first draft derived it with `/function <name>/`, which cannot see a `static async`
 * CLASS METHOD — and three of the four symbols here are exactly that (`BlockRegistry` is
 * a class of statics). So `block-registry.service.ts` was silently counted as a CALLER
 * of its own methods, and the resolver ledger would have demanded an entry for the file
 * that defines it. An explicit map is also the honest shape: "where is this defined" is
 * a fact about the repo, not something to infer with a pattern that can be wrong.
 */
const DEFINED_IN: Record<string, string> = {
  resolvePrivateRunAccess: 'src/server/services/blocks/private-run-access.service.ts',
  resolvePrivateRunPageBlock: 'src/server/services/block-registry.service.ts',
  resolvePageBlockBySlug: 'src/server/services/block-registry.service.ts',
  resolvePageBlock: 'src/server/services/block-registry.service.ts',
};

const { files: FILES, code: CODE, raw, callersOf } = scanSource(ROOT, DEFINED_IN);

describe('the private-run seam — instrument validation', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk or a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/private-run-access.service.ts');
    expect(FILES).toContain('src/pages/api/v1/block-tokens/index.ts');
    expect(FILES).toContain('src/pages/apps/run/[slug]/[[...path]].tsx');
  });

  it('NEGATIVE CONTROL: a definitely-absent predicate matches nothing', () => {
    expect(callersOf('resolvePrivateRunAccessNoSuchFunction')).toEqual([]);
  });

  it('🔴 CONTROL: the scan reads CODE, so a mention in a COMMENT is not a call site', () => {
    // The failure this prevents is specific and has bitten a sibling ledger: a regex
    // over RAW source turns green the moment somebody writes the predicate's name in a
    // doc comment, with the file calling nothing. Several files legitimately NAME
    // `resolvePrivateRunAccess` in prose — the registry resolver's docblock and the
    // middleware's claim docblock among them — and none of them may count.
    const mentionsInProse = FILES.filter((f) => {
      const text = raw(f);
      return (
        text.includes('resolvePrivateRunAccess') &&
        !CODE.get(f)!.includes('resolvePrivateRunAccess')
      );
    });
    // At least one such file must exist, or this control is proving nothing.
    expect(mentionsInProse.length).toBeGreaterThan(0);
    for (const f of mentionsInProse) {
      expect(callersOf('resolvePrivateRunAccess')).not.toContain(f);
    }
  });
});

describe('the private-run seam — the call-site ledger [INV]', () => {
  /**
   * 🔴 ENUMERATED EQUALITY, NEVER CONTAINMENT. A third consumer fails here, and so does
   * deleting one. If you are here because a count is off, the fix is to decide whether
   * the new surface should share this predicate — not to bump the list.
   */
  const PREDICATE_CALLERS = [
    'src/pages/api/v1/block-tokens/index.ts',
    // The SSR run route. 🔴 THIS IS THE **PUBLIC** RUN ROUTE, and that is not a widening:
    // the private run is a FALLBACK behind `resolvePageBlockBySlug` returning null, so the
    // approved-only resolver still gates every public request. The dedicated
    // `/apps/private-run/<slug>` route this entry used to name was removed. The ordering
    // that makes the shared route safe is asserted below, not assumed here.
    'src/pages/apps/run/[slug]/[[...path]].tsx',
    // The analytics-impression gate. It takes no access decision and grants nothing — it
    // reads `allowed` and drops a telemetry row — so it cannot reproduce the SSR↔MINT
    // asymmetry this ledger exists to prevent, and sharing the predicate is what keeps it
    // from having to guess.
    'src/server/services/blocks/private-run-impression.service.ts',
  ];

  it('resolvePrivateRunAccess has EXACTLY the three ledgered callers (SSR + mint + impression gate)', () => {
    expect(callersOf('resolvePrivateRunAccess')).toEqual(PREDICATE_CALLERS.sort());
  });

  it('🔴 resolvePrivateRunPageBlock is reachable ONLY from the predicate', () => {
    // The non-approved resolver takes NO access decision. A route calling it directly
    // would be a status bypass with no role check — the exact shape the shared predicate
    // exists to make impossible. Its only legitimate caller is the predicate.
    expect(callersOf('resolvePrivateRunPageBlock')).toEqual([
      'src/server/services/blocks/private-run-access.service.ts',
    ]);
  });

  it('the approved-only resolvers keep EXACTLY one caller each, and stay approved-only', () => {
    // Non-goal #1 and #2 of the design, as a test. If a new surface adopts one of these
    // resolvers, or if one of them loses its status filter, the private path has started
    // shadowing the public one.
    expect(callersOf('resolvePageBlockBySlug')).toEqual([
      'src/pages/apps/run/[slug]/[[...path]].tsx',
    ]);
    expect(callersOf('resolvePageBlock')).toEqual(['src/pages/api/v1/block-tokens/index.ts']);

    // Both resolvers must still pin the approved status. Asserted as the literal query
    // fragments, because that is what a mutation would have to remove — and read from
    // RAW source, because `CODE` has had its string literals stripped.
    const registry = raw('src/server/services/block-registry.service.ts');
    expect(registry).toContain("status: 'approved'");
    expect(registry).toContain("ab.status !== 'approved'");
    // And the PRIVATE resolver must carry the mirror-image branch: an approved app is
    // refused there, so the two surfaces partition the status space rather than overlap.
    expect(registry).toContain(
      "if (ab.status === 'approved') return { ok: false, reason: 'approved' }"
    );
  });

  it('🔴 the run route reaches the private predicate ONLY AFTER the approved-only resolver', () => {
    // ── WHAT REPLACED WHAT, AND WHY THE NEW FORM IS NOT WEAKER ──────────────────────
    // This used to assert that a SEPARATE private route imported neither approved-only
    // resolver — "the private surface cannot reach the public resolvers at all". That
    // sentence is unavailable now that one file serves both paths, and deleting it
    // without replacement would drop the safety property entirely.
    //
    // The property that actually matters was never "different files". It is that a
    // PUBLIC request cannot reach a non-approved block — which holds because the private
    // predicate is a FALLBACK BEHIND `resolvePageBlockBySlug` RETURNING NULL, never a
    // branch that can run in its place. So that ORDER is what gets pinned, by source
    // position: the approved-only resolve must appear before the private predicate.
    //
    // ⚠️ AN ORDERING ASSERTION ON SOURCE POSITION IS A PROXY, and it is named as one.
    // It cannot see a refactor that keeps the order but changes the control flow (an
    // early `return` hoisted above it, say). It is the cheap structural half; the
    // BEHAVIOURAL half — drive a public request and prove it 404s on a suspended block —
    // lives in `src/tests/pages/apps/run/run-page-private-run.test.ts` and is the one
    // that would actually catch that. Neither is sufficient alone.
    // 🔴 COMPARE CALL SITES, NOT BARE IDENTIFIERS. The first draft of this row used
    // `indexOf('resolvePrivateRunAccess')`, which finds the IMPORT at the top of the file
    // — so it measured import order and failed (1963 vs 700) against a resolver whose
    // call order was correct all along. A bare-name search on a module that imports both
    // names can only ever compare import statements. Anchor on the call shape instead.
    const route = CODE.get('src/pages/apps/run/[slug]/[[...path]].tsx')!;
    const publicResolveAt = route.indexOf('BlockRegistry.resolvePageBlockBySlug(');
    const privateResolveAt = route.indexOf('await resolvePrivateRunAccess(');
    // Both anchors must MATCH before their order means anything — an anchor that silently
    // stopped matching would make the comparison `-1 < -1`, i.e. a green row measuring
    // nothing. This is the positive control for the instrument itself.
    expect(publicResolveAt).toBeGreaterThan(-1);
    expect(privateResolveAt).toBeGreaterThan(-1);
    expect(publicResolveAt).toBeLessThan(privateResolveAt);
  });

  it('the run route still records a play, and the private branch is gated behind an audience', () => {
    // The public path must still record the play — if it stopped, the private branch's
    // omission would cease to be a distinction and the analytics reasoning behind the
    // whole feature would be void.
    const pub = CODE.get('src/pages/apps/run/[slug]/[[...path]].tsx')!;
    expect(pub).toContain('recordAppListingOpen');
    expect(pub).toContain('resolvePageBlockBySlug');
    expect(pub).toContain('resolvePrivateRunAccess');

    // 🔴 THE "DOES NOT RECORD A PLAY" GUARD IS NOW BEHAVIOURAL, NOT TEXTUAL, AND THAT IS
    // A STRENGTHENING RATHER THAN A LOSS. While the private run had its own file, the
    // guard could be `expect(priv).not.toContain('recordAppListingOpen')` — a claim about
    // a STRING. One shared file cannot express it that way: the identifier is legitimately
    // present for the public path. A textual guard here would be unwritable, and a
    // file-scoped one would now be plain wrong.
    //
    // So the property — a private run records NO play and NO recents entry — is asserted
    // where it can actually be observed: by driving the resolver down the private branch
    // with the recorder mocked and asserting zero calls, in
    // `src/tests/pages/apps/run/run-page-private-run.test.ts`. That test also holds the
    // paired POSITIVE control (the public branch records exactly one), without which a
    // zero is indistinguishable from a harness wired to nothing.
    //
    // What IS still checkable here is that the discriminator exists and is the audience
    // the predicate returned — not a re-derived guess.
    expect(pub).toContain('audience');
  });

  it('🔴 the run route CALLS the two audience-keyed decisions rather than re-deriving them', () => {
    // ── WHY A STRUCTURAL CHECK HERE AND BEHAVIOURAL TESTS ELSEWHERE ─────────────────
    // `hostSurfaceFor` and `shouldRecordRecents` live inside `AppPage`'s render, which the
    // page suite cannot reach — it drives the SSR resolver only, with no renderer. That
    // gap is what made both decisions untestable as inline ternaries: an audit proved the
    // recents guard could be DELETED with the suite green, and the `surface` prop had no
    // assertion anywhere in the repo at all.
    //
    // Extracting them made the DECISION testable (see the behavioural rows in
    // `run-page-private-run.test.ts`). This row closes the half that extraction opens: a
    // pure function nothing calls is exactly how this goes quiet again, and no behavioural
    // test of the function can see it. Both checks are necessary; neither is sufficient.
    const pub = CODE.get('src/pages/apps/run/[slug]/[[...path]].tsx')!;
    expect(pub).toContain('hostSurfaceFor(audience)');
    // 🔴 THE ARGUMENT, NOT JUST THE CALL. This read `toContain('recentsEntryFor(')` for one
    // round and that was a REGRESSION against the row it replaced: the base pinned
    // `shouldRecordRecents(audience)`, so hardcoding the audience at the call site was RED
    // there and went GREEN here (32/32, and typecheck clean — the type guard cannot see a
    // wrong VALUE, only a null one). A call site reading `recentsEntryFor({ audience: null,
    // … })` would make every private run write a recents entry whose link 404s once the
    // flag narrows — the exact defect this extraction exists to prevent.
    // The call text carries no comment or string literal, so it survives
    // `stripCommentsAndStrings` intact and CAN be asserted against `CODE`.
    expect(pub).toContain('recentsEntryFor({ audience,');
    // ⚠️ AN ANTI-RE-INLINE ASSERTION STOOD HERE AND WAS DELETED, NOT REPAIRED. It read
    // `expect(pub).not.toContain("? 'private-run' : 'page-run'")` and was VACUOUS TWICE
    // OVER — a guard that could never fail, reading as the thing that stops a regression:
    //
    //   1. `CODE` comes from `stripCommentsAndStrings`, which removes string LITERALS as
    //      well as comments — this file's own header says so, and says a literal "CANNOT
    //      be asserted against `CODE`". The needle is two string literals. It never matched.
    //   2. Switching it to `raw()` — the obvious repair — makes it RED against the
    //      CORRECT implementation, because that exact ternary is the body of
    //      `hostSurfaceFor` itself. The forbidden pattern IS the implementation.
    //
    // Its stated reason was wrong in the other direction too: a plain re-inline that drops
    // the call is already caught by the two `toContain` rows above.
    //
    // ⚠️ AND THE ABSOLUTE THIS CARRIED — "There is no form of this assertion that both
    // works and means anything" — IS WITHDRAWN, because it is false. A COUNT over raw
    // source works: `expect(raw(pub).match(/\? 'private-run' : 'page-run'/g)).toHaveLength(1)`
    // passes today (that ternary occurs exactly once, as `hostSurfaceFor`'s body) and would
    // catch a re-inline that leaves the extracted function in place — which the `toContain`
    // rows do not. It is not added here because the argument pins above cover the mutations
    // that matter and a second spelling of the same idea is what this block is about; but
    // "no form works" was an overstatement written to justify a deletion, which is the
    // habit this file keeps catching.
  });

  it('EVERY consumer evaluates the flag for the caller and passes it in', () => {
    // The structural half of "fail-closed on both surfaces". The behavioural half is
    // below. Neither consumer may call the predicate without a `privateRunEnabled`
    // argument — the parameter is required, so this is really a check that neither one
    // hardcodes `true`.
    for (const f of PREDICATE_CALLERS) {
      const code = CODE.get(f)!;
      // 🔴 THE CALL SHAPE, NOT THE BARE NAME. `toContain('isAppBlocksPrivateRunEnabled')`
      // was satisfied by the SSR route's static `import { isAppBlocksPrivateRunEnabled }`
      // on its own — `stripCommentsAndStrings` removes comments and string literals but
      // not imports. So replacing the evaluation with `const privateRunEnabled = true;`
      // and leaving the import passed, and the `not.toContain` below does not match that
      // spelling either. Requiring `…Enabled(` means an import cannot satisfy it.
      expect(code, `${f} must CALL the flag accessor, not merely import it`).toContain(
        'isAppBlocksPrivateRunEnabled('
      );
      // And it must reach the predicate as a value DERIVED from that call, not a literal.
      //
      // ⚠️ THE FORBIDDEN SPELLINGS ARE THE ASSIGNMENT FORMS, AND THAT CORRECTION IS THE
      // POINT. This used to forbid `privateRunEnabled: true` / `false` — a spelling
      // NEITHER call site uses, since both pass the value by shorthand
      // (`privateRunEnabled,`). So that half could never fire. The realistic mutation is
      // `const privateRunEnabled = true;`, which contains neither forbidden string; it is
      // caught today only because it also orphans the call, so keeping the call for
      // logging would have walked the guard.
      for (const bad of [
        'privateRunEnabled = true',
        'privateRunEnabled = false',
        'privateRunEnabled: true',
        'privateRunEnabled: false',
      ]) {
        expect(code, `${f} must not hardcode the flag (${bad})`).not.toContain(bad);
      }
    }
  });
});

/**
 * 🔴 THE BEHAVIOURAL HALF OF THIS SEAM LIVES IN
 * `private-run-seam-agreement.test.ts`, NOT HERE, and the split is mechanical rather
 * than stylistic: that half needs a mocked database client, and a module mock is hoisted
 * file-wide — it would replace part of the very module graph this ledger walks. Keeping
 * the structural scan in a file with NO module mocks is what lets it read the real
 * repository.
 *
 * ⚠️ AND THAT PARAGRAPH USED TO NAME THE MOCKED SPECIFIER LITERALLY, WHICH TRIPPED
 * `no-direct-shared-module-mock` — that guard scans RAW source, so prose describing a
 * mock is indistinguishable to it from the mock itself. Reworded rather than
 * allowlisted: an allowlist entry here would have been a permanent exemption bought to
 * accommodate a sentence.
 *
 * DO NOT treat this file as the whole guard. It counts call sites; it cannot see a call
 * site that passes the wrong slug, the wrong pool, or a hardcoded flag. The agreement
 * test is what covers that, and the two are a pair.
 */
