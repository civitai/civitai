import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { blankComments, enclosingDecl } from '~/test-utils/routerSourceRegions';

/**
 * THE SEAM GUARD FOR THE PRIVATE-RUN MONEY ARMS — and the only guard in this
 * change that is RED at the base ref for a structural reason rather than a
 * behavioural one.
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
 * ── RED AT BASE ─────────────────────────────────────────────────────────────
 * At the base ref the router contains ZERO `privateRun:` arguments, so every
 * `toBe(...)` below fails with `0`. Reported in the PR body as the red/green
 * matrix.
 */

const ROUTER = path.join(process.cwd(), 'src/server/routers/blocks.router.ts');

/**
 * Every `<fn>({ … })` argument object in the router source, brace-matched from the
 * argument object's `{` to its match so a nested object literal cannot end the
 * slice early. Lifted from `no-divergent-author-fee-base.test.ts` deliberately
 * rather than imported: that file's copy is load-bearing for a different ledger,
 * and a shared helper whose semantics one of the two needed to change would
 * silently weaken the other.
 */
function callSites(source: string, opener: string): string[] {
  const sites: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(opener, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + opener.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    sites.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return sites;
}

/**
 * The exact threading expression. 🔴 PINNED AS A WHOLE STRING, NOT AS THE FIELD
 * NAME. `toContain('privateRun')` would be satisfied by `privateRun: false`,
 * `privateRun: true`, or a local variable that has drifted from the claim — three
 * spellings that each disable or wrongly enable a money arm while reading as
 * correctly wired. The claim is the ONLY legitimate source: it is the only value
 * an RS256 signature has vouched for.
 */
const THREADED = 'privateRun: claims.privateRun === true';

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
] as const;

describe('the private-run claim is threaded to every money call site', () => {
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
      expect(sites[0]).toContain(control);
    });

    it(`[REG] there are exactly ${count} call sites — fails if the set GROWS or SHRINKS`, () => {
      expect(sites, why).toHaveLength(count);
    });

    it('[REG] every call site threads the VERIFIED claim, not a literal', () => {
      const unthreaded = sites
        .map((site, i) => ({ i, site }))
        .filter(({ site }) => !site.includes(THREADED))
        .map(({ site }) => enclosingDecl(source, source.indexOf(site)));

      expect(
        unthreaded,
        `these ${opener} call sites do not pass \`${THREADED}\`. ` +
          'Thread the claim rather than exempting the path: ' +
          why
      ).toEqual([]);
    });
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
    const actual = source.split(THREADED).length - 1;
    expect(
      actual,
      `${expected} governed call sites are ledgered above, but the router threads the ` +
        `claim ${actual} times. If a new money helper needs it, add it to LEDGER.`
    ).toBe(expected);
  });
});
