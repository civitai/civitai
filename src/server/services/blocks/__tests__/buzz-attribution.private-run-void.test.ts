import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ARM A of the private-run money safety: a PRIVATE RUN of a delisted / suspended
 * app writes its `block_spend_attribution` row `voided`, not `tracked`.
 *
 * ── WHY THIS MATTERS, AND WHAT IT IS *NOT* ──────────────────────────────────
 * 🔴 NO BUZZ MOVES ON THIS RAIL EITHER WAY. `recordSpendAttribution` hardcodes
 * `spendSharePct = 0`, `appOwnerShareCents = 0` and `rateCardVersion = 'unrated'`
 * at write time, and nothing pays out of this table (`backpay.service.ts` reads
 * only the SUBSCRIPTION table and says so). So this arm is NOT protecting money —
 * the money arm is arm B, the author fee.
 *
 * What it protects is the RUN COUNT and the BUZZ SUM a suspended app's owner can
 * see. `app-analytics.service.ts` aggregates this table, so without this arm a
 * moderator's takedown review would show up in the suspended publisher's own
 * analytics as engagement — which both pollutes the numbers and tells a bad actor
 * exactly when review is happening.
 *
 * ── LABELS, ASSIGNED BY MEASUREMENT RATHER THAN BY INTENT ───────────────────
 * 🔴 EVERY LABEL BELOW WAS SET BY RUNNING THIS FILE AGAINST THE BASE REF, NOT BY
 * DECIDING WHAT IT OUGHT TO BE. Two cases were written as [REG] and demoted after
 * that run showed them GREEN at base; the demotion notes are on the tests. Reading
 * the label as a claim about what was verified is the point of having it.
 *
 * **[REG]** — three cases: the moderator void, the editor void, and the arm-order
 * pin. These are red at base for a REASON, not merely because a file is new:
 * `recordSpendAttribution` already existed and already computed `voidedReason`, so
 * at base these inputs produce `status: 'tracked'` / `voidedReason: null` (or
 * `self_spend`) and the assertions fail on the VALUE.
 *
 * **[INV]** — the rest. Some are POSITIVE CONTROLS without which a mutant that
 * voided every row unconditionally would pass this file; some pin pre-existing
 * behaviour the change must not disturb (an ordinary run still tracks, an ordinary
 * owner run is still `self_spend`, the real ids still land on the row, the share
 * columns stay 0). NONE of them is regression coverage and none is counted as
 * such.
 *
 * ── WHAT IS MOCKED ──────────────────────────────────────────────────────────
 * Prisma and the logger come from the CANONICAL shared mocks (`dbMock`,
 * `loggingMock`); the app-shared datastore and the Flipt evaluator are mocked
 * locally, because neither has a canonical mock. See the note above the local
 * mocks for why this file does NOT copy the hand-rolled client used by
 * `spend-attribution.service.test.ts` next door.
 *
 * 🔴 A GREEN RUN HERE IS NOT A CLAIM THAT ANYTHING WORKS AGAINST A REAL DATABASE.
 * No test in this file has ever touched `block_spend_attribution`.
 */

/**
 * 🔴 PRISMA AND THE LOGGER COME FROM THE CANONICAL SHARED MOCKS, NOT A LOCAL
 * `vi.mock`. `no-direct-shared-module-mock` enforces that, and it caught the first
 * draft of this file — which had copied the hand-rolled hoisted client out of
 * `spend-attribution.service.test.ts` next door. That file predates the ratchet and
 * is allowlisted; a NEW file is not, and the codemod's fix is the right one anyway:
 * the canonical `dbRead`/`dbWrite` are DISTINCT objects, so a `dbWrite` call cannot
 * satisfy a `dbRead` assertion the way an aliased hand mock allows.
 *
 * `appsDb` and the Flipt evaluator have no canonical mock, so they stay local.
 */
const { mockAppsQuery, mockRequireAppsDb } = vi.hoisted(() => ({
  mockAppsQuery: vi.fn(),
  mockRequireAppsDb: vi.fn(),
}));

vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: (...args: unknown[]) => mockRequireAppsDb(...args),
}));
// Only the EVALUATOR is controlled — the rest of `app-blocks-flag` stays real, so
// the gate's own wiring is not mocked away (`no-wholesale-module-mock`).
const mockIsFlipt = vi.hoisted(() => vi.fn());
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isFlipt: (...args: unknown[]) => mockIsFlipt(...args) };
});

