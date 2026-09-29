import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ROUTER_THREADED_SPELLINGS,
  THREADED_FROM_CLAIMS,
  blankComments,
  callSites,
  countPrivateRunThreading,
  enclosingDecl,
  topLevelPropertyText,
} from '~/test-utils/routerSourceRegions';

/**
 * THE SEAM GUARD FOR THE PRIVATE-RUN CLAIM INSIDE `blocks.router.ts`.
 *
 * ⚠️ IT WAS "THE MONEY ARMS" GUARD AND IT IS NOT ANY MORE. It gained a fourth population,
 * `recordScopeInvocation`, which moves no Buzz: that population decides whether a private
 * run is VISIBLE in the delisted app owner's analytics. The mechanism is identical (an
 * optional field silently dropped at one of N argument objects) which is why it lives here
 * rather than in a parallel file, but do not read the counts below as a money inventory.
 * The invocation population also extends BEYOND this router — four more sites live in the
 * REST middleware, the storage service and the settings service — and those are ledgered by
 * `no-unmarked-private-run-invocation.test.ts`. This file remains router-only, so its
 * totals stay checkable against one source text.
 *
 * ── THE DEFECT CLASS IT EXISTS FOR ──────────────────────────────────────────
 * 🔴 A FIELD THAT EXISTS IN A DTO IS NOT A GUARD — ONLY A BRANCH ON IT IS. Both
 * money arms are branches on `claims.privateRun`, and both live in SERVICES. The
 * claim is produced in the token signer and consumed in those services, but the
 * only thing that connects the two is ten argument objects in a ~11,000-line tRPC
 * router. Every one of those is a place where the field can be silently omitted:
 * the call type-checks (the field is optional, as it must be so existing callers
 * are unaffected), the services keep their branches, every unit test stays green —
 * and the arm is inert at that path.
 *
 * That failure is invisible to the behavioural suites next door, because each of
 * them constructs the service input directly and therefore never exercises the
 * router's wiring. It is exactly the "verified in isolation" shape: two components
 * each hermetically tested and mutation-swept, broken together, because the defect
 * lives in the seam neither of them owns.
 *
 * So this pins a RELATIONSHIP over a whole population rather than a component:
 * EVERY money call site in the router that can charge or attribute a generation
 * must be fed the private-run claim, and it must be fed from the VERIFIED CLAIM
 * rather than a literal. The asserted counts make the ledger fail when the set
 * GROWS (a new submit path added without the claim) as well as when it SHRINKS.
 *
 * ── WHY IT IS A SOURCE-TEXT GUARD ───────────────────────────────────────────
 * By necessity, and the precedent is `no-divergent-author-fee-base.test.ts` next
 * door, which ledgers the same router's `recordSpendAttribution` population the
 * same way. These handlers cannot be invoked without the whole orchestrator + auth
 * stack. That makes this check STRUCTURAL, so it type-checks past a wrong
 * argument — which is why the behavioural half is mandatory and lives in
 * `blocks/__tests__/buzz-attribution.private-run-void.test.ts` and
 * `blocks/__tests__/author-fee-private-run.test.ts`. Neither half is sufficient
 * alone: this one cannot see a wrong value, those cannot see a missing call.
 *
 * ── WHY IT LIVES HERE ───────────────────────────────────────────────────────
 * The `no-*.test.ts` convention-guard name in THIS directory is what makes it
 * visible to `no-lint-rules-script-drift` and runnable by the fast
 * `pnpm run test:lint-rules` selector. A guard of this class parked beside the
 * module it protects is invisible to that ratchet and would surface only in a full
 * unit run, minutes later, in a file nobody was looking at.
 *
 * ── RED AT BASE — AND EXACTLY WHICH PARTS ───────────────────────────────────
 * ⚠️ THE NUMBERS IN THIS PARAGRAPH WERE STALE FOR ONE PR AND ARE NOT RESTATED AGAIN.
 * It said "the four THREADING assertions (three per-population + the total)" and "the
 * three COUNT assertions … 4 / 4 / 2", and quoted a red-at-base total of 22 — all correct
 * for the PR that wrote it and all wrong the moment a fourth population landed. A count
 * written into prose is a claim that rots; the `LEDGER` array below is the authority, and
 * the matrix belongs in the commit that measures it.
 *
 * The DURABLE part is the split, which is what stops an invariant being laundered into
 * regression coverage: the per-population THREADING assertions and the total are `[REG]`
 * (the router carries no `privateRun:` argument at the ref before the money arms landed),
 * while the per-population COUNT assertions are `[INV]` — those populations predate this
 * work, so they are green at base and must never be reported as regression coverage. An
 * earlier revision claimed "every `toBe(...)` below fails with 0", which was false.
 *
 * ── WHAT THIS LEDGER DOES *NOT* CLOSE ───────────────────────────────────────
 * It closes each of the three populations against growth and shrinkage, but it does
 * NOT close the SET OF POPULATIONS. Its cited precedent
 * (`no-divergent-author-fee-base.test.ts`) derives its money population from
 * `MONEY_IDENTIFIER` and forces every match to be classified; neither
 * `recordSpendAttribution` nor `quoteBlockAuthorFee` matches that regex, so a future
 * `recordPrivateSpendEvent({ … })` that needs the claim is invisible to BOTH files
 * until someone adds it to `LEDGER` by hand. It also reads `blocks.router.ts` only.
 * Stated because the table below otherwise reads as if the population were closed.
 */

