import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ARM B of the private-run money safety — AND THE ONE THAT MOVES REAL BUZZ.
 *
 * ── WHAT IS ACTUALLY AT STAKE ───────────────────────────────────────────────
 * 🔴 UNLIKE ARM A, THIS RAIL IS LIVE AND CHARGING. The per-generation author fee
 * is a submit-time, VIEWER-PAID debit, and the platform takes NO CUT — the author
 * is credited exactly what the viewer was debited. So without this arm, a
 * MODERATOR reviewing a takedown is debited and the SUSPENDED PUBLISHER is
 * credited the same Buzz: a straight transfer from the person reviewing the
 * takedown to the author who was taken down.
 *
 * 🔴 ITS ONLY LIVE CONSUMER IS A MODERATOR RUN, WHICH IS WHY THE ARM IS SHAPED
 * THAT WAY AND TESTED THAT WAY. The app OWNER is already refused by the
 * pre-existing self-dealing exclusion, and an accepted collaborator (editor) is
 * READ-ONLY on the private-run surface by decision — `ai:write:budgeted` is
 * stripped from an editor's clamp, so an editor cannot reach a generation at all.
 * That leaves the moderator as the only third party who can reach this code. The
 * tests below are therefore moderator-shaped, not written as a generic
 * third-party guard.
 *
 * ── LABELS ──────────────────────────────────────────────────────────────────
 * **[REG]** — `resolveBlockAuthorFeePayee`, `quoteBlockAuthorFee` and
 * `chargeBlockAuthorFee` all already existed and already returned a verdict for
 * these inputs. At the base ref a private run is indistinguishable from an
 * ordinary third-party run, so each assertion below fails on the VALUE
 * (`charged: true` where this expects `{ charged: false, reason: 'private-run' }`),
 * and the debit-mock assertions fail because the debit DID happen. Genuine
 * behaviour regression guards.
 *
 * **[INV]** marks the controls and the pre-existing-behaviour pins.
 *
 * ── WHAT IS MOCKED, AND WHAT DELIBERATELY IS NOT ────────────────────────────
 * Mirrors `author-fee-charge.service.test.ts`: the Buzz service, the Flipt flag,
 * Prisma, the logger and the Prom counters are mocked at the module boundary.
 * `accrueBlockAuthorFee` is NOT mocked, on purpose — the expensive defect on this
 * path lives in the SEAM between the charge and the accrual, and a mocked accrual
 * cannot express "the money moved but nobody was owed it".
 *
 * 🔴 A GREEN RUN HERE IS NOT A CLAIM ABOUT A REAL DATABASE. Prisma is a mock; no
 * test in this file has touched `block_author_fee_accrual`.
 */

const { mockLog, mockCreateMany, mockFlag, mockQuoted, mockCharged } = vi.hoisted(() => ({
  mockLog: vi.fn(),
  mockCreateMany: vi.fn(),
  mockFlag: vi.fn(),
  mockQuoted: vi.fn(),
  mockCharged: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: unknown[]) => mockCreateMany(...args),
}));
// ⚠️ A PARTIAL, 2-KEY MOCK OF A MODULE THIS GRAPH IMPORTS FIVE NAMES FROM, AND THE
// CAVEAT IS NOT OPTIONAL — the sibling `author-fee-charge.service.test.ts` carries it
// and the first draft of this file dropped it. Two consequences:
//   1. it cannot see a MISSPELLED LABEL NAME (the real `registerCounterWithLabels`
//      rejects a label outside `labelNames`; these stubs accept anything), so the
//      assertions below pin label VALUES and call COUNTS only;
//   2. `author-fee.ts` also imports `blockAuthorFeeBaseBuzzCounter`,
//      `blockAuthorFeeBuzzCounter` and `blockAuthorFeeObservedCounter`, which are
//      `undefined` here. Unexercised today — but every `inc` in that file is wrapped
//      in `try { … } catch {}`, so if a future revision incs one from a path this
//      suite drives, the TypeError is SWALLOWED: the counter silently stops working
//      and nothing goes red. If that happens, widen this to the `importOriginal`
//      spread (`docs/testing/shared-module-mocks.md`), which is what arm A's suite
//      uses for the Flipt evaluator.
vi.mock('~/server/prom/client', () => ({
  blockAuthorFeeQuotedCounter: { inc: mockQuoted },
  blockAuthorFeeChargedCounter: { inc: mockCharged },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorFeeEnabled: () => mockFlag(),
}));

