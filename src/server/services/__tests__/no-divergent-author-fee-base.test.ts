import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  blankComments,
  declRegions,
  enclosingDecl,
  sourceDecls,
} from '~/test-utils/routerSourceRegions';

/**
 * THE SEAM GUARD — and the only guard in this change that is RED at `origin/main`.
 *
 * It lives HERE, under the `no-*.test.ts` convention-guard name, rather than
 * beside the module it protects: this is a source-text structural guard over a
 * call-site population, which is exactly the class `src/server/services/__tests__/no-*.test.ts`
 * exists for. `no-lint-rules-script-drift` only scans THIS directory for THIS
 * name shape, so a guard of this class parked anywhere else is invisible to the
 * ratchet and is not run by the fast `pnpm run test:lint-rules` selector — it
 * would surface only in the full unit suite, minutes later, in a file nobody
 * was looking at.
 *
 * `computeBlockAuthorFee` is hermetically covered by
 * `src/server/services/blocks/__tests__/author-fee.test.ts`, and
 * `recordSpendAttribution` has its own suite. Both can be green while the
 * feature is inert, because the defect lives in the seam neither of them owns:
 * the author fee is a percentage of `WorkflowCost.base`, and the spend path's
 * `buzzAmount` is a DIFFERENT number — the realized paid debit, which already
 * carries the per-resource model licensing fees, the lineage fee and the
 * viewer's tips. Both are plain positive Buzz integers, so nothing downstream
 * can tell them apart; feeding the wrong one produces a plausible fee that takes
 * a cut of another creator's licensing fee and compounds as fee-charging
 * resources stack.
 *
 * So this pins a RELATIONSHIP over the whole population rather than a component:
 * EVERY `recordSpendAttribution` call site must be fed a base AND the cap flag
 * that governs whether a fee may be computed on it, and both must come from the
 * RAW ORCHESTRATOR RESPONSE — `submitted.cost.base` / `submitted.cost.variable`,
 * hoisted into `realizedBaseCost` / `realizedPriceIsCap` — and NEVER from
 * `snapshot`. `BlockWorkflowSnapshot.cost` is deliberately `{ total }` only,
 * because widening that wire shape would publish the platform's cost breakdown to
 * every third-party app; so `snapshot` cannot supply either, and a
 * `snapshot.cost?.base` in the router would be `undefined` silently. The asserted
 * count makes the ledger fail when the set GROWS (a new submit path added without
 * a base) as well as when it SHRINKS.
 *
 * ⚠️ THE COUNT WENT 3 → 4 ON 2026-09-17, AND THAT IS THE GUARD WORKING. A fourth
 * `recordSpendAttribution` call site — `submitPassThroughStepWorkflow` — landed
 * on `main` while this change was in review, passing no base. Nothing in this
 * branch's own commits broke; the ledger caught a call site the branch had never
 * seen. Bumping the number is only half the fix: the new site is WIRED (base +
 * cap flag) rather than exempted, because an exemption is what the ledger exists
 * to make impossible.
 *
 * It is a SOURCE-TEXT guard by necessity: the three call sites are inside a
 * ~9,000-line tRPC router whose handlers cannot be invoked without the whole
 * orchestrator + auth stack. That makes it structural, so `author-fee.test.ts`
 * carries the behavioural half; a structural check alone would type-check past a
 * wrong argument.
 */

const ROUTER = path.join(process.cwd(), 'src/server/routers/blocks.router.ts');

/** Every `recordSpendAttribution({ … })` argument object in the router source. */
function spendAttributionCallSites(source: string): string[] {
  return callSites(source, 'recordSpendAttribution({');
}

/**
 * The nearest enclosing SUBMIT PATH name for an offset in the router source, and
 * the router sliced into one region per path.
 *
 * 🔴 BOTH COME FROM THE SHARED `routerSourceRegions` MODULE, NOT A LOCAL COPY.
 * `no-direct-block-budget-claim-read.test.ts` asserts that its reserving/
 * disclosing split uses "the same discriminator" this file ledgers roles with —
 * a claim two independently-maintained regexes cannot support. See that module's
 * header for the `\w+Procedure` widening and why it mattered.
 */
const enclosingSubmitPath = enclosingDecl;
const pathRegions = declRegions;

/**
 * EVERY `quoteBlockAuthorFee` CALL SITE, BY THE ROLE IT PLAYS — and the roles are
 * the point, not the count.
 *
 * 🔴 WHY A COUNT WOULD BE THE WRONG GUARD HERE. This assertion used to read
 * `expect(quotes).toHaveLength(2)`, which was exactly right while every quote
 * moved money. It stopped being right the moment the two ESTIMATE arms began
 * quoting the fee to DISPLAY it: bumping 2 → 4 would keep the file green while
 * losing the only distinction that matters, and the very next reader could wire a
 * reservation onto a disclosing site, or a disclosure onto a reserving one,
 * without a single assertion moving. This file has walked into that once already
 * — see the reversal guard below, whose previous version "COUNTED THE WRONG
 * POPULATION … the population that exists rather than the one that should".
 *
 * So each site is LEDGERED with its role, and the role is then CHECKED against
 * what its enclosing path actually does:
 *
 *   'reserving'  — the quote's result is folded into a number that is gated and
 *                  reserved, and the path later CHARGES. Money moves. Exactly
 *                  the two SUBMIT paths that have a pre-submit `cost.base`.
 *   'disclosing' — the quote's result is added to a number that is SHOWN to the
 *                  block and then thrown away. The path reserves nothing,
 *                  charges nothing and accrues nothing. A disclosing site that
 *                  grew any of those three is a fee being taken from a surface
 *                  the viewer was told was an estimate.
 *
 * `baseExpr`/`capExpr` are ledgered per site rather than asserted as one shared
 * string because the step ESTIMATE reads through an optional whatIf (the
 * orchestrator round-trip may have degraded, in which case no fee is priced),
 * so its spelling genuinely differs. The RELATIONSHIP is asserted separately and
 * uniformly: every site reads base AND cap from a `.cost?.` of a whatIf
 * response, and no site reads `snapshot`.
 */
