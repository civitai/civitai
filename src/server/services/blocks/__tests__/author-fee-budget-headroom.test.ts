import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { jwtVerify } from 'jose';
import { createPublicKey } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blockAuthorFeeUpperBound,
  computeBlockAuthorFee,
} from '~/server/services/blocks/author-fee';
// The block-token RSA keypair is provisioned globally in the test setup, which
// re-exports the public PEM — the same arrangement `block-token.service.test.ts`
// uses, and required because `env/server.ts` snapshots its values at import time.
import { TEST_BLOCK_TOKEN_PUBLIC_PEM } from '~/__tests__/setup';

/**
 * THE AUTHOR-FEE BUDGET HEADROOM — the SEAM between three surfaces that are each
 * separately tested and were still broken together.
 *
 * `author-fee.ts` is unit-tested, `block-token.service.ts` is unit-tested, and
 * the submit gate in `blocks.router.ts` is unit-tested; none of them ever built
 * the combined state, which is the state that matters:
 *
 *     the app declares a budget  →  the token is minted from it
 *                                →  a generation is priced
 *                                →  a fee is added to that price
 *                                →  the SUM is compared against the token
 *
 * Every test here composes the REAL mint (`BlockTokenService.sign`, verified
 * through the REAL JWT round-trip) with the REAL fee computation
 * (`computeBlockAuthorFee`) and the REAL gate EXPRESSION, because the defect
 * lives in none of the three and in all of them.
 *
 * 🔴 THE GATE EXPRESSION IS SPELLED OUT HERE RATHER THAN IMPORTED, and that is a
 * known weakness, recorded rather than papered over: `blocks.router.ts` compares
 * `quotedGenerationBuzz + reservedAuthorFeeBuzz > claims.buzzBudget` inline
 * inside a ~200-line tRPC procedure, so there is nothing to import. `gateAccepts`
 * below is a transcription of it; if the router's summation changes, this file
 * keeps passing while production moves. The router's own suite
 * (`blocks.router.workflow.test.ts`) is what pins the summation; this file pins
 * the BUDGET the summation is compared against.
 */
const publicKey = createPublicKey(TEST_BLOCK_TOKEN_PUBLIC_PEM);

/** Mint a real token for a declared budget and read back its claims. */
async function mintAndDecode(declaredBudget: number | undefined) {
  const { BlockTokenService } = await import('~/server/services/block-token.service');
  const result = await BlockTokenService.sign({
    userId: 7,
    blockId: 'blk_headroom',
    appId: 'app_headroom',
    appBlockId: 'apb_headroom',
    blockInstanceId: 'bki_headroom',
    scopes: ['ai:write:budgeted'],
    ctx: { slotId: 'app.page', entityType: 'none' },
    ...(declaredBudget === undefined ? {} : { buzzBudget: declaredBudget }),
  });
  const { payload } = await jwtVerify(result.token, publicKey, {
    issuer: 'civitai',
    audience: 'civitai-app-block',
    algorithms: ['RS256'],
  });
  return payload as { buzzBudget?: number; buzzBudgetDeclared?: number };
}

/**
 * `blocks.router.ts` — `const cost = quotedGenerationBuzz + reservedAuthorFeeBuzz;`
 * then `if (cost > claims.buzzBudget) { …rejected… }`. Transcribed; see the note
 * at the top of the file for why it cannot be imported.
 */
function gateAccepts(generationBuzz: number, feeBuzz: number, claimedBudget: number): boolean {
  return generationBuzz + feeBuzz <= claimedBudget;
}

/** The fee production would charge for one generation, via the real computation. */
function feeFor(baseGenerationBuzz: number, generationType: unknown = 'textToImage') {
  return computeBlockAuthorFee({ baseGenerationBuzz, generationType }).feeBuzz;
}