const ROUTER = path.join(process.cwd(), 'src/server/routers/blocks.router.ts');

/**
 * The exact threading expression. 🔴 PINNED AS A WHOLE STRING, NOT AS THE FIELD
 * NAME. `toContain('privateRun')` would be satisfied by `privateRun: false`,
 * `privateRun: true`, or a local variable that has drifted from the claim — three
 * spellings that each disable or wrongly enable a money arm while reading as
 * correctly wired. The claim is the ONLY legitimate source: it is the only value
 * an RS256 signature has vouched for.
 */
const THREADED = THREADED_FROM_CLAIMS;

/**
 * 🔴 THE ACCEPTED SPELLINGS ARE IMPORTED, NOT RE-DECLARED HERE — and this file takes the
 * ROUTER set, which is deliberately NARROWER than its cross-file sibling's.
 *
 * ⚠️ THE FIRST FIX HERE WAS ONE SHARED LIST, AND IT WAS WRONG IN THE OTHER DIRECTION. The
 * two files had declared different members over the same router text, so a writer using the
 * storage-only spelling passed the sibling's per-site check, went uncounted by the total
 * below, and reddened this file with "add it to LEDGER" — a failure naming the wrong fix.
 * Unifying the sets removed that, and LOOSENED this ledger, the stricter of the two, to
 * accept a provenance-free local at sites where the claims object is always in scope.
 *
 * Per-consumer sets restore the strictness and re-admit the wrong-fix message in one narrow
 * case — mitigated because the per-site check fires too and names the accepted spellings.
 * Stated rather than left implied: a permissive guard is worse than an imprecise message.
 */
// 🔴 THE *ROUTER* SET, NOT THE UNION OF BOTH LEDGERS'. Every governed site here has the
// claims object in scope, so the bare-local spelling the storage path needs is deliberately
// NOT admissible — admitting it would make this, the stricter of the two ledgers, the more
// permissive one. A round-2 audit of the de-duplication itself caught that.
const THREADED_SPELLINGS = ROUTER_THREADED_SPELLINGS;
const countThreaded = (src: string) => countPrivateRunThreading(src, THREADED_SPELLINGS);

/**
 * The money call sites this ledger governs, with why each one is in the set.
 *
 * 🔴 THE COUNTS ARE THE POINT. Each is the number of call sites on `main` at the
 * time of writing. If you are here because a count is off by one, the fix is to
 * WIRE the new call site, not to bump the number — an exemption is what the ledger
 * exists to make impossible. Bumping the number is only ever half the fix, and
 * `no-divergent-author-fee-base.test.ts` records the worked example: its count
 * went 3 → 4 when a fourth submit path landed on `main` mid-review, and the new
 * site was wired rather than exempted.
 */