const QUOTE_SITE_LEDGER: Record<
  string,
  { role: 'reserving' | 'disclosing'; baseExpr: string; capExpr: string; reason: string }
> = {
  submitWorkflow: {
    role: 'reserving',
    baseExpr: 'baseGenerationBuzz: whatIfResult.cost?.base',
    capExpr: 'priceIsCap: whatIfResult.cost?.variable',
    reason:
      'txt2img submit. The quote is added to `cost` BEFORE the per-call budget gate, the ' +
      'per-user cap, the consent budget, the per-app cap and the dev-tunnel backstop, and is ' +
      'the ceiling `chargeBlockAuthorFee` is held to.',
  },
  submitStepWorkflow: {
    role: 'reserving',
    baseExpr: 'baseGenerationBuzz: whatIfResult.cost?.base',
    capExpr: 'priceIsCap: whatIfResult.cost?.variable',
    reason:
      'registry-step submit. Same placement: `reserveBuzz = reserveGenerationBuzz + ' +
      'reservedAuthorFeeBuzz`, gated and reserved before the orchestrator submit.',
  },
  estimateWorkflow: {
    role: 'disclosing',
    baseExpr: 'baseGenerationBuzz: whatIfResult.cost?.base',
    capExpr: 'priceIsCap: whatIfResult.cost?.variable',
    reason:
      'txt2img ESTIMATE. Added to the snapshot total the block is shown so the quoted price ' +
      'is the price charged. Reserves nothing — the submit runs its own quote, and THAT one ' +
      'is what money is taken against.',
  },
  estimateStepWorkflow: {
    role: 'disclosing',
    baseExpr: 'baseGenerationBuzz: whatIfResult?.cost?.base',
    capExpr: 'priceIsCap: whatIfResult?.cost?.variable',
    reason:
      'registry-step ESTIMATE. Optional-chained because `quoteStepBuzz` returns null when the ' +
      'orchestrator round-trip degrades; an absent whatIf prices no fee, exactly as the shown ' +
      'generation price already falls back to the declared floor.',
  },
};

