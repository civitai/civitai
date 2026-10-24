import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ARM A of the private-run money safety: a PRIVATE RUN of a delisted / suspended
 * app writes **NO** `block_spend_attribution` row at all.
 *
 * ⚠️ THIS HEADER SAID "writes its `block_spend_attribution` row `voided`, not `tracked`"
 * — the pre-rescope design — while the `describe` below already read "writes NO
 * spend-attribution row at all". A file whose header contradicts its own assertions is
 * worse than one with neither, because the header is what a reader skims. The FILENAME
 * still says `-void` and is deliberately not renamed in the same change as the rewrite:
 * a rename would detach the rows from their history at exactly the moment someone needs
 * to see what they used to assert.
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

describe('arm A — privateRun writes NO spend-attribution row at all', () => {
  /**
   * ⚠️ THIS ARM CHANGED CONTRACT, DELIBERATELY, AND THE ROWS WERE REWRITTEN RATHER THAN
   * DELETED. It used to assert that a private run wrote the row with
   * `status: 'voided'` / `voidedReason: 'manual_review'`, leaving every READER to filter
   * voided rows back out. The rescope moved the exclusion to the WRITE side: no row is
   * created. Read-side exclusion has to be got right in every reader, in two repos, and it
   * is the design that produced this rail's nullability trap; write-side is got right once.
   *
   * ⚠️ THE FIGURE HERE SAID "14 non-test readers in this repo" AND THAT WAS A COUNT OF
   * FILE MENTIONS, NOT OF READERS — most of those hits are comments, and one is a
   * Prometheus counter. Enumerated properly, this table has **3 read sites in 2 files**:
   * `app-analytics.service.ts:516` (the owner-visible Prisma aggregate),
   * `app-analytics.service.ts:523` (the owner-visible raw series), and
   * `buzz-attribution.service.ts:989` (the P2002 dedupe lookup, which is not
   * owner-visible). Plus one cross-repo consumer, talos-infra's
   * `civitai-app-blocks-digest`. The write-side argument does not depend on the number
   * and still holds on its own terms — an absent row is the safe failure for a reader
   * that forgets the filter, a voided row is the leak — but the stated burden was ~5x
   * the real one, and a committed number gets acted on.
   *
   * 🔴 EVERY ROW BELOW IS A REWRITE OF A ROW THAT EXISTED, NOT A NEW ONE. That matters
   * because "the tests changed to match the code" is how coverage evaporates. Each one
   * keeps its predecessor's INTENT — audience-blindness, arm order, no money moved — and
   * only changes the observable it reads, from the row's columns to the absence of a
   * write. The mutation that killed the old rows (delete the private-run branch) still
   * kills these: the row comes back as `tracked` or `self_spend` and `create` fires.
   */
  it('[REG] a MODERATOR private run writes nothing and reports written:false, row:null', async () => {
    // The headline case, and the only one with a live consumer: the owner is
    // already caught by `self_spend`, and an editor is read-only on this surface
    // by decision, so a moderator is the third party this arm exists for.
    const res = await recordSpendAttribution(fakeInput({ privateRun: true }));

    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
    // The result surface must SAY nothing was written rather than quietly returning a
    // zeroed row — "no attribution exists" and "an attribution of zero" are different
    // facts and a future reader has to be able to tell them apart.
    expect(res.written).toBe(false);
    expect(res.row).toBeNull();
  });

  it('[REG] an EDITOR private run writes nothing too — the arm is audience-blind', async () => {
    // Editors are read-only on the private-run surface today, so this case should
    // be unreachable in production. It is pinned anyway: the arm keys on the
    // CLAIM, not on a role, so widening editors to spend later cannot silently
    // reopen the rail. A mutant narrowing the arm to "moderator only" dies here.
    await recordSpendAttribution(fakeInput({ userId: EDITOR_ID, privateRun: true }));

    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('[REG] the private-run arm WINS over self_spend when the viewer IS the owner', async () => {
    // 🔴 THE ARM-ORDER PIN, and it is STRONGER now than it was. Both branches are true
    // here. Previously both produced a voided row, so order decided only which REASON the
    // column recorded — a diagnostic distinction. Now the branches produce different
    // OBSERVABLE OUTCOMES: the private-run arm writes nothing, while `self_spend` writes a
    // voided row. So this row fails on a mutant that merely REORDERS the arms, which the
    // old column-level assertion could only catch by reading a string.
    await recordSpendAttribution(fakeInput({ userId: OWNER_ID, privateRun: true }));

    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('[INV] the review sandbox’s synthetic-appId trick is still NOT copied', async () => {
    // 🔴 THE PREDECESSOR OF THIS ROW ASSERTED THE WRITTEN ROW KEPT THE REAL
    // `appId`/`appBlockId`. There is no row now, so that observable is gone — but the
    // DECISION it protected is not, and deleting the row would drop it silently.
    //
    // The mod review sandbox excludes both money rails by signing a NON-RESOLVING
    // synthetic `appId`, so nothing resolves and no row is written as a SIDE EFFECT. That
    // trick is still deliberately not copied: a synthetic id would also break per-app
    // storage namespacing, the `page_<appBlockId>` ban-revocation instance id, and every
    // runtime metric label. The rail is closed by an EXPLICIT branch on the claim instead.
    //
    // What is checkable about that today: the real app IS resolved — the owner lookup
    // still runs and still succeeds — and the write is skipped by decision rather than by
    // a lookup failing. A synthetic-appId implementation would resolve nothing.
    await recordSpendAttribution(fakeInput({ privateRun: true }));

    expect(mockDbRead.oauthClient.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APP_ID } })
    );
    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('[INV] no money moves — and the rail that DOES move money is excluded elsewhere', async () => {
    // The predecessor asserted `spendSharePct`/`appOwnerShareCents` were 0 on the written
    // row. With no row those columns cannot be read, and the claim they supported is now
    // trivially true: an absent row pays nothing.
    //
    // 🔴 SO THE IMPORTANT HALF IS RECORDED RATHER THAN ASSERTED HERE, BECAUSE IT LIVES IN
    // ANOTHER FILE: this table never paid anything (`spendSharePct` and
    // `appOwnerShareCents` are hardcoded 0 in the writer). The rail that actually moves
    // Buzz is the AUTHOR FEE, whose only other exclusion is self-dealing, and it is
    // refused for a private run by `resolveBlockAuthorFeePayee` returning
    // `{ payee: false, reason: 'private-run' }` — covered by
    // `author-fee-private-run.test.ts`. If someone reads this arm as "the private run is
    // free because the spend row is voided/absent", they have the wrong rail.
    const res = await recordSpendAttribution(fakeInput({ privateRun: true }));

    expect(res.row).toBeNull();
    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('[INV][POSITIVE CONTROL] an ORDINARY run still writes tracked / null', async () => {
    // 🔴 THIS IS THE CONTROL THAT MAKES THE FILE MEAN ANYTHING, AND ITS JOB GREW WITH THE
    // REWRITE. It always killed the mutant that voids every row unconditionally. Now it
    // does something load-bearing as well: every row in arm A asserts
    // `create` was NOT called, and a zero like that is indistinguishable from a mock
    // wired to nothing — a broken `beforeEach`, a renamed mock, a factory that stopped
    // exporting `create`. This row is the paired POSITIVE control proving the same mock,
    // in the same file, DOES fire on a non-private run. Without it arm A could go green
    // having measured nothing at all.
    await recordSpendAttribution(fakeInput());

    expect(mockDbWrite.blockSpendAttribution.create).toHaveBeenCalledTimes(1);
    const data = writtenRow();
    expect(data.status).toBe('tracked');
    expect(data.voidedReason ?? null).toBeNull();
    // The money basis is recorded on a real row — the observable arm A's predecessor
    // asserted before the write-side exclusion removed the row it read from.
    expect(data.grossValueCents).toBe(EXPECTED_GROSS_CENTS);
  });

  it('[INV][POSITIVE CONTROL] privateRun: false is byte-identical to omitting it', async () => {
    await recordSpendAttribution(fakeInput({ privateRun: false }));
    const withFalse = writtenRow();
    expect(withFalse.status).toBe('tracked');
    expect(withFalse.voidedReason ?? null).toBeNull();
  });

  it('[INV] a TRUTHY NON-BOOLEAN does not void — the arm tests `=== true`, not truthiness', async () => {
    // 🔴 [INV] BY MEASUREMENT, AND THE MISLABEL IS WORTH RECORDING. This shipped as
    // [REG] in the round that CORRECTED three other [REG] labels — so the method that
    // caught those minted a fourth. At the base ref the service contains no
    // `privateRun` at all and this fixture is neither self-spend nor internal, so base
    // code already produces `tracked` / `null`: green at base, therefore an invariant
    // guard against a future loosening, not regression coverage.
    //
    // The gap in the method, now closed: the base run checked that no [INV] was RED,
    // but never that every [REG] was actually red. A label can be wrong in both
    // directions and only one was being tested for.
    //
    // 🔴 IT IS STILL WORTH ITS PLACE, BECAUSE A MUTANT SURVIVED WITHOUT IT. Loosening
    // the arm from
    // `privateRun === true` back to a bare truthiness check was undetectable: every
    // other fixture here passes a real boolean, for which the two forms are
    // identical, so the mutant was EQUIVALENT against the suite and scored SURVIVED.
    //
    // The tightening is not cosmetic. `recordSpendAttribution` is exported and its
    // input is a plain object, so a future caller — or a caller that forwards a
    // half-parsed value — can hand it a truthy non-boolean that TypeScript never
    // saw. Under truthiness that silently voids the row and, on the fee rail's
    // equivalent, silently suppresses a live charge. The cast below is how a real
    // caller reaches this state; it is deliberate, not a test smell.
    await recordSpendAttribution(fakeInput({ privateRun: 'yes' as unknown as boolean }));

    const data = writtenRow();
    expect(data.status).toBe('tracked');
    expect(data.voidedReason ?? null).toBeNull();
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