import {
  recordSpendAttribution,
  type RecordSpendAttributionInput,
} from '../buzz-attribution.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockLog = vi.fn();
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) => {
  mockLog(...args);
  return Promise.resolve(null);
});

/**
 * 🔴 FIXTURE HYGIENE — EVERY ID IS PAIRWISE DISTINCT, AND DISTINCT FROM EVERY
 * CONSTANT THE ASSERTIONS NAME. The point is discriminability between the arms:
 * a fixture whose spender id equalled its owner id could not tell the private-run
 * arm apart from the self-spend arm, so a mutant deleting the private-run branch
 * would still produce a voided row and SURVIVE a green suite.
 *
 * `BUZZ_AMOUNT` is deliberately not a round multiple of the 1000:1 Buzz→USD ratio
 * and shares no value with any id, so a mutant reaching for a constant cannot land
 * on the expected gross.
 */
const APP_ID = 'app_private_run';
const APP_BLOCK_ID = 'apb_private_run';
const OWNER_ID = 4113;
const MODERATOR_ID = 8627;
const EDITOR_ID = 5209;
const WORKFLOW_ID = 'wf_private_run_01';
const BLOCK_INSTANCE_ID = 'page_apb_private_run';
const BUZZ_AMOUNT = 3170;
const EXPECTED_GROSS_CENTS = 317;

function fakeInput(over: Partial<RecordSpendAttributionInput> = {}): RecordSpendAttributionInput {
  return {
    userId: MODERATOR_ID,
    buzzAmount: BUZZ_AMOUNT,
    workflowId: WORKFLOW_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: BLOCK_INSTANCE_ID,
    modelId: null,
    ...over,
  };
}

function createEchoesData() {
  mockDbWrite.blockSpendAttribution.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: data.id,
      status: data.status,
      appOwnerShareCents: data.appOwnerShareCents,
      spendSharePct: data.spendSharePct,
      grossValueCents: data.grossValueCents,
      rateCardVersion: data.rateCardVersion,
      voidedReason: data.voidedReason ?? null,
    })
  );
}

/** The `data` object the service handed Prisma for the single write it performed. */
function writtenRow(): Record<string, unknown> {
  expect(mockDbWrite.blockSpendAttribution.create).toHaveBeenCalledTimes(1);
  return mockDbWrite.blockSpendAttribution.create.mock.calls[0][0].data;
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockSpendAttribution.findUnique.mockReset();
  mockDbRead.appBlock.findUnique.mockReset();
  mockDbWrite.blockSpendAttribution.create.mockReset();
  mockLog.mockReset();
  mockAppsQuery.mockReset();
  mockRequireAppsDb.mockReset();
  mockIsFlipt.mockReset();
  mockIsFlipt.mockResolvedValue(false);
  mockDbRead.oauthClient.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER_ID });
  mockDbRead.appBlock.findUnique.mockResolvedValue({ blockId: 'blk_private_run' });
  mockRequireAppsDb.mockReturnValue({ query: mockAppsQuery });
  mockAppsQuery.mockResolvedValue({ rows: [] });
  createEchoesData();
});