/** Every `<fn>({ … })` argument object in the router source, braces balanced. */
function callSites(source: string, opener: string): string[] {
  const sites: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(opener, from);
    if (start === -1) break;
    // Walk braces from the argument object's `{` to its match so a nested object
    // literal (every call site has several) cannot end the slice early.
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

describe('author fee — the spend-attribution seam', () => {
  const source = blankComments(readFileSync(ROUTER, 'utf8'));
  const sites = spendAttributionCallSites(source);

  it('the extractor itself finds call sites (positive control)', () => {
    // Without this, an extractor that silently matched nothing would make every
    // assertion below vacuously true over an empty array.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0]).toContain('workflowId');
  });

  it('there are exactly FOUR spend-attribution call sites', () => {
    // textToImage, customComfy, the registry-step bridge, and the pass-through
    // step. A new submit path is a deliberate decision about whether it charges
    // an author fee, so it should land here rather than silently inherit a skip.
    expect(sites).toHaveLength(4);
  });

  it('every call site passes a base generation cost', () => {
    for (const site of sites) expect(site).toContain('baseGenerationBuzz:');
  });

  it('every call site passes the hoisted `realizedBaseCost`, not a cost total', () => {
    for (const site of sites) {
      expect(site).toContain('baseGenerationBuzz: realizedBaseCost');
      expect(site).not.toMatch(
        /baseGenerationBuzz:\s*(buzzAmount|cost\b|snapshot\.cost\?\.total|ceiling|reserveBuzz)/
      );
    }
  });

  it('every call site passes the CAP FLAG that governs whether a fee may be charged', () => {
    // 🔴 THE SECOND HALF OF THE SEAM, AND IT FAILS THE SAME WAY THE FIRST DID.
    // A base alone is not enough to decide a fee: `WorkflowCost.variable` says
    // the price is a CAP that settles lower, and a percentage of a cap is a fee
    // on money the viewer gets refunded. A site that hoists the base but drops
    // the cap flag computes a plausible fee on provisional money — the same
    // class of silently-wrong number as feeding `buzzAmount`, and equally
    // invisible downstream, because both are plain Buzz integers.
    for (const site of sites) {
      expect(site).toContain('generationPriceIsCap: realizedPriceIsCap');
      expect(site).not.toMatch(/generationPriceIsCap:\s*(false|true|null|undefined)\b/);
    }
  });

  it('`realizedBaseCost` and `realizedPriceIsCap` are read from the orchestrator response', () => {
    // 🔴 The wire shape a block sees (`BlockWorkflowSnapshot.cost`) is
    // `{ total }` only, so `snapshot` CANNOT supply either — they have to come
    // off the raw submit response. This pins that, and pins the count, so a new
    // submit path cannot hoist a base from the total by copy-paste.
    //
    // 🔴 WHAT THIS GUARD DOES NOT COVER, STATED SO IT IS NOT MISTAKEN FOR
    // COVERAGE. It pins that the cap flag is read from the RIGHT OBJECT; it says
    // nothing about the orchestrator declining to send the field at all.
    // `WorkflowCost.variable` is `?: null | boolean`, so the pinned
    // `submitted.cost?.variable === true` maps BOTH `undefined` and `null` to
    // "not a cap" — an absent field is treated as a FINAL PRICE, and the fee is
    // computed. That is the fail-OPEN direction, the same direction as reading
    // `snapshot.cost?.variable`, reached by a different route: there the wrong
    // object is silent, here the right object is. Inert while slice 1 moves no
    // money; a money question the moment slice 2 settles, and resolving the
    // tri-state is SLICE 2'S POLICY CALL — this guard deliberately pins the
    // current shape rather than pre-empting it.
    const assignments = source.match(/realizedBaseCost =\s*\n?\s*typeof submitted\.cost\?\.base/g);
    expect(assignments).toHaveLength(4);
    expect(source).not.toMatch(/realizedBaseCost\s*=\s*[^;]*cost\?\.total/);

    const capAssignments = source.match(
      /realizedPriceIsCap =\s*\n?\s*submitted\.cost\?\.variable === true/g
    );
    expect(capAssignments).toHaveLength(4);
    // `snapshot` has no `variable` either — reading one would be `undefined`,
    // i.e. "never a cap", which is the fail-OPEN direction.
    expect(source).not.toMatch(/realizedPriceIsCap\s*=\s*[^;]*snapshot\./);
  });
});

/**
 * THE SLICE-2b HALF OF THE SEAM — the viewer-charge path.
 *
 * 🔴 EVERY ASSERTION IN THIS BLOCK IS RED AT `dce428a492` (the merge base): the
 * router contains ZERO `chargeBlockAuthorFee` call sites there, so the extractor
 * returns an empty array and the positive control fails first. It is regression
 * coverage in the strict sense — it pins a property this change introduces and
 * would catch its removal.
 *
 * 🔴 WHAT IT PINS AND WHY A UNIT TEST CANNOT. The one safety hole the design
 * review found is a fee DEBITED OUTSIDE THE RESERVATION. That is not a property
 * of any function — `chargeBlockAuthorFee` in isolation is correct either way.
 * It is a property of the ORDER of statements in a ~10,000-line tRPC router
 * whose handlers cannot be invoked without the whole orchestrator + auth stack.
 * So it is pinned as source text: the number every gate and every reservation is
 * taken against must LITERALLY be the generation price PLUS the quoted fee, and
 * every submit path must hand the charge the amount it reserved.
 *
 * ⚠️ THE HEADLINE SENTENCE ABOVE USED TO BE WIDER THAN THE BODY, WHICH IS THE
 * DEFECT CLASS THIS FILE EXISTS TO CATCH. It claimed the folded number was what
 * "every gate and every reservation is taken against", and asserted only that two
 * `… + reservedAuthorFeeBuzz` assignments existed — satisfiable by two folded
 * locals that no reservation ever reads. `the fee is inside the number every
 * RESERVATION reads` below now ties each folded name to the three reservation
 * call sites that must consume it, so the implementation is as wide as the claim.
 *
 * The behavioural half lives in
 * `src/server/services/blocks/__tests__/author-fee-charge.service.test.ts` — a
 * structural check alone would type-check past a wrong argument, and a
 * behavioural check alone cannot see a path that forgot to call at all.
 */

/**
 * SUBMIT PATHS THAT CHARGE NO AUTHOR FEE, keyed by path, with the number of
 * charge call sites in that path (0) and why — the shape
 * `no-unguarded-billable-submit.test.ts` uses, and for the same reason: it fails
 * on GROWTH (a path silently grows a charge) and on SHRINK (a path is wired up
 * and its exemption outlives it, or the path is deleted and the entry rots).
 *
 * 🔴 AN EXEMPTION, NOT A NO-OP CALL. An earlier revision kept these two paths in
 * the population by calling `chargeBlockAuthorFee({ …, reservedAuthorFeeBuzz: 0 })`
 * from each, and pinned a 2/2 split. That call returned
 * `{charged:false, reason:'not-reserved'}` at the callee's FIRST statement — before
 * the flag read, before the payee query, before any debit — on every request,
 * forever, and paying for it meant hoisting `deriveBlockSpendBasis` out of a
 * fire-and-forget closure onto the awaited request path to feed an argument that
 * was never reached. A ledger entry closes the population without putting dead
 * code on the hot path.
 */
/**
 * The declaration every no-fee path must carry at its spend guard, verbatim.
 *
 * 🔴 IT IS PINNED AS A WHOLE NORMALISED SENTENCE, NOT AS KEYWORDS, because the
 * artefact under test is prose: a guard on words is walkable by rewording, and
 * this sentence exists precisely to keep the exclusion's standing — a DEFENSIVE
 * guard that drops no row today — stated at the guard rather than re-invented by
 * a later editor in either direction. A cosmetic reword fails this test — that is the price
 * of a machine-checkable claim, and it is the price this arc has already paid
 * twice by not charging it.
 */
const WHATIF_ATTRIBUTION_DECLARATION =
  "SPEND ATTRIBUTION IS DELIBERATELY SKIPPED FOR THE 'whatif' SENTINEL ID ON THIS PATH, AND " +
  'THAT EXCLUSION IS A DEFENSIVE GUARD RATHER THAN AN ACTIVE BEHAVIOUR CHANGE.';

const NO_FEE_PATHS: Record<string, { charges: number; reason: string; whatifAttribution: string }> =
  {
    submitCustomComfyWorkflow: {
      charges: 0,
      whatifAttribution:
        'The fee’s reason for excluding the sentinel (one shared idempotency key, one UNIQUE ' +
        'accrual row) does not apply to a path that charges no fee. What applies is that ' +
        '`recordSpendAttribution` is idempotent on (workflowId, appBlockId), so one shared ' +
        'sentinel id would collapse every viewer’s submit into one row of a payout-relevant ' +
        'table. DEFENSIVE, NOT ACTIVE: the orchestrator stamps a server-minted id on every ' +
        'workflow it returns (whatIf included), so the sentinel is never observed here and no ' +
        'attribution row is dropped today. The guard exists because the orchestrator’s OpenAPI ' +
        'declares `id` optional-and-nullable and its null-omitting serializer would make a ' +
        'regression SILENT rather than loud.',
      reason:
        'POST-PAID. customComfy takes no whatIf quote at all — its ceiling IS the app’s declared ' +
        '`maxBuzz`, stamped as the step timeout the orchestrator enforces — so there is no ' +
        'pre-submit `cost.base` to price a fee from and nothing is reserved for one. Wiring a fee ' +
        'here means giving the path a pre-submit base and dropping this entry in the same commit.',
    },
    submitPassThroughStepWorkflow: {
      charges: 0,
      whatifAttribution:
        'Same as customComfy, and not the fee’s reasoning for the same reason: this path ' +
        'charges no fee, so only `recordSpendAttribution`’s (workflowId, appBlockId) ' +
        'idempotency is at stake, and one shared sentinel id would collapse every viewer’s ' +
        'submit into one row. DEFENSIVE, NOT ACTIVE, for the same reason: the orchestrator ' +
        'stamps an id on every workflow it returns, so the sentinel is never observed and no ' +
        'attribution row is dropped today.',
      reason:
        'POST-PAID, same as customComfy. Its pre-submit quote goes through ' +
        '`quotePassThroughStepBuzz`, which returns `cost.total` and nothing else, so there is no ' +
        '`cost.base` at reservation time. Widening that helper is what would wire a fee here.',
    },
  };

describe('author fee — the viewer-charge seam', () => {
  // 🔴 TWO VIEWS OF ONE FILE, AND THE SPLIT IS LOAD-BEARING IN BOTH DIRECTIONS.
  // `source` is comment-BLANKED and is what every CODE guard reads: a structural
  // check over raw text is walkable by a comment — `// await chargeBlockAuthorFee({`
  // left four money guards green while the fee stopped being debited, and the
  // `await`-adjacency check's 6-byte lookbehind matches `// await ` just as well.
  // `rawSource` keeps the comments and is read ONLY by the guards whose subject
  // IS a comment (the no-fee paths must DECLARE their exemption in prose).
  // Blanking those too made them fail for the opposite reason.
  const rawSource = readFileSync(ROUTER, 'utf8');
  const source = blankComments(rawSource);
  const charges = callSites(source, 'chargeBlockAuthorFee({');
  const quotes = callSites(source, 'quoteBlockAuthorFee({');

  /** Each submit path, by the `const spendWorkflowId` marker every one carries. */
  const submitMarkers: number[] = [];
  for (let at = source.indexOf('const spendWorkflowId = snapshot.workflowId;'); at !== -1; ) {
    submitMarkers.push(at);
    at = source.indexOf('const spendWorkflowId = snapshot.workflowId;', at + 1);
  }
  const submitPaths = submitMarkers.map((at) => enclosingSubmitPath(source, at));

  it('the extractor finds charge and quote call sites (positive control)', () => {
    // Without this, an extractor that silently matched nothing would make every
    // assertion below vacuously true over two empty arrays.
    expect(charges.length).toBeGreaterThan(0);
    expect(quotes.length).toBeGreaterThan(0);
    expect(charges[0]).toContain('workflowId');
  });

  it('the submit-path locator names all four paths (positive control)', () => {
    // The ledger below is keyed on these names, so a locator that resolved every
    // offset to `<module scope>` would make the ledger vacuous rather than red.
    expect(submitPaths).toEqual([
      'submitWorkflow',
      'submitCustomComfyWorkflow',
      'submitStepWorkflow',
      'submitPassThroughStepWorkflow',
    ]);
  });

  it('🔴 every submit path either charges an author fee or is a LEDGERED exemption', () => {
    // A new submit path is a deliberate decision about whether it charges an
    // author fee, so it has to land here rather than silently inherit a skip.
    const unexplained: string[] = [];
    let attributed = 0;
    for (let i = 0; i < submitMarkers.length; i += 1) {
      const end = submitMarkers[i + 1] ?? source.length;
      const region = source.slice(submitMarkers[i], end);
      const found = callSites(region, 'chargeBlockAuthorFee({').length;
      attributed += found;
      const expected = NO_FEE_PATHS[submitPaths[i]]?.charges ?? 1;
      if (found !== expected) {
        unexplained.push(
          `${submitPaths[i]}: ${found} charge site(s), ${expected} expected` +
            (NO_FEE_PATHS[submitPaths[i]] ? ' (ledgered as charging none)' : '')
        );
      }
    }

    expect(
      unexplained,
      'A submit path must call chargeBlockAuthorFee with the amount it reserved, or be added ' +
        'to NO_FEE_PATHS in this file with a reason. If you WIRED one up, drop its entry in the ' +
        'same commit — this ledger fails in both directions on purpose.'
    ).toEqual([]);

    // Every charge in the file is attributable to a submit path — otherwise a
    // charge added outside one would be invisible to the per-path counts above.
    expect(attributed).toBe(charges.length);
  });

  it('keeps no exemption for a submit path that no longer exists', () => {
    const stale = Object.keys(NO_FEE_PATHS).filter((p) => !submitPaths.includes(p));
    expect(stale, 'These paths are gone; drop their NO_FEE_PATHS entry.').toEqual([]);
  });

  it('requires a reason on every exemption', () => {
    const missing = Object.entries(NO_FEE_PATHS)
      .filter(([, e]) => !e.reason?.trim())
      .map(([p]) => p);
    expect(missing).toEqual([]);
  });

  it('🔴 every charge site passes the amount ITS OWN path reserved', () => {
    // The ceiling is what makes "priced into the reservation" structural rather
    // than conventional: the charge is clamped to `min(reserved, realized)`, so a
    // path can never bill past the number its own gates were measured against.
    for (const site of charges) expect(site).toMatch(/reservedAuthorFeeBuzz,/);
  });

  it('🔴 every charge site is AWAITED, never fire-and-forget', () => {
    // MUTANT (c): `await chargeBlockAuthorFee(` → `void chargeBlockAuthorFee(`.
    // It type-checks, every behavioural test stays green, and the debit becomes a
    // floating promise: a rejection is unhandled, the refund-on-accrual-failure
    // branch races the response, and the submit returns before the viewer has
    // been charged. The attribution write beside it IS deliberately
    // fire-and-forget, which is exactly why a reader could "make them consistent".
    let from = 0;
    let awaited = 0;
    for (;;) {
      const at = source.indexOf('chargeBlockAuthorFee({', from);
      if (at === -1) break;
      // The call is `await chargeBlockAuthorFee({` — assert on the token
      // immediately before it, so an `await` elsewhere in the file cannot satisfy
      // this.
      expect(source.slice(at - 6, at)).toBe('await ');
      awaited += 1;
      from = at + 1;
    }
    expect(awaited).toBe(charges.length);
  });

  it('🔴 every charge site carries the currency the GENERATION drained (D6)', () => {
    // MUTANT (a): `buzzType: spendBasis.buzzType` → `buzzType: 'yellow'`.
    // `'yellow'` is a valid `BuzzAccountType`, so it type-checks and no
    // behavioural test in the repo can see it — and it debits WITHDRAWABLE Buzz
    // for a generation paid in blue, then mints the author yellow, which is the
    // one coercion D6 forbids in both directions. Pinned as the derived name, and
    // as the ABSENCE of any literal.
    for (const site of charges) {
      expect(site).toContain('buzzType: spendBasis.buzzType');
      expect(site).not.toMatch(/buzzType:\s*['"]/);
    }
  });

  it('every charge site prices off the RAW orchestrator response, never `snapshot`', () => {
    // Same rule, same reason, as the attribution seam above: `snapshot.cost` is
    // `{ total }` only, so a `snapshot.cost?.base` here is `undefined` silently —
    // and `undefined` maps to a `base-unavailable` skip, i.e. the fee quietly
    // stops charging on every generation with nothing to say so.
    for (const site of charges) {
      expect(site).toContain('baseGenerationBuzz: realizedBaseCost');
      expect(site).toContain('priceIsCap: realizedPriceIsCap');
      expect(site).not.toMatch(/baseGenerationBuzz:\s*(snapshot|buzzAmount|cost\b|\d)/);
    }
  });

  it('🔴 no charge or attribution runs under the `whatif` SENTINEL id', () => {
    // `snapshotFromWorkflow` emits `workflow.id ?? 'whatif'`, so a real submit
    // whose response carries no id arrives with that literal. The fee's
    // idempotency key is DERIVED from the workflow id and the accrual's
    // `workflow_id` is UNIQUE, so one shared sentinel means one shared key and
    // one shared row ACROSS EVERY VIEWER: the second such generation conflicts on
    // the charge key (counted as "the money moved", by design), hits the unique
    // index, and reports `charged: true` having debited nothing — and a later
    // reversal keyed on `'whatif'` refunds whichever viewer owns the shared row.
    // Pinned per submit path, on the guard that wraps the spend block.
    for (let i = 0; i < submitMarkers.length; i += 1) {
      const end = submitMarkers[i + 1] ?? source.length;
      // The guard sits immediately after the marker; 400 chars covers the
      // multi-line `if (…)` without reaching the body's own comparisons.
      const guard = source.slice(submitMarkers[i], Math.min(end, submitMarkers[i] + 400));
      expect(guard, `${submitPaths[i]} does not exclude the 'whatif' sentinel`).toContain(
        "spendWorkflowId !== 'whatif'"
      );
      expect(guard).toContain("spendWorkflowId !== 'failed'");
    }
  });

  it('🔴 the two NO-FEE paths DECLARE that the sentinel exclusion drops their attribution row', () => {
    // 🔴 WHY A SECOND, PATH-SPECIFIC TEST WHEN THE LOOP ABOVE ALREADY COVERS ALL
    // FOUR MARKERS. On the two priced paths the exclusion is a FEE argument: one
    // shared sentinel id means one shared idempotency key and one UNIQUE accrual
    // row across every viewer. On these two paths no fee is charged, so that
    // argument does not apply and the clause's only effect would be that
    // `recordSpendAttribution` — a payout-relevant table — stops being written for
    // a submit whose orchestrator response carried no workflow id. That effect is
    // LATENT, not active: the orchestrator stamps a server-minted id on every
    // workflow it returns (whatIf included), so the sentinel is never observed on
    // these paths and no row is dropped today. The loop above cannot express any
    // of it: it would follow silently if someone "fixed" the loop, because it
    // holds these paths to the same clause for a reason that is not theirs.
    //
    // So the DECISION is pinned where it can be read: a verbatim declaration at
    // the guard, tied to a ledger entry carrying its own reason, failing if either
    // side is removed or reworded.
    const declaration = WHATIF_ATTRIBUTION_DECLARATION.replace(/\s+/g, ' ').trim();

    // POSITIVE CONTROL. Every assertion below sits inside a loop over the ledger,
    // so an emptied ledger would make this test pass having checked nothing. The
    // neighbouring ledger test would also go red in that case — which is exactly
    // why this line is here rather than assumed: a guard that only fails because a
    // DIFFERENT guard fails is green for the wrong reason.
    expect(Object.keys(NO_FEE_PATHS)).toEqual([
      'submitCustomComfyWorkflow',
      'submitPassThroughStepWorkflow',
    ]);

    for (const [pathName, entry] of Object.entries(NO_FEE_PATHS)) {
      const ledgered = entry.whatifAttribution?.trim() ?? '';
      expect(ledgered, `${pathName}: no ledgered reason for the skip`).not.toBe('');

      // The region between this path's own `async function` line and its spend
      // marker — entirely inside the path, so a neighbour's declaration cannot
      // satisfy it.
      const fnAt = source.indexOf(`async function ${pathName}(`);
      expect(fnAt, `${pathName}: submit helper not found`).toBeGreaterThan(-1);
      const markerIndex = submitMarkers.findIndex((at) => at > fnAt);
      const markerAt = submitMarkers[markerIndex];
      expect(markerAt, `${pathName}: spend marker not found`).toBeGreaterThan(fnAt);

      // 🔴 `rawSource`, NOT `source` — this slice's whole subject IS the comment,
      // and the blanked view is all spaces here. Byte offsets are identical
      // between the two views (blanking preserves positions), so the offsets
      // computed above index both correctly.
      const preamble = rawSource
        .slice(fnAt, markerAt)
        .replace(/^\s*\/\/ ?/gm, '')
        .replace(/\s+/g, ' ');
      expect(
        preamble,
        `${pathName} does not DECLARE the 'whatif' attribution skip at its spend guard. ` +
          'This path charges no author fee, so the exclusion is not inherited from the fee ' +
          'argument — it drops an attribution row, and that has to be stated, not implied.'
      ).toContain(declaration);

      // …and the clause it declares is actually there, guarding a block whose only
      // money-relevant consumer is the attribution write. That is what makes the
      // declaration a statement about this code rather than a comment: on these
      // paths, excluding the sentinel and dropping the attribution row are the
      // same act.
      const guarded = source.slice(markerAt, submitMarkers[markerIndex + 1] ?? source.length);
      expect(guarded).toContain("spendWorkflowId !== 'whatif'");
      expect(guarded).toContain('recordSpendAttribution({');
      expect(guarded).not.toContain('chargeBlockAuthorFee({');
    }
  });

  it('🔴 THE FEE IS INSIDE THE NUMBER EVERY RESERVATION READS, on both priced paths', () => {
    // 🔴 THIS IS THE WHOLE POINT OF THE SLICE, AND THE PREVIOUS VERSION OF THIS
    // TEST DID NOT CHECK IT. It asserted only that two `… + reservedAuthorFeeBuzz`
    // assignments existed — true of two folded locals nothing reads. What makes
    // the fee unable to escape the per-call `buzzBudget` gate, the per-user daily
    // cap, the viewer's OWN per-app CONSENT BUDGET, the per-app aggregate cap and
    // the dev-session backstop is that the folded NAME is the argument each
    // reservation is taken with.
    const folded = [...source.matchAll(/const (\w+) = \w+ \+ reservedAuthorFeeBuzz;/g)].map(
      (m) => m[1]
    );
    // txt2img folds into `cost`; the registry-step bridge folds into `reserveBuzz`.
    expect(folded).toEqual(['cost', 'reserveBuzz']);

    for (const name of folded) {
      // The three reservations, each taken against the FOLDED number.
      expect(source).toContain(`reserveBlockBuzzSpendForClaims(claims, userId, ${name})`);
      expect(source).toContain(`reserveAppSpend(claims.appBlockId, ${name})`);
      expect(source).toMatch(
        new RegExp(`reserveDevSessionBuzz\\(\\s*devTunnel\\.sessionId,\\s*${name},`)
      );
    }

    // MUTANT (b): `capOverage = billed - reserveGenerationBuzz` → `- reserveBuzz`.
    // `billed` is the orchestrator's GENERATION cost; `reserveBuzz` also carries
    // the fee leg, which is charged at exactly the reserved amount and can never
    // leave a counter short — so comparing against it understates every real
    // overage by the fee, which is the drift the code beside it says must not
    // happen. Both names are in scope and both type-check.
    expect(source).toContain('const capOverage = billed - reserveGenerationBuzz;');
    expect(source).not.toMatch(/capOverage\s*=\s*billed\s*-\s*reserveBuzz\b/);
    // The post-paid settle ceiling is the same one-word question: it is refunded
    // down to the GENERATION's realized `cost.total`, so a fee-inclusive ceiling
    // would refund the whole fee leg back into every cap while the fee stands.
    expect(source).toContain('ceiling: reserveGenerationBuzz,');
    expect(source).not.toMatch(/ceiling:\s*reserveBuzz\b/);
  });

  /** The path owning each `quoteBlockAuthorFee({`, paired with its source slice. */
  const quoteOwners = [...source.matchAll(/quoteBlockAuthorFee\(\{/g)].map((m) => ({
    path: enclosingSubmitPath(source, m.index),
    site: callSites(source.slice(m.index), 'quoteBlockAuthorFee({')[0],
  }));
  const regions = pathRegions(source);

  it('comment-stripping did not eat real code, and sees every declaration (controls)', () => {
    // 🔴 THE STRIPPER IS AN INSTRUMENT, SO IT IS VALIDATED BEFORE ITS VERDICT IS
    // READ. If `blankComments` ate real source, every assertion in this describe
    // would go vacuously green over an empty population.
    expect(source).toContain('quoteBlockAuthorFee({');
    expect(source).toContain('chargeBlockAuthorFee({');
    expect(source).toContain('reserveAppSpend(');
    // …and the NEGATIVE half: prose mentioning these functions must be GONE, or
    // a region check is red on a docblock rather than on code. The router's own
    // new comments discuss `chargeBlockAuthorFee` inside the ESTIMATE regions.
    expect(source).not.toContain('THE AUTHOR FEE IS PRICED INTO');

    // 🔴 A DECLARATION COUNT, so a future builder name (`someNewProcedure`)
    // cannot silently shrink the population every region check is taken over.
    // Measured: the pre-widening `(?:public|protected)Procedure` form captured
    // 42 of 189 two-space keys, and `uninstallFromModel`'s region then swallowed
    // 27 procedures whole.
    // Measured at this revision: the widened `\w+Procedure` form finds 106
    // declarations where the old `(?:public|protected)Procedure` form found 72.
    // The floor is set below today's count so ordinary churn does not trip it,
    // and ABOVE the narrow form's, so silently reverting the widening is red.
    const decls = sourceDecls(source);
    expect(decls.length, 'the declaration walk collapsed — regions are meaningless').toBeGreaterThan(
      90
    );
    for (const name of Object.keys(QUOTE_SITE_LEDGER)) {
      expect(decls.map((d) => d.name)).toContain(name);
    }
  });

  it('the quote-owner locator resolves every quote to a real path (positive control)', () => {
    // Without this a locator that answered `<module scope>` for everything would
    // make the ledger fail for the wrong reason, or — if `<module scope>` were
    // ever ledgered — pass vacuously.
    expect(quoteOwners.length).toBeGreaterThan(0);
    for (const { path: owner, site } of quoteOwners) {
      expect(owner).not.toBe('<module scope>');
      expect(site).toContain('appId: claims.appId');
    }
  });

  it('🔴 every fee quote is LEDGERED, and the ledger names every quote', () => {
    // Fails when the population GROWS (a new quote site with no declared role)
    // and when it SHRINKS (a ledgered site deleted) — the same both-directions
    // contract the spend-attribution ledger above carries.
    expect(new Set(quoteOwners.map((q) => q.path))).toEqual(new Set(Object.keys(QUOTE_SITE_LEDGER)));
    expect(quoteOwners).toHaveLength(Object.keys(QUOTE_SITE_LEDGER).length);
    for (const entry of Object.values(QUOTE_SITE_LEDGER)) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });

  it('🔴 every quote is priced off a WHATIF response — never off `snapshot`', () => {
    // THE RELATIONSHIP, asserted uniformly over all four regardless of role. The
    // fee is a percentage of `WorkflowCost.base`; `snapshot.cost` is `{ total }`
    // only, so a `snapshot.cost?.base` here is `undefined` SILENTLY and the fee
    // quietly stops being priced. Both the per-site spelling and the shape are
    // checked: the spelling catches a site pointed at the wrong object, the
    // shape catches a new site whose ledger entry was written to match it.
    for (const { path: owner, site } of quoteOwners) {
      const ledgered = QUOTE_SITE_LEDGER[owner];
      expect(site).toContain(ledgered.baseExpr);
      expect(site).toContain(ledgered.capExpr);
      expect(site).not.toContain('snapshot');
      expect(ledgered.baseExpr).toMatch(/^baseGenerationBuzz: \w+\??\.cost\?\.base$/);
      expect(ledgered.capExpr).toMatch(/^priceIsCap: \w+\??\.cost\?\.variable$/);
    }
  });

  it('🔴 a DISCLOSING quote reserves nothing and charges nothing', () => {
    // 🔴 THIS IS THE GUARD THE OLD `toHaveLength(2)` CANNOT EXPRESS, AND THE
    // REASON THE COUNT WAS REPLACED RATHER THAN BUMPED TO 4. An estimate arm is
    // reached at unbounded frequency with no idempotency key and no reservation
    // to reverse; a charge grown there would debit a viewer for a price quote.
    // Conversely a submit path that lost its charge would price a fee nobody is
    // ever billed and accrue nothing to the author.
    //
    // ⚠️ THE MARKERS ARE THE ONES VISIBLE IN THIS FILE, AND THE TITLE SAYS ONLY
    // WHAT THEY COVER. `accrueBlockAuthorFee` was in this list for one revision
    // and the guard went red on `submitWorkflow`: accrual is called by
    // `chargeBlockAuthorFee` INSIDE the service, so no router region can contain
    // it and the marker asserted something this corpus cannot see. It is covered
    // transitively by `chargeBlockAuthorFee(` and directly by the service's own
    // suite. A guard whose name is wider than its body reads as coverage while
    // providing none, so the name lost the clause rather than the body faking it.
    const MONEY_MARKERS = ['chargeBlockAuthorFee(', 'reserveAppSpend('];
    for (const [name, { role }] of Object.entries(QUOTE_SITE_LEDGER)) {
      const region = regions.get(name);
      expect(region, `no region for ${name} — the slicer is wrong`).toBeDefined();
      for (const marker of MONEY_MARKERS) {
        expect(
          region!.includes(marker),
          `${name} is ledgered '${role}' but ${role === 'disclosing' ? 'contains' : 'is missing'} ${marker}`
        ).toBe(role === 'reserving');
      }
    }
  });

  it('🔴 exactly the DISCLOSING quotes suppress the payee skip logs', () => {
    // Those logs do an unconditional `console.error` (a SYNCHRONOUS write when
    // stderr is a pipe) plus an HTTP ingest, and the estimate path is unbounded —
    // per parameter change, no rate limit — while a submit is once per real
    // generation. So the flag belongs on exactly the disclosing arms.
    //
    // BOTH DIRECTIONS. A reserving site that grew it would silence the skip
    // diagnostics on the path that MOVES MONEY, where they are the only record
    // that a fee was priced and then declined. A disclosing site that lost it
    // puts a synchronous write back on the unbounded surface.
    for (const { path: owner, site } of quoteOwners) {
      expect(
        site.includes('suppressSkipLogs: true'),
        `${owner} is ledgered '${QUOTE_SITE_LEDGER[owner].role}' — its suppressSkipLogs is wrong`
      ).toBe(QUOTE_SITE_LEDGER[owner].role === 'disclosing');
    }
  });

  it('the disclosure DERIVES quotesFigureSafely — it does not assert it', () => {
    // ⚠️ A SPELLED GUARD, AND LABELLED AS ONE. `quotesFigureSafely` is `true` for
    // the shipped config (whose only override is fee-FREE), so hardcoding it to
    // `true` is BEHAVIOURALLY INVISIBLE — a mutant doing exactly that survives
    // the whole battery, because no reachable input distinguishes the literal
    // from the expression. Confirmed by mutation, not assumed.
    //
    // The property is still worth pinning: the field exists precisely so that
    // ADDING a charging override switches the consent screen to the figure-free
    // wording instead of leaving a rendered number silently wrong. A literal
    // would make that switch dead on arrival, and the failure would first appear
    // as false money copy on a consent screen.
    //
    // So this checks the EXPRESSION, and the value it is derived FROM is covered
    // behaviourally by `describeBlockAuthorFee`'s own suite, which drives
    // charging and fee-free overrides directly. Structural + behavioural halves,
    // neither sufficient alone.
    expect(source).toContain('quotesFigureSafely: fee.chargingOverrideTypes.length === 0');
    expect(source).not.toMatch(/quotesFigureSafely:\s*(?:true|false)\b/);
  });

  it('🔴 on a RESERVING path the order is price → reserve → charge', () => {
    // Scoped to the path's OWN region. Measured against the whole file this read
    // `indexOf` over every occurrence, so once an estimate arm gained the
    // textually-first quote the assertion still passed — while no longer saying
    // anything about the submit path it names. A quote taken after the
    // reservation is a number nothing was gated on.
    for (const [name, { role }] of Object.entries(QUOTE_SITE_LEDGER)) {
      if (role !== 'reserving') continue;
      const region = regions.get(name)!;
      const quoteAt = region.indexOf('quoteBlockAuthorFee({');
      const reserveAt = region.indexOf('reserveAppSpend(');
      const chargeAt = region.indexOf('chargeBlockAuthorFee({');
      expect(quoteAt, `${name}: no quote`).toBeGreaterThan(-1);
      expect(reserveAt, `${name}: no reservation`).toBeGreaterThan(-1);
      expect(chargeAt, `${name}: no charge`).toBeGreaterThan(-1);
      expect(quoteAt, `${name}: quoted after reserving`).toBeLessThan(reserveAt);
      expect(reserveAt, `${name}: reserved after charging`).toBeLessThan(chargeAt);
    }
  });

  it('🔴 only an ESTIMATE arm may add the fee to the total it reports', () => {
    // The disclosure's other half. On a SUBMIT the reported total is the realized
    // GENERATION cost, and the settle/refund arithmetic downstream is taken
    // against it (`snapshot.cost?.total ?? ceiling`), so adding the fee there
    // would refund the fee back into every cap while the fee stands.
    //
    // 🔴 THE POPULATION IS "EVERY SITE THAT ADDS A QUOTED FEE TO A REPORTED
    // PRICE", NOT ONE SPELLING OF IT — AND THE NARROW VERSION OF THIS GUARD WAS
    // WALKABLE. It enumerated `additionalCostBuzz:` alone, which is how the
    // TXT2IMG estimate inflates; the STEP estimate adds its fee with a plain
    // `shownGenerationBuzz + …`, so the guard covered 1 of the 2 arms this change
    // introduced, and a submit path inflating its own `snapshot.cost` directly
    // was invisible to it. Both spellings are enumerated here, and the title now
    // says what the body checks.
    //
    // ⚠️ THE RESERVATION SPELLING IS DELIBERATELY NOT IN THIS POPULATION.
    // `authorFeeQuote.charge ? authorFeeQuote.feeBuzz : 0` appears on the SUBMIT
    // paths too, where it feeds `reservedAuthorFeeBuzz` — a gate input, not a
    // reported price. Matching it here made this guard red on correct code, which
    // is how the narrower expression below was arrived at.
    const inflators = [
      ...[...source.matchAll(/additionalCostBuzz:/g)],
      ...[...source.matchAll(/shownGenerationBuzz \+ \(authorFeeQuote/g)],
    ].map((m) => enclosingSubmitPath(source, m.index));
    expect(inflators.length, 'no inflator found — the matcher is wrong').toBeGreaterThan(0);
    // Both spellings must be present, or one half of the matcher is dead and the
    // guard silently narrows back to what it used to be.
    expect(source).toContain('additionalCostBuzz:');
    expect(source).toContain('shownGenerationBuzz + (authorFeeQuote');
    for (const owner of inflators) {
      expect(QUOTE_SITE_LEDGER[owner]?.role, `${owner} adds a fee to a reported total`).toBe(
        'disclosing'
      );
    }
    // 🔴 AND THE RESERVING PATHS' OWN REPORTED TOTALS ARE UNTOUCHED. A submit
    // that added the fee to `snapshot.cost` — by any spelling — is the mutation
    // the enumeration above cannot see if it invents a third one.
    for (const [name, { role }] of Object.entries(QUOTE_SITE_LEDGER)) {
      if (role !== 'reserving') continue;
      expect(regions.get(name)!).not.toMatch(/snapshot\.cost[^)]*\+/);
    }
  });

  it('🔴 EVERY procedure that cancels a workflow also reverses the fee', () => {
    // 🔴 THE PREVIOUS VERSION OF THIS GUARD COUNTED THE WRONG POPULATION, AND
    // THAT IS WHY IT WAS GREEN OVER A REAL HOLE. It asserted
    // `reversals.toHaveLength(2)` — a count of REVERSAL sites, i.e. the population
    // that exists rather than the one that should — while naming
    // `cancelAppWorkflow` as one of the two. It was not: the two sites were
    // `pollWorkflow` and `cancelWorkflow`, and `cancelAppWorkflow` issued a real
    // orchestrator cancel and reversed nothing, so a block cancelling through it
    // got its generation refunded while the accrual stood and the nightly job
    // minted the fee to the author.
    //
    // So the population is derived from the CANCEL sites, not the reversal sites.
    const cancelSites = [...source.matchAll(/await cancelWorkflow\(\{/g)].map((m) =>
      enclosingSubmitPath(source, m.index)
    );
    expect(cancelSites.length, 'no cancel sites found — the matcher is wrong').toBeGreaterThan(0);
    expect(new Set(cancelSites)).toEqual(new Set(['cancelWorkflow', 'cancelAppWorkflow']));

    const reversalOwners = [...source.matchAll(/await reverseBlockAuthorFee\(\{/g)].map((m) =>
      enclosingSubmitPath(source, m.index)
    );
    // Every cancel-capable procedure reverses …
    for (const proc of cancelSites) expect(reversalOwners).toContain(proc);
    // … and so does the terminal poll, which is the third and only other observer.
    expect(new Set(reversalOwners)).toEqual(
      new Set(['pollWorkflow', 'cancelWorkflow', 'cancelAppWorkflow'])
    );
    expect(reversalOwners).toHaveLength(3);

    // 🔴 EVERY reversal is keyed on the procedure's OWN input id. The reversal
    // deletes a row and issues a refund, so a site keyed on some other id in
    // scope would refund the wrong viewer — and all three procedures have a
    // `snapshot`/`workflow` object in scope carrying a different workflow id.
    // (`terminalStatus` is deliberately NOT pinned to one expression: the poll
    // and `cancelWorkflow` read `snapshot.status`, `cancelAppWorkflow` reads its
    // projection's.)
    for (const site of callSites(source, 'reverseBlockAuthorFee({')) {
      expect(site).toContain('workflowId: input.workflowId');
      expect(site).toMatch(/terminalStatus: \w+\.status,/);
    }
  });

  it('🔴 every reversal is guarded on TERMINAL-ness AND on not-succeeded', () => {
    // TWO conditions, and dropping either is a money defect in a different
    // direction.
    //
    // `!== 'succeeded'`: a cancel RACES completion, so the re-read can report
    // `succeeded` — the viewer got their generation, the orchestrator refunds
    // nothing, and reversing would hand back money for delivered work.
    //
    // TERMINAL: `cancelWorkflow` passes no `throwOnError`, so a non-2xx PATCH
    // RESOLVES and the re-read returns the workflow's real, still-RUNNING status.
    // `'processing' !== 'succeeded'` is true, so a `succeeded`-only guard reverses
    // on a cancel that did not take — the viewer keeps the generation AND gets the
    // fee back, and the author is paid nothing. The poll site used to get this
    // right by ENCLOSURE (it sat inside a terminal block) which was correct and
    // not checkable; all three now spell the same compound guard.
    let from = 0;
    let guarded = 0;
    for (;;) {
      const at = source.indexOf('reverseBlockAuthorFee({', from);
      if (at === -1) break;
      const before = source.slice(Math.max(0, at - 300), at);
      expect(before).toMatch(/TERMINAL_BLOCK_WORKFLOW_STATUSES\.has\(\w+(?:\.\w+)*\)/);
      expect(before).toMatch(/\w+(?:\.\w+)*\.status !== 'succeeded'|\w+\.status !== 'succeeded'/);
      guarded += 1;
      from = at + 1;
    }
    expect(guarded).toBe(3);
  });
});
