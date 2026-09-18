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
  const sites: string[] = [];
  const opener = 'recordSpendAttribution({';
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