const LEDGER = [
  {
    opener: 'recordSpendAttribution({',
    count: 4,
    why:
      'ARM A. Four submit paths write a spend-attribution row: txt2img, customComfy, ' +
      'the registry-step bridge and the pass-through step. A path that omits the claim ' +
      "writes `tracked` for a private run, which lands in the suspended app's " +
      'owner-visible analytics as engagement.',
    /** A field every site in this population already carries — the extractor's control. */
    control: 'workflowId',
  },
  {
    opener: 'quoteBlockAuthorFee({',
    count: 4,
    why:
      'ARM B, disclosure side. Two estimate sites and two submit sites. An omitted ' +
      'claim here does not move money by itself, but it SHOWS a moderator a fee the ' +
      'submit will refuse — re-creating the estimate/submit divergence the disclosure ' +
      'callers exist to remove.',
    control: 'baseGenerationBuzz',
  },
  {
    opener: 'chargeBlockAuthorFee({',
    count: 2,
    why:
      'ARM B, the DEBIT. The txt2img and registry-step submit paths. This is the one ' +
      'population where an omission moves real Buzz: the reviewer is debited and the ' +
      'suspended publisher is credited the same amount, because the platform takes no ' +
      'cut on this rail.',
    control: 'reservedAuthorFeeBuzz',
  },
  {
    opener: 'recordScopeInvocation({',
    count: 5,
    why:
      'THE AUDIT-VISIBILITY ARM, which is NOT a money arm and is in this ledger for the ' +
      'seam, not the spend. Five router paths write a `block_scope_invocations` row: the ' +
      'block-post writer, the txt2img submit, the registry-step submit, the custom-comfy ' +
      "submit and the pass-through submit. That row carries the app's REAL id and the " +
      "viewer's REAL user id, and `app-analytics.service.ts` aggregates it by " +
      '`appBlockId IN (ownedIds)` — so a path that omits the claim writes an UNMARKED row ' +
      "that appears in a delisted app owner's own analytics, which is exactly the signal " +
      'the private-run feature exists to withhold. The full cross-file population (nine ' +
      'sites over four files) is ledgered by ' +
      '`no-unmarked-private-run-invocation.test.ts`; this entry exists so the TOTAL below ' +
      'stays an honest count of the router.',
    control: 'statusCode',
  },
] as const;