import { chargeBlockAuthorFee, quoteBlockAuthorFee } from '../author-fee-charge.service';
import { accrueBlockAuthorFee, resolveBlockAuthorFeePayee } from '../author-fee-accrual.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) => {
  mockLog(...args);
  return Promise.resolve(null);
});

/**
 * 🔴 FIXTURE HYGIENE. Every id is pairwise distinct AND distinct from every
 * constant the assertions name — in particular `MODERATOR_ID !== OWNER_ID`, so the
 * private-run arm and the self-dealing arm are separately observable. A fixture
 * where they coincided could not distinguish the two, and a mutant deleting the
 * private-run branch would still refuse and SURVIVE.
 *
 * `BASE_BUZZ = 660` makes the fee unambiguous under the platform config
 * (1 flat / 5% of base): `floor(660 × 500 / 10000) = 33`, so the PERCENTAGE leg
 * governs and 33 equals no id, no flat leg, no basis-point scale and no
 * reservation figure used below. A mutant reaching for a constant cannot land on
 * it, and a mutant that swapped the legs would produce 1 rather than 33.
 *
 * 🔴 THE RESERVATION IS SEPARATE FROM THE FEE, AND AN EARLIER DRAFT GOT THIS WRONG.
 * This header used to claim the fixtures "overshoot any boundary a mutant could sit
 * exactly on", while `reservedAuthorFeeBuzz` was set to `EXPECTED_FEE` itself — both
 * operands of `Math.min(reserved, quote.feeBuzz)` equal, so the clamp branch never
 * executed and a `min → max` mutation was invisible here. A review lane caught it.
 * `RESERVED_BUZZ = 41` is strictly above the fee, so the clamp runs and still
 * resolves to 33.
 */
const APP_ID = 'app_pr_fee';
const APP_BLOCK_ID = 'apb_pr_fee';
const OWNER_ID = 6421;
const MODERATOR_ID = 1907;
const WORKFLOW_ID = 'wf_pr_fee_01';
const BASE_BUZZ = 660;
const EXPECTED_FEE = 33;
/** Strictly ABOVE the fee, so the `min(reserved, fee)` clamp actually runs. See `chargeArgs`. */
const RESERVED_BUZZ = 41;

function resetOnceQueues() {
  mockCreateMany.mockReset();
  mockFlag.mockReset();
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbWrite.blockAuthorFeeAccrual.create.mockReset();
  mockQuoted.mockReset();
  mockCharged.mockReset();
  mockLog.mockReset();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOnceQueues();
  // 🔴 THE FLAG IS ON. That is the production state, read live from Flipt on
  // 2026-09-27: a plain global boolean, base TRUE, no segments and no rollouts.
  // Testing this arm with the flag off would be vacuous — `flag-disabled` short
  // circuits before the payee resolve, so every assertion would pass with the
  // private-run branch deleted.
  mockFlag.mockResolvedValue(true);
  mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
  mockDbWrite.blockAuthorFeeAccrual.create.mockResolvedValue({});
  mockCreateMany.mockImplementation(async (txs: unknown[]) => ({
    transactions: txs.map((_, i) => ({ id: `tx_${i}` })),
    conflicts: [],
  }));
});