describe('🔴 REGRESSION — an app sized at its own declared ceiling still submits', () => {
  /**
   * THE MEASURED CASE, not a constructed one. Of the app blocks carrying real
   * traffic, one declares a per-generation budget of 50 and has a maximum
   * observed generation cost of 50 — it sits EXACTLY at its ceiling, so any fee
   * of 1 ⚡ or more rejects it outright. A second clears its ceiling by zero.
   *
   * "Rejected" here is not a degraded result: no workflow is created, the viewer
   * gets nothing, and it stays broken for EVERY viewer until the author ships a
   * new manifest version and it is re-approved (the repo's own manifest schema
   * says so — `public/schemas/app-block/v1.json`, `page.buzzBudgetPerGen`).
   */
  const DECLARED = 50;
  const GENERATION = 50;
  const BASE = 50;

  it('accepts generation 50 + fee 2 on a token minted from a declared budget of 50', async () => {
    // The case is the one described: the fee this generation attracts is 2.
    const fee = feeFor(BASE);
    expect(fee).toBe(2);

    const claims = await mintAndDecode(DECLARED);
    expect(typeof claims.buzzBudget).toBe('number');

    // PRE-CHANGE this is `50 + 2 <= 50` → false → "insufficient buzz budget".
    expect(gateAccepts(GENERATION, fee, claims.buzzBudget as number)).toBe(true);
  });

  it('mints 52, not 50 — the grant is a number, not a rounding accident', async () => {
    const claims = await mintAndDecode(DECLARED);
    expect(claims.buzzBudget).toBe(52);
    expect(claims.buzzBudgetDeclared).toBe(50);
  });
});

describe('the sufficiency PROPERTY — not one case, every case', () => {
  /**
   * The property the fix has to have: NO generation that passes the gate today
   * can be rejected after it. Today's gate is `generation <= budget`; after the
   * fee it is `generation + fee <= budget + allowance`.
   *
   * 🔴 FIXTURE CHOICE IS PART OF THE TEST. Every budget below is coprime-ish,
   * non-round, and distinct from EVERY constant this file or the implementation
   * names — 1 (the flat leg), 10 / 50 (the budget defaults), 100 (the flat
   * ceiling), 250 / 1000 (the dev and prod budget caps), 500 / 10000 (the basis
   * points). A mutant that hardcodes any of those, or that returns the declared
   * budget unchanged, cannot land on these values by coincidence. They are also
   * not multiples of the 20-Buzz percentage crossover, so both legs of
   * `max(flat, pct)` govern somewhere in the sweep.
   */
  const BUDGETS = [3, 37, 83, 149, 613, 997];

  it('accepts every (generation, base) pair the pre-fee gate accepted', async () => {
    let checked = 0;
    for (const budget of BUDGETS) {
      const claims = await mintAndDecode(budget);
      const effective = claims.buzzBudget as number;

      // Every generation price the OLD gate accepted, i.e. `generation <= budget`.
      const generations = [1, 2, Math.floor(budget / 2) + 1, budget - 1, budget].filter(
        (g) => g >= 1 && g <= budget
      );
      for (const generation of generations) {
        // `base <= generation` — `WorkflowCost.total` is `base` plus licensing
        // fees and tips, so the base can be anywhere at or below the price.
        const bases = [
          1,
          Math.floor(generation / 3),
          Math.floor(generation / 2),
          generation,
        ].filter((b) => b >= 1 && b <= generation);
        for (const base of bases) {
          checked += 1;
          expect(
            gateAccepts(generation, feeFor(base), effective),
            `budget=${budget} generation=${generation} base=${base} effective=${effective}`
          ).toBe(true);
        }
      }
    }
    // POSITIVE CONTROL on the sweep itself: a silently-empty loop is a green
    // that measured nothing. The floor is deliberately well under the real count.
    expect(checked).toBeGreaterThan(40);
  });

  it('a generation ABOVE the declared budget is still bounded — the grant is headroom, not a raise', async () => {
    // The grant is not licence to spend: it is at most `max(1, 5% of budget)`
    // above the declared ceiling, and this pins that bound rather than trusting
    // the prose. 997 → 49; a mutant that grants a MULTIPLE of the budget, or the
    // budget itself, blows this.
    const claims = await mintAndDecode(997);
    expect((claims.buzzBudget as number) - 997).toBe(49);
    expect(gateAccepts(997 + 50, 0, claims.buzzBudget as number)).toBe(false);
  });
});