describe('the private-run claim is threaded to every governed router call site', () => {
  // Comments blanked FIRST: this file's own docblocks name every identifier below,
  // and several router docblocks discuss these calls in prose. Without blanking,
  // a commented-out call site would count and a deleted one could be masked by
  // the paragraph describing it.
  const source = blankComments(readFileSync(ROUTER, 'utf8'));

  it('[INV] the router source loaded and is not empty (instrument control)', () => {
    // Without this, a path typo would make every assertion below vacuous over an
    // empty string rather than red.
    expect(source.length).toBeGreaterThan(100_000);
  });

  describe.each(LEDGER)('$opener', ({ opener, count, why, control }) => {
    const sites = callSites(source, opener);

    it('[INV] the extractor finds call sites at all (positive control)', () => {
      // 🔴 A REASSURING ZERO IS INDISTINGUISHABLE FROM AN EXTRACTOR WIRED TO
      // NOTHING. If `opener` were misspelled, `sites` would be `[]` and every
      // `every(...)` assertion below would pass VACUOUSLY — a fully green guard
      // covering nothing. This is the positive control that forbids it, and the
      // `control` field proves the slices are real argument objects rather than
      // stray text that happened to match.
      expect(sites.length).toBeGreaterThan(0);
      // EVERY slice, not just the first: an extractor that matched one real site plus
      // garbage would pass a `sites[0]` check while polluting the count.
      expect(
        sites.filter((s) => !s.includes(control)),
        `every ${opener} slice must look like a real argument object (containing \`${control}\`)`
      ).toEqual([]);
    });

    it(`[INV] there are exactly ${count} call sites — fails if the set GROWS or SHRINKS`, () => {
      // 🔴 [INV], NOT [REG], AND THE CORRECTION IS THE INTERESTING PART. This was
      // labelled [REG] until a test-review lane ran the guard's own extractor against
      // the base ref and got 4 / 4 / 2 — exactly these numbers. The POPULATIONS predate
      // this change; only the THREADING is new. So this assertion is green at base and
      // is a ledger invariant, not regression coverage.
      //
      // It survived a methodology that demoted three other labels by measurement
      // because the base-ref run measures whole FILES: the file was red overall (the
      // threading tests failed), so a green assertion inside it was not separately
      // visible. The reported red-at-base total DEPENDS on these three being green —
      // it is 22, and would be 25 if they were red.
      expect(sites, why).toHaveLength(count);
    });

    it('[INV] no call site is written `fn(<newline>{` — which would hide it from BOTH checks', () => {
      // 🔴 THE HOLE THAT DEFEATS EVERY OTHER ASSERTION IN THIS FILE AT ONCE. `callSites`
      // matches the literal `<fn>({`, so a site reformatted as `recordSpendAttribution(\n  {`
      // is not in `sites` at all — invisible to the COUNT (which would read one fewer
      // and could be "fixed" by lowering the number) AND to the total. An unthreaded
      // new site written that way ships green. Prettier's object-hugging is the only
      // thing preventing it today, which is a convention, not a guard.
      //
      // So compare the two spellings: every `<fn>(` in the router must be the `({`
      // form this ledger can see.
      const bare = source.split(`${opener.slice(0, -1)}`).length - 1;
      expect(
        bare,
        `${opener.slice(0, -1)} occurs ${bare} times but only ${sites.length} are written ` +
          `as \`${opener}\`. A call reformatted to put its argument object on the next ` +
          'line is invisible to every other assertion in this file.'
        // ⚠️ NARROWER THAN IT SOUNDS: both counts key on the literal function NAME, so a
        // call reached through an ALIASED import (`fn as g`) or written with an explicit
        // type argument (`fn<T>({`) is invisible to the bare count AND the site count
        // alike, and this equality still holds. No instance today; it is not a guard
        // against renaming the call, only against reformatting it.
      ).toBe(sites.length);
    });

    it('[REG] every call site threads the VERIFIED claim, not a literal', () => {
      // 🔴 CHECKED AT THE ARGUMENT OBJECT'S OWN DEPTH, NOT ANYWHERE IN THE SLICE.
      // A `callSites` slice contains the nested objects and nested calls too, so a
      // bare `slice.includes(THREADED)` is satisfied by a match at ANY depth —
      // e.g. `recordSpendAttribution({ …, opts: build({ privateRun: claims.privateRun
      // === true }), … })`, which has no top-level field at all and would have passed.
      // That is the field-exists-but-nothing-branches-on-it failure this guard
      // exists to prevent, one nesting level down. A reuse review found it.
      const unthreaded = sites
        .filter((site) => !THREADED_SPELLINGS.some((t) => topLevelPropertyText(site).includes(t)))
        .map((site) => enclosingDecl(source, source.indexOf(site)));

      expect(
        unthreaded,
        `these ${opener} call sites do not pass the verified private-run claim as a ` +
          'TOP-LEVEL property of the argument object. Accepted spellings: ' +
          // 🔴 ALL OF THEM, not just `${THREADED}`. The message used to name the `claims`
          // spelling alone, which tells a developer standing at the `opts.claims` site to
          // write an expression that would not compile there — a red test pointing at the
          // wrong fix, which is the failure mode a guard's message exists to prevent.
          THREADED_SPELLINGS.map((t) => `\`${t}\``).join(' | ') +
          '. Thread the claim rather than exempting the path: ' +
          why
      ).toEqual([]);
    });

    it('[INV] the depth filter is real — a NESTED match does not satisfy the check', () => {
      // 🔴 THE NEGATIVE CONTROL FOR THE CHECK ABOVE, because "I added a depth filter"
      // and "the depth filter works" are different claims.
      //
      // ⚠️ THE FIXTURE IS SYNTHETIC ON PURPOSE, and an earlier draft got this wrong by
      // building it from `sites[0]` — mutating a REAL site's threaded text. That made
      // the test depend on the threading already existing, so it went red at the base
      // ref for a mechanical reason (nothing to replace) and was mislabelled `[INV]`
      // while behaving like a `[REG]`. A base-ref run caught it. Built from a literal,
      // the test says what it means: given this shape, the check rejects it — a
      // property of the filter, true at any ref.
      const flat = `${opener} a: 1, ${THREADED}, z: 2 }`;
      const nested = `${opener} a: 1, opts: build({ ${THREADED} }), z: 2 }`;

      // A naive slice-wide grep is satisfied by BOTH…
      expect(flat).toContain(THREADED);
      expect(nested).toContain(THREADED);
      // …the depth check accepts only the one where the field is on the object itself.
      expect(topLevelPropertyText(flat)).toContain(THREADED);
      expect(topLevelPropertyText(nested)).not.toContain(THREADED);
    });
  });

  it('[INV] the CAP SELECTOR does not read the claim — privateRun changes no cap', () => {
    // 🔴 THE OTHER HALF OF A CLAIM THE SIGNER MAKES, AND IT WAS PINNED NOWHERE.
    // `block-token.service.ts`'s docblock asserts that `privateRun` "changes no
    // lifetime and no cap selection". The LIFETIME half is pinned twice (in the
    // signer's and the verifier's suites). The CAP half was prose — a review lane
    // pointed out that nothing checked it.
    //
    // Asserted structurally because `reserveBlockBuzzSpendForClaims` cannot be
    // invoked without Redis and the whole auth stack. The property is narrow and
    // exact: that function selects between the review-run-for-real ceiling, the dev
    // bypass and the ordinary daily + consent legs by reading `claims.reviewRunForReal`
    // and `claims.dev`. If `privateRun` ever appears inside it, the claim has started
    // selecting a cap and the signer's docblock is false — which is the dangerous
    // direction, because the `dev` branch SKIPS the per-app reservation entirely.
    const start = source.indexOf('async function reserveBlockBuzzSpendForClaims');
    expect(start, 'the cap selector must still exist under this name').toBeGreaterThan(0);
    // Bound the region at the next top-level declaration so this reads the function
    // body rather than the rest of the file.
    const after = source.slice(start);
    const end = after.indexOf('\nasync function ', 1);
    const body = end === -1 ? after : after.slice(0, end);

    // Positive control: the region really is the selector, not an empty slice.
    expect(body).toContain('claims.reviewRunForReal');
    expect(body).toContain('claims.dev');
    expect(body, 'privateRun must not select a cap — see block-token.service.ts').not.toContain(
      'privateRun'
    );
  });

  it('[REG] the router threads the claim exactly as many times as there are governed call sites', () => {
    // 🔴 THE TOTAL, ASSERTED SEPARATELY, AND IT IS NOT REDUNDANT WITH THE
    // PER-POPULATION CHECKS ABOVE. Those ask "does every site I found carry it".
    // This asks the converse: "is it carried anywhere I did NOT look". A stray
    // `privateRun: claims.privateRun === true` on some other call — a fifth money
    // helper this ledger does not know about, say — would satisfy every check
    // above and be caught only here, which is the signal to add that helper to
    // LEDGER rather than to raise this number.
    const expected = LEDGER.reduce((n, entry) => n + entry.count, 0);
    const actual = countThreaded(source);
    expect(
      actual,
      `${expected} governed call sites are ledgered above, but the router threads the ` +
        `claim ${actual} times. If a new money helper needs it, add it to LEDGER.`
    ).toBe(expected);
  });

  it('[INV] the shared spellings are pairwise non-overlapping — the total depends on it', () => {
    // 🔴 THIS FILE'S EXACT TOTAL RESTS ON IT, SO IT IS CHECKED IN THIS FILE. The full proof
    // lives in `src/test-utils/__tests__/routerSourceRegions.test.ts` — but that file is not
    // a `no-*.test.ts`, so it is NOT in the `test:lint-rules` selector, and a precondition
    // that only runs in the full suite is a precondition nobody sees until minutes later.
    // If any spelling were a substring of another, one site would score twice and the total
    // below would need a WRONG number to stay green.
    for (const a of THREADED_SPELLINGS) {
      for (const b of THREADED_SPELLINGS) {
        if (a === b) continue;
        expect(b, `\`${a}\` must not be a substring of \`${b}\``).not.toContain(a);
      }
    }
  });

  it('[INV] the pinned expression is one of the shared accepted spellings', () => {
    // 🔴 THE INSTRUMENT CONTROL FOR THE IMPORT. `THREADED` is quoted verbatim in the failure
    // messages and the negative-control fixture above, so if the shared list ever stopped
    // containing it those would describe a spelling the counter does not accept — the
    // per-site checks would keep passing off the OTHER members while the message lied.
    // The non-overlap property this file's exact total rests on is proven in
    // `src/test-utils/__tests__/routerSourceRegions.test.ts`, not restated here.
    expect(THREADED_SPELLINGS).toContain(THREADED);
  });
});