function chargeArgs(over: Record<string, unknown> = {}) {
  return {
    workflowId: WORKFLOW_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    viewerUserId: MODERATOR_ID,
    buzzType: 'yellow' as const,
    baseGenerationBuzz: BASE_BUZZ,
    priceIsCap: false,
    generationType: 'textToImage:txt2img',
    // 🔴 DELIBERATELY ABOVE THE FEE, NOT EQUAL TO IT. With `reserved === feeBuzz`
    // the clamp `Math.min(reserved, quote.feeBuzz)` has both operands equal, so the
    // branch never executes and a `min → max` mutation is invisible from this file.
    // A review lane caught that the header's own "overshoots any boundary" claim was
    // false for exactly this fixture. 41 is above 33, is not a multiple of it, and
    // shares no value with any id, the base, the flat leg or the percentage scale.
    reservedAuthorFeeBuzz: RESERVED_BUZZ,
    ...over,
  };
}

function quoteArgs(over: Record<string, unknown> = {}) {
  return {
    baseGenerationBuzz: BASE_BUZZ,
    priceIsCap: false,
    generationType: 'textToImage:txt2img',
    appId: APP_ID,
    viewerUserId: MODERATOR_ID,
    workflowLabel: WORKFLOW_ID,
    ...over,
  };
}

describe('resolveBlockAuthorFeePayee — the ONE spelling of the private-run exclusion', () => {
  it('[REG] refuses a private run with reason private-run', async () => {
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: MODERATOR_ID,
        workflowId: WORKFLOW_ID,
        privateRun: true,
      })
    ).toEqual({ payee: false, reason: 'private-run' });
  });

  it('[REG] refuses BEFORE resolving the owner — the refusal costs no query', async () => {
    // The ordering half, and it is the load-bearing one: this is what makes the
    // arm hold even when the app row is missing or its `app_id` dangles. A copy
    // of the branch placed after the lookup would leave this call behind.
    await resolveBlockAuthorFeePayee({
      appId: APP_ID,
      viewerUserId: MODERATOR_ID,
      workflowId: WORKFLOW_ID,
      privateRun: true,
    });
    expect(mockDbRead.oauthClient.findUnique).not.toHaveBeenCalled();
  });

  it('[REG] the private-run arm WINS over self-dealing when the viewer IS the owner', async () => {
    // Both arms would fire. Pinned so the ordering is a decision rather than an
    // accident, and so this fixture is a second independent kill for the same
    // mutant: delete the branch and the reason becomes `self-dealing`.
    const res = await resolveBlockAuthorFeePayee({
      appId: APP_ID,
      viewerUserId: OWNER_ID,
      workflowId: WORKFLOW_ID,
      privateRun: true,
    });
    expect(res).toEqual({ payee: false, reason: 'private-run' });
  });

  it('[REG] refuses even when the app row is MISSING — the arm does not depend on an owner', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: MODERATOR_ID,
        workflowId: WORKFLOW_ID,
        privateRun: true,
      })
    ).toEqual({ payee: false, reason: 'private-run' });
  });

  it('[INV][POSITIVE CONTROL] an ORDINARY third-party run still resolves a payee', async () => {
    // 🔴 THE CONTROL. A mutant that refuses everything passes every [REG] above
    // and dies only here. Green at base — NOT regression coverage.
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: MODERATOR_ID,
        workflowId: WORKFLOW_ID,
      })
    ).toEqual({ payee: true, appOwnerUserId: OWNER_ID });
  });

  it('[INV] privateRun: false is byte-identical to omitting it', async () => {
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: MODERATOR_ID,
        workflowId: WORKFLOW_ID,
        privateRun: false,
      })
    ).toEqual({ payee: true, appOwnerUserId: OWNER_ID });
  });

  it('[INV] the pre-existing arms are intact — self-dealing and app-missing still fire', async () => {
    // Proves the new branch did not swallow either neighbour, i.e. both remain
    // REACHABLE rather than becoming dead code behind the new guard.
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: OWNER_ID,
        workflowId: WORKFLOW_ID,
      })
    ).toEqual({ payee: false, reason: 'self-dealing' });

    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    expect(
      await resolveBlockAuthorFeePayee({
        appId: APP_ID,
        viewerUserId: MODERATOR_ID,
        workflowId: WORKFLOW_ID,
      })
    ).toEqual({ payee: false, reason: 'app-missing' });
  });

  it('[INV] a private run is NOT logged — the mint audit line already carries it', async () => {
    // The two neighbouring arms log because their rate is a signal about real
    // traffic. A private run is an operator action the mint's own audit line
    // records with its audience, slug and user, so a line here would be duplicate
    // volume carrying strictly less.
    await resolveBlockAuthorFeePayee({
      appId: APP_ID,
      viewerUserId: MODERATOR_ID,
      workflowId: WORKFLOW_ID,
      privateRun: true,
    });
    expect(mockLog).not.toHaveBeenCalled();
  });
});