describe('the grant is UNCONDITIONAL — it does not wait for the fee flag', () => {
  afterEach(() => {
    vi.doUnmock('~/server/services/app-blocks-flag');
    vi.resetModules();
  });

  /**
   * 🔴 WHY UNCONDITIONAL, AND WHY IT IS TESTED RATHER THAN ASSUMED. A flag-gated
   * grant would be ABSENT from every token minted before the flag flips, so the
   * flip itself would break exactly the apps this fix exists to protect — until
   * each of them re-minted. Granting unconditionally lets the grant ship and
   * fully deploy AHEAD of any flip, which is the only safe dependency order.
   *
   * The cost is that while the fee is off, a gate that PRICES a fee compares
   * `generation + 0` against the granted ceiling, so such an app may price a
   * generation up to `declared + allowance`. Bounded and deliberate; the test
   * above pins the bound. The two FEE-FREE gates never see the grant at all —
   * they read the declared claim through `blockPerCallBudget`.
   */
  async function mintUnderFlag(enabled: boolean) {
    vi.resetModules();
    const flagSpy = vi.fn(async () => enabled);
    vi.doMock('~/server/services/app-blocks-flag', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      isAppBlocksAuthorFeeEnabled: flagSpy,
    }));
    const claims = await mintAndDecode(50);
    return { budget: claims.buzzBudget as number, flagSpy };
  }

  /**
   * 🔴 THE SPY IS THE TEST; THE TWO EQUAL NUMBERS ARE NOT.
   *
   * Comparing flag-off against flag-on looks like it proves independence and
   * proves almost nothing: in the unit environment the real flag resolves false
   * anyway, so under a flag-gated grant BOTH arms would return 50 and the
   * comparison would still be "equal". It also cannot distinguish a working mock
   * from a mock wired to nothing. Asserting the mint path never CALLS the flag is
   * a structural claim about the seam, and it goes red the moment anyone adds a
   * flag read to `sign` — which is the regression this block exists to prevent.
   */
  it('the mint path never reads the author-fee flag', async () => {
    const { budget, flagSpy } = await mintUnderFlag(false);
    expect(flagSpy).not.toHaveBeenCalled();
    expect(budget).toBe(52);
  });

  it('grants the same headroom with the flag OFF as with it ON', async () => {
    expect((await mintUnderFlag(false)).budget).toBe(52);
    expect((await mintUnderFlag(true)).budget).toBe(52);
  });
});

describe('the headroom deliberately clears BUZZ_BUDGET_CAP', () => {
  /**
   * `input.buzzBudget` reaches `sign` ALREADY clamped by its resolver — 1000 on
   * the production host mint, 250 on every dev mint. The grant goes ON TOP of
   * that clamp, so a 1000-budget app signs 1050.
   *
   * 🔴 CLAMPING AFTER THE GRANT WOULD BE THE BUG, NOT THE FIX. It would delete
   * the grant for precisely the apps sitting at the cap — the worst-affected
   * class — while every signal reported success. The caps bound what an app may
   * spend on a GENERATION; the allowance is not spendable on one, it can only
   * ever be consumed by a fee the platform itself levies.
   */
  it('signs 1050 for a budget already clamped to the production cap of 1000', async () => {
    const claims = await mintAndDecode(1000);
    expect(claims.buzzBudget).toBe(1050);
    expect(claims.buzzBudgetDeclared).toBe(1000);
  });

  it('signs 262 for a budget already clamped to the dev cap of 250', async () => {
    const claims = await mintAndDecode(250);
    expect(claims.buzzBudget).toBe(262);
  });
});

