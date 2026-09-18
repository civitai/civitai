import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

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
  const source = readFileSync(ROUTER, 'utf8');
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
 * The behavioural half lives in
 * `src/server/services/blocks/__tests__/author-fee-charge.service.test.ts` — a
 * structural check alone would type-check past a wrong argument, and a
 * behavioural check alone cannot see a path that forgot to call at all.
 */
describe('author fee — the viewer-charge seam', () => {
  const source = readFileSync(ROUTER, 'utf8');
  const charges = callSites(source, 'chargeBlockAuthorFee({');
  const quotes = callSites(source, 'quoteBlockAuthorFee({');

  it('the extractor finds charge and quote call sites (positive control)', () => {
    // Without this, an extractor that silently matched nothing would make every
    // assertion below vacuously true over two empty arrays.
    expect(charges.length).toBeGreaterThan(0);
    expect(quotes.length).toBeGreaterThan(0);
    expect(charges[0]).toContain('workflowId');
  });

  it('there are exactly FOUR charge call sites — one per submit path', () => {
    // textToImage, customComfy, the registry-step bridge, and the pass-through
    // step. A new submit path is a deliberate decision about whether it charges
    // an author fee, so it must land here rather than silently inherit a skip.
    expect(charges).toHaveLength(4);
  });

  it('🔴 every charge site passes the amount ITS OWN path reserved', () => {
    // The ceiling is what makes "priced into the reservation" structural rather
    // than conventional: a path that reserved nothing passes 0 and can then
    // charge nothing, whatever the realized base says.
    for (const site of charges) expect(site).toContain('reservedAuthorFeeBuzz');
  });

  it('🔴 exactly TWO paths reserve a fee and exactly TWO reserve none', () => {
    // The two that reserve none are POST-PAID and take no pre-submit `cost.base`
    // to price from (customComfy makes no whatIf quote at all; the pass-through
    // quote helper returns a total only). Asserting the SPLIT rather than just
    // the total is what makes a silent regression visible in either direction: a
    // priced path degraded to 0 stops charging, and a post-paid path handed a
    // live reserve starts charging off a ceiling.
    const zeroed = charges.filter((s) => /reservedAuthorFeeBuzz:\s*0\b/.test(s));
    const priced = charges.filter((s) => /reservedAuthorFeeBuzz,/.test(s));
    expect(zeroed).toHaveLength(2);
    expect(priced).toHaveLength(2);
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

  it('🔴 THE FEE IS INSIDE THE RESERVED NUMBER, on both priced paths', () => {
    // The whole point of the slice, as source text. `cost` (txt2img) and
    // `reserveBuzz` (registry step) are the numbers the per-call `buzzBudget`
    // gate, the per-user daily cap, the viewer's OWN per-app CONSENT BUDGET, the
    // per-app aggregate cap and the dev-session backstop are each taken against.
    // Delete either `+ reservedAuthorFeeBuzz` and the fee escapes all five while
    // every other test in this repo stays green.
    const folded = source.match(/=\s*\w+\s*\+\s*reservedAuthorFeeBuzz;/g);
    expect(folded).toHaveLength(2);
  });

  it('🔴 both quotes are priced off the WHATIF response, before anything is reserved', () => {
    expect(quotes).toHaveLength(2);
    for (const site of quotes) {
      expect(site).toContain('baseGenerationBuzz: whatIfResult.cost?.base');
      expect(site).toContain('priceIsCap: whatIfResult.cost?.variable');
    }
    // ORDERING, on the txt2img path: price → reserve → charge. A quote taken
    // after the reservation would be a number nothing was gated on, which is the
    // defect this whole block exists to make impossible.
    const firstQuote = source.indexOf('quoteBlockAuthorFee({');
    const firstReserve = source.indexOf('reserveAppSpend(');
    const firstCharge = source.indexOf('chargeBlockAuthorFee({');
    expect(firstQuote).toBeGreaterThan(-1);
    expect(firstQuote).toBeLessThan(firstReserve);
    expect(firstReserve).toBeLessThan(firstCharge);
  });

  it('🔴 the fee is REVERSED where the generation reaches a non-succeeded terminal state', () => {
    // Two observers reach a terminal workflow: `pollWorkflow` (every poll after
    // the workflow settles) and `cancelAppWorkflow`. Both must reverse, or a
    // refunded generation leaves an accrual standing and the author is paid out
    // of money the viewer got back. Pinned as a COUNT so removing one is visible.
    const reversals = callSites(source, 'reverseBlockAuthorFee({');
    expect(reversals).toHaveLength(2);
    for (const site of reversals) {
      expect(site).toContain('workflowId: input.workflowId');
      expect(site).toContain('terminalStatus: snapshot.status');
    }
  });

  it('🔴 neither reversal fires on a SUCCEEDED workflow', () => {
    // The direction of this reversal that costs the AUTHOR rather than
    // protecting the viewer. `cancelAppWorkflow` is where it bites: a cancel
    // RACES completion, so the re-read after `cancelWorkflow` can report
    // `succeeded` — the viewer got their generation, the orchestrator refunds
    // nothing, and a reversal would hand back money for delivered work.
    //
    // Pinned on the text immediately PRECEDING each call rather than on a bare
    // substring count, so a guard that exists somewhere else in the file cannot
    // satisfy it.
    let from = 0;
    let guarded = 0;
    for (;;) {
      const at = source.indexOf('reverseBlockAuthorFee({', from);
      if (at === -1) break;
      if (source.slice(Math.max(0, at - 200), at).includes("snapshot.status !== 'succeeded'")) {
        guarded += 1;
      }
      from = at + 1;
    }
    expect(guarded).toBe(2);
  });
});