describe('quoteBlockAuthorFee — the estimate agrees with the submit', () => {
  it('[REG] refuses a private run at quote time, so no fee is ever RESERVED for it', async () => {
    expect(await quoteBlockAuthorFee(quoteArgs({ privateRun: true }))).toEqual({
      charge: false,
      reason: 'private-run',
    });
  });

  it('[REG] a moderator is never SHOWN a fee that will not be taken', async () => {
    // 🔴 THE ANTI-DIVERGENCE PIN. If only the charge refused, every estimate would
    // quote a fee the submit then declines — re-creating exactly the
    // estimate/submit divergence the disclosure callers exist to remove. Routing
    // the arm through the shared payee predicate makes both surfaces agree by
    // construction; this pins that they do.
    const estimate = await quoteBlockAuthorFee(
      quoteArgs({ privateRun: true, workflowLabel: 'estimate', suppressQuoteLogs: true })
    );
    const submit = await quoteBlockAuthorFee(quoteArgs({ privateRun: true }));
    expect(estimate).toEqual({ charge: false, reason: 'private-run' });
    expect(submit).toEqual(estimate);
  });

  it('[INV][POSITIVE CONTROL] an ordinary quote still prices the fee off the BASE', async () => {
    // Proves the quote path can still return `charge: true` at all, and that the
    // fixture's fee is the computed 33 rather than a constant.
    expect(await quoteBlockAuthorFee(quoteArgs())).toEqual({
      charge: true,
      feeBuzz: EXPECTED_FEE,
      appOwnerUserId: OWNER_ID,
      computation: expect.objectContaining({
        feeBuzz: EXPECTED_FEE,
        baseGenerationBuzz: BASE_BUZZ,
      }),
    });
  });
});