describe('arm A — privateRun voids the spend-attribution row', () => {
  it('[REG] a MODERATOR private run is voided with reason manual_review, not tracked', async () => {
    // The headline case, and the only one with a live consumer: the owner is
    // already caught by `self_spend`, and an editor is read-only on this surface
    // by decision, so a moderator is the third party this arm exists for.
    const res = await recordSpendAttribution(fakeInput({ privateRun: true }));

    const data = writtenRow();
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('manual_review');
    expect(data.voidedAt).toBeInstanceOf(Date);
    // The result surface agrees with the row — a caller reading the return value
    // must see the same verdict the column carries.
    expect(res.row.status).toBe('voided');
    expect(res.row.voidedReason).toBe('manual_review');
  });

  it('[REG] an EDITOR private run is voided too — the arm is audience-blind', async () => {
    // Editors are read-only on the private-run surface today, so this case should
    // be unreachable in production. It is pinned anyway: the arm keys on the
    // CLAIM, not on a role, so widening editors to spend later cannot silently
    // reopen the rail. A mutant narrowing the arm to "moderator only" dies here.
    await recordSpendAttribution(fakeInput({ userId: EDITOR_ID, privateRun: true }));

    const data = writtenRow();
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('manual_review');
  });

  it('[REG] the private-run arm WINS over self_spend when the viewer IS the owner', async () => {
    // 🔴 THE ARM-ORDER PIN. Both branches are true here. Every arm produces the
    // same MONEY outcome (voided; the share columns are already 0), so ordering
    // cannot change what anyone is paid — what it decides is whether the row
    // records WHY it exists (a diagnostic run) or merely who spent.
    //
    // This case is also the second, independent kill for the same mutant: delete
    // the private-run branch and this row reads `self_spend` instead.
    await recordSpendAttribution(fakeInput({ userId: OWNER_ID, privateRun: true }));

    const data = writtenRow();
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('manual_review');
    expect(data.voidedReason).not.toBe('self_spend');
  });

  it('[INV] the row keeps the REAL appId / appBlockId — the deliberate divergence from the review sandbox', async () => {
    // 🔴 LABELLED [INV] AFTER MEASUREMENT, NOT BEFORE. This was written as [REG]
    // and the base-ref run proved otherwise: the row already carried the real ids at
    // the base ref, because the arm changes only `status`/`voidedReason`. So it pins
    // something the bug never violated and is NOT regression coverage — it is here to
    // stop a future 'fix' reaching for the review sandbox's synthetic-appId trick.
    // The mod review sandbox excludes both money rails by signing a NON-RESOLVING
    // synthetic `appId`, so no row is written at all. That trick is deliberately
    // NOT copied here: a synthetic id would also break per-app storage
    // namespacing, the `page_<appBlockId>` ban-revocation instance id, and every
    // runtime metric label. The real ids are kept and the rail is closed
    // explicitly instead — so assert the ids actually survived.
    await recordSpendAttribution(fakeInput({ privateRun: true }));

    const data = writtenRow();
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.appOwnerUserId).toBe(OWNER_ID);
    expect(data.userId).toBe(MODERATOR_ID);
    // The money basis is still recorded — voiding is not skipping.
    expect(data.grossValueCents).toBe(EXPECTED_GROSS_CENTS);
  });

  it('[INV] voiding moves no money — the share columns stay 0 on a private-run row', async () => {
    // Also [INV] by measurement: these columns are hardcoded 0 at the base ref too.
    // Kept because it is the assertion that makes the whole 'arm A moves no money'
    // claim checkable rather than asserted in prose.
    // Pinned so a future reader cannot mistake this arm for a payout change. If
    // these ever become non-zero, voiding a row starts to MEAN something
    // financially and this arm's reasoning has to be revisited.
    await recordSpendAttribution(fakeInput({ privateRun: true }));

    const data = writtenRow();
    expect(data.spendSharePct).toBe(0);
    expect(data.appOwnerShareCents).toBe(0);
  });

  it('[INV][POSITIVE CONTROL] an ORDINARY run still writes tracked / null', async () => {
    // 🔴 THIS IS THE CONTROL THAT MAKES THE FILE MEAN ANYTHING. A mutant that
    // voids every row unconditionally passes every [REG] above and dies only
    // here. Green at base by construction — NOT regression coverage.
    await recordSpendAttribution(fakeInput());

    const data = writtenRow();
    expect(data.status).toBe('tracked');
    expect(data.voidedReason ?? null).toBeNull();
  });

  it('[INV][POSITIVE CONTROL] privateRun: false is byte-identical to omitting it', async () => {
    await recordSpendAttribution(fakeInput({ privateRun: false }));
    const withFalse = writtenRow();
    expect(withFalse.status).toBe('tracked');
    expect(withFalse.voidedReason ?? null).toBeNull();
  });

  it('[INV] an ordinary OWNER run is still self_spend — the pre-existing arm is untouched', async () => {
    // Proves the private-run branch did not swallow the self-spend branch. With
    // the branches reordered but both present this stays green; it goes red only
    // if the self-spend arm is damaged.
    await recordSpendAttribution(fakeInput({ userId: OWNER_ID }));

    const data = writtenRow();
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('self_spend');
  });
});
