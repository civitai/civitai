import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE SEAM GUARD — and the only guard in this change that is RED at `origin/main`.
 *
 * `computeBlockAuthorFee` is hermetically covered by `author-fee.test.ts`, and
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
 * EVERY `recordSpendAttribution` call site must be fed a base, and it must be
 * `snapshot.cost?.base`. The asserted count makes the ledger fail when the set
 * GROWS (a fourth submit path added without a base) as well as when it SHRINKS.
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

  it('there are exactly THREE spend-attribution call sites', () => {
    // textToImage, customComfy, and the registry-step bridge. A fourth submit
    // path is a deliberate decision about whether it charges an author fee, so
    // it should land here rather than silently inherit a skip.
    expect(sites).toHaveLength(3);
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

  it('`realizedBaseCost` is read from the orchestrator response `cost.base`', () => {
    // 🔴 The wire shape a block sees (`BlockWorkflowSnapshot.cost`) is
    // `{ total }` only, so `snapshot` CANNOT supply the base — it has to come
    // off the raw submit response. This pins that, and pins the count, so a new
    // submit path cannot hoist a base from the total by copy-paste.
    const assignments = source.match(/realizedBaseCost =\s*\n?\s*typeof submitted\.cost\?\.base/g);
    expect(assignments).toHaveLength(3);
    expect(source).not.toMatch(/realizedBaseCost\s*=\s*[^;]*cost\?\.total/);
  });
});