describe('chargeBlockAuthorFee — refused BEFORE the debit', () => {
  it('[REG] a MODERATOR private run charges nothing and moves no Buzz', async () => {
    const result = await chargeBlockAuthorFee(chargeArgs({ privateRun: true }));

    expect(result).toEqual({ charged: false, reason: 'private-run' });
    // 🔴 THE TWO ASSERTIONS THAT ACTUALLY MEAN "NO MONEY MOVED". A `reason` alone
    // would be satisfied by a path that debited and then reported a refusal —
    // which is precisely the defect the self-dealing arm was written to close.
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('[REG] refused even when the viewer IS the owner — the arm order holds end to end', async () => {
    const result = await chargeBlockAuthorFee(
      chargeArgs({ viewerUserId: OWNER_ID, privateRun: true })
    );
    expect(result).toEqual({ charged: false, reason: 'private-run' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('[REG] a generous reservation cannot buy a private run a charge', async () => {
    // The reservation is the structural bound checked FIRST, so a fixture that
    // reserved plenty proves the refusal is not merely `not-reserved` wearing a
    // different name. 500 shares no value with the fee, the base, or any id.
    const result = await chargeBlockAuthorFee(
      chargeArgs({ privateRun: true, reservedAuthorFeeBuzz: 500 })
    );
    expect(result).toEqual({ charged: false, reason: 'private-run' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it('[REG] the outcome is COUNTED as private-run, so the skip is a number not an absence', async () => {
    await chargeBlockAuthorFee(chargeArgs({ privateRun: true }));
    expect(mockCharged).toHaveBeenCalledTimes(1);
    expect(mockCharged.mock.calls[0][0]).toEqual(
      expect.objectContaining({ outcome: 'private-run' })
    );
  });

  it('[INV][POSITIVE CONTROL] an ordinary third-party run STILL DEBITS', async () => {
    // 🔴 WITHOUT THIS THE WHOLE FILE IS COMPATIBLE WITH A DEAD FEE RAIL. A mutant
    // that refuses every charge, or a harness wired to nothing, passes every [REG]
    // above and dies only here. It also proves the debit mock is reachable, so
    // `not.toHaveBeenCalled()` above is a real observation rather than a mock that
    // was never going to fire.
    const result = await chargeBlockAuthorFee(chargeArgs());
    expect(result).toEqual({
      charged: true,
      feeBuzz: EXPECTED_FEE,
      accrualId: expect.any(String),
    });
    // 🔴 EXACTLY ONCE, not merely "called". This is the file's only assertion that
    // the debit happened at all, and a bare `toHaveBeenCalled()` is satisfied by a
    // DOUBLED debit — i.e. double-charging the viewer — which on this rail is the
    // worse failure than not charging. The accrual beside it was already counted.
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.blockAuthorFeeAccrual.create).toHaveBeenCalledTimes(1);
  });

  it('[INV] the pre-existing self-dealing refusal is unchanged for an ordinary run', async () => {
    const result = await chargeBlockAuthorFee(chargeArgs({ viewerUserId: OWNER_ID }));
    expect(result).toEqual({ charged: false, reason: 'self-dealing' });
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});

describe('accrueBlockAuthorFee — the write-side belt', () => {
  it('[REG] a direct accrual caller cannot write a private-run row', async () => {
    // 🔴 WHY THIS EXISTS. `accrueBlockAuthorFee` is EXPORTED and its contract is
    // "record that a debit happened". Putting the arm only in the quote would
    // leave any OTHER caller of this function able to write a private-run accrual
    // — defence in depth against a CALLER, exactly the argument the file already
    // makes for keeping the self-dealing check on this side too.
    const res = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: MODERATOR_ID,
      buzzType: 'yellow',
      computation: {
        feeBuzz: EXPECTED_FEE,
        baseGenerationBuzz: BASE_BUZZ,
        flatLegBuzz: 1,
        pctLegBuzz: EXPECTED_FEE,
        governingLeg: 'pct',
      } as never,
      generationType: 'textToImage:txt2img',
      privateRun: true,
    });

    expect(res).toEqual({ accrued: false, reason: 'private-run' });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).not.toHaveBeenCalled();
  });

  it('[INV][POSITIVE CONTROL] the same call WITHOUT privateRun does write a row', async () => {
    const res = await accrueBlockAuthorFee({
      workflowId: WORKFLOW_ID,
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      viewerUserId: MODERATOR_ID,
      buzzType: 'yellow',
      computation: {
        feeBuzz: EXPECTED_FEE,
        baseGenerationBuzz: BASE_BUZZ,
        flatLegBuzz: 1,
        pctLegBuzz: EXPECTED_FEE,
        governingLeg: 'pct',
      } as never,
      generationType: 'textToImage:txt2img',
    });

    expect(res).toEqual({ accrued: true, id: expect.any(String), feeBuzz: EXPECTED_FEE });
    expect(mockDbWrite.blockAuthorFeeAccrual.create).toHaveBeenCalledTimes(1);
  });
});