describe('a budget that means nothing is left exactly as it was', () => {
  /**
   * `sign` does no range validation (every clamp is upstream in the two
   * resolvers), so a non-positive budget can reach it. It must stay byte-identical
   * to the pre-grant behaviour: the scope middleware's
   * `claims.buzzBudget <= 0 → forbidden` gate is what rejects it, and a grant
   * that nudged a 0 to a 1 would walk a dead token straight past that gate.
   */
  it.each([0, -5])('leaves a budget of %s untouched', async (declared) => {
    const claims = await mintAndDecode(declared);
    expect(claims.buzzBudget).toBe(declared);
  });

  it('stamps neither claim when no budget is supplied', async () => {
    const claims = await mintAndDecode(undefined);
    expect(claims.buzzBudget).toBeUndefined();
    expect(claims.buzzBudgetDeclared).toBeUndefined();
  });
});

describe('blockAuthorFeeUpperBound', () => {
  it('bounds the real platform config at both legs of max(flat, pct)', () => {
    // Below the 20-Buzz crossover the flat leg governs; above it the percentage does.
    // Literals, not the implementation's own constants: an assertion that names
    // the constant it compares against moves WITH a mutant that changes it.
    expect(blockAuthorFeeUpperBound(7)).toBe(1);
    expect(blockAuthorFeeUpperBound(83)).toBe(4);
  });

  it('MAXIMIZES OVER THE WHOLE TABLE, not just the default', () => {
    /**
     * 🔴 THE MUTATION THIS EXISTS TO KILL. The generation type is unknown at mint
     * time, so a per-type override that charges MORE than the default breaks the
     * bound if only `config.default` is consulted. Today's platform table holds
     * one override and it charges LESS (`chat-completion` → 0/0), so against the
     * REAL config `default`-only and `max-over-table` return the same number and
     * the mutant survives — this fixture is the only thing that separates them.
     */
    const bound = blockAuthorFeeUpperBound(83, {
      default: { flatBuzz: 1, pctOfBase: 0.05 },
      byType: [
        ['chat-completion', { flatBuzz: 0, pctOfBase: 0 }],
        ['textToImage', { flatBuzz: 9, pctOfBase: 0.2 }],
      ],
    });
    // The expensive override governs: max(9, floor(83 × 20%)) = 16.
    expect(bound).toBe(16);
    // And strictly above what the default pair alone produces — a literal, because
    // comparing the function against ITSELF cannot see a uniform scaling error.
    expect(bound).toBeGreaterThan(4);
  });

  it('bounds a config whose legs are out of range, because the fee itself is clamped', () => {
    // A 5000 ⚡ flat leg is clamped to BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ before it is
    // charged, so a bound computed from the RAW value would over-grant by 4900.
    expect(blockAuthorFeeUpperBound(83, { default: { flatBuzz: 5000, pctOfBase: 0 } })).toBe(100);
  });

  it('FLOORS the percentage leg the same way the fee does', () => {
    // 83 × 5% = 4.15. A bound that rounded would return 4 here too, so the case
    // that separates floor from round is one whose fraction is above .5:
    // 89 × 5% = 4.45 → 4 either way; 99 × 5% = 4.95 → floor 4, round 5.
    expect(blockAuthorFeeUpperBound(99)).toBe(4);
    expect(feeFor(99)).toBe(4);
  });

  it('agrees with the real fee at every base at or below the budget', () => {
    for (const budget of [3, 37, 83, 149, 613, 997]) {
      const bound = blockAuthorFeeUpperBound(budget);
      for (const base of [1, 2, 19, 20, 21, Math.floor(budget / 2), budget].filter(
        (b) => b >= 1 && b <= budget
      )) {
        expect(feeFor(base), `budget=${budget} base=${base}`).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('returns 0 for a budget that is not a usable positive number', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(blockAuthorFeeUpperBound(bad)).toBe(0);
    }
  });
});

describe('blockPerCallBudget — which ceiling a gate gets, and why it is not the same one', () => {
  /**
   * 🔴 THIS BLOCK EXISTS BECAUSE A MUTATION SWEEP FOUND NOTHING HERE.
   *
   * The pairing ledger below is STRUCTURAL — it counts call sites, it never
   * executes this function — and every router fixture sets `buzzBudget` alone, so
   * declared and granted coincide there and the branch is invisible. Three
   * mutations of this function therefore survived a fully green suite:
   * hardwiring the fee-pricing branch on, hardwiring it off, and dropping the
   * declared fallback. Each one either re-opens the rejection the headroom
   * removes or re-opens the overspend the split removes, and the fixtures below
   * are the only thing that can tell them apart: `buzzBudget` and
   * `buzzBudgetDeclared` are deliberately DIFFERENT numbers, and neither equals
   * the other's value on any path.
   */
  const GRANTED = 210;
  const DECLARED = 200;

  it('a gate that PRICES the fee gets the granted ceiling', async () => {
    const { blockPerCallBudget } = await import('~/server/middleware/block-scope.middleware');
    expect(
      blockPerCallBudget(
        { buzzBudget: GRANTED, buzzBudgetDeclared: DECLARED },
        { pricesAuthorFee: true }
      )
    ).toBe(210);
  });

  it('🔴 a FEE-FREE gate gets the declared ceiling — the allowance is not generation headroom', async () => {
    const { blockPerCallBudget } = await import('~/server/middleware/block-scope.middleware');
    expect(
      blockPerCallBudget(
        { buzzBudget: GRANTED, buzzBudgetDeclared: DECLARED },
        { pricesAuthorFee: false }
      )
    ).toBe(200);
  });

  it('a LEGACY token (granted claim only) answers the same on both branches', async () => {
    // Minted before the grant shipped, so its `buzzBudget` IS the declared
    // ceiling. The fallback is exact, not lenient — both branches must return it.
    const { blockPerCallBudget } = await import('~/server/middleware/block-scope.middleware');
    const legacy = { buzzBudget: 137 };
    expect(blockPerCallBudget(legacy, { pricesAuthorFee: true })).toBe(137);
    expect(blockPerCallBudget(legacy, { pricesAuthorFee: false })).toBe(137);
  });

  it('fails CLOSED at 0 when no budget was minted', async () => {
    const { blockPerCallBudget } = await import('~/server/middleware/block-scope.middleware');
    for (const pricesAuthorFee of [true, false]) {
      expect(blockPerCallBudget({}, { pricesAuthorFee })).toBe(0);
      // A declared claim with no granted claim is not a budget either — the
      // signer only ever stamps the pair, so this shape means "no spend".
      expect(blockPerCallBudget({ buzzBudgetDeclared: 200 }, { pricesAuthorFee })).toBe(0);
    }
  });

  it('a real minted token round-trips into both branches with the right two numbers', async () => {
    // The composed version of the four cases above: no hand-built claims bag,
    // the real signer, the real JWT, the real split.
    const claims = await mintAndDecode(200);
    const { blockPerCallBudget } = await import('~/server/middleware/block-scope.middleware');
    expect(blockPerCallBudget(claims, { pricesAuthorFee: true })).toBe(210);
    expect(blockPerCallBudget(claims, { pricesAuthorFee: false })).toBe(200);
  });
});

describe('SEAM — one signer, and each gate reads the budget claim its own arithmetic earns', () => {
  const SRC = path.resolve(__dirname, '../../../..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      // Production source only. A fixture is free to spell `buzzBudget` any way
      // it likes, and a ledger that fails on someone else's test data is a
      // ledger people delete.
      else if (
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !full.includes(`${path.sep}__tests__${path.sep}`)
      )
        out.push(full);
    }
    return out;
  }

  const sourceFiles = walk(SRC);
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

  it('the walk actually reads the tree (positive control)', () => {
    // Not a round number pulled from nowhere: the tree holds several thousand
    // production modules, so a floor near it catches a walk that reached only
    // ONE top-level directory — which a token floor like 500 would not.
    expect(sourceFiles.length).toBeGreaterThan(3000);
    // And it reached the directories this ledger reasons about, not just the
    // first one it happened to descend into.
    for (const dir of ['server/', 'pages/', 'components/']) {
      expect(sourceFiles.some((f) => rel(f).startsWith(dir))).toBe(true);
    }
  });

  /**
   * 🔴 ANCHORED ON `new SignJWT`, NOT ON A SPELLING OF THE ASSIGNMENT.
   *
   * The grant is applied at `BlockTokenService.sign` because that is the single
   * place a block token is signed. The threat to that property is a SECOND
   * SIGNER, and a second signer would build its own payload — `new SignJWT({ …,
   * buzzBudget })` — an object literal. An earlier version of this ledger matched
   * `/claims\.buzzBudget\s*=/`, which is blind to exactly that: it would have
   * stayed green through the whole scenario it claimed to cover, and also through
   * `claims.buzzBudget += x`, `claims['buzzBudget'] =` and `payload.buzzBudget =`.
   * Matching the constructor is shape-independent.
   *
   * Fails when the set GROWS (a new signer) or SHRINKS (the signer moved and this
   * ledger silently stopped covering anything).
   */
  it('block tokens are signed in exactly one module', () => {
    const signers = sourceFiles
      .filter((f) => /new SignJWT\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();

    expect(signers).toEqual(
      [
        // The block-token signer — the one place the grant is applied.
        'server/services/block-token.service.ts',
        // Unrelated: Coinbase's API auth. Listed so this ledger fails if it
        // disappears too, rather than quietly narrowing to a one-file check.
        'server/coinbase/coinbase-api.ts',
      ].sort()
    );
  });

  /**
   * 🔴 THE PAIRING LEDGER — the finding this whole seam exists for.
   *
   * The granted ceiling is only sound for a gate whose compared value INCLUDES
   * the author fee. A fee-free gate handed the granted ceiling turns the
   * allowance into generation headroom no fee ever consumes, and on the
   * pass-through path the value that clears the gate is the value reserved and
   * BILLED. `blockPerCallBudget` makes each gate state which kind it is; this
   * asserts the two populations still agree with how many gates actually price a
   * fee.
   *
   * It is a RELATIONSHIP, not a component: it fails if a gate is added, removed,
   * or has a fee introduced without its flag being flipped in the same commit.
   */
  it('the fee-pricing gates and the fee-free gates are exactly the two known sets', () => {
    // Line comments stripped first. This file's prose legitimately quotes the
    // gate expressions, and a ledger that a comment can turn red is a ledger
    // someone loosens. (It caught a genuinely stale comment on its first run —
    // that was the right outcome, but it is not what the ledger is FOR.)
    const router = readFileSync(path.join(SRC, 'server/routers/blocks.router.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    const feeQuotes = router.match(/quoteBlockAuthorFee\(\{/g) ?? [];
    const pricing =
      router.match(/blockPerCallBudget\(claims, \{ pricesAuthorFee: true \}\)/g) ?? [];
    const feeFree =
      router.match(/blockPerCallBudget\(claims, \{ pricesAuthorFee: false \}\)/g) ?? [];

    // Two paths quote a fee (txt2img submit, registry step) and two do not
    // (customComfy/recipe, pass-through step). If you added a fee to a path,
    // flip that gate's flag; if you added a gate, add it to these counts.
    expect(feeQuotes.length).toBe(2);
    expect(pricing.length).toBe(2);
    expect(feeFree.length).toBe(2);

    // A gate must not read either budget claim directly — that is how the two
    // populations drift apart without either count above moving.
    expect(router.match(/claims\.buzzBudgetDeclared/g) ?? []).toHaveLength(1); // the getMyViewer read
    const rawReads = router.match(/> claims\.buzzBudget\b/g) ?? [];
    expect(rawReads).toHaveLength(0);
  });
});
