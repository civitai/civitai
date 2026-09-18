import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { newBlockAuthorFeeAccrualId } from '~/server/utils/app-block-ids';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import type { BlockAuthorFeeComputation } from './author-fee';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — slice 2, the settlement rail.
//
// SLICE 1 (#4922) computed the fee and threw it away. This slice persists it and
// pays it. It is the first slice that moves money, so the invariants are stated
// here rather than left to the reader.
//
// ── TWO HOPS, MIRRORING THE MODEL LICENSING FEE ────────────────────────────
//   1. AT SUBMIT the viewer is debited the fee, and one `accrued` row is written
//      naming the app owner it is owed to. That debit is the CALLER's job — this
//      module only records it.
//      🔴 THAT CALLER DOES NOT EXIST YET. Slice 2b adds it; nothing in this repo
//      calls `accrueBlockAuthorFee` today. An earlier revision of this comment
//      named `chargeBlockAuthorFee` "in the router" as though it were there. It
//      never was — the name appeared nowhere but in that sentence.
//   2. DAILY the accrued rows are summed per (owner × buzz type) and minted to
//      the owner in one transaction per bucket.
//
// This is exactly what `deliver-creator-compensation` does for the model
// licensing fee: the orchestrator charges the viewer at generation time, writes
// a per-resource fee row, and a daily job mints to the creator. Same two hops,
// same `externalTransactionId` dedup discipline, in a civitai-owned table
// because a licensing fee is keyed on a `modelVersionId` and an app fee has no
// model version.
//
// 🔴 THE PLATFORM IS A CONDUIT, NOT A PARTY. D1: the platform takes NO cut and
// funds NOTHING. So the author is credited EXACTLY what the viewer was debited —
// `feeBuzz` on the row is one number used on both sides. Any change that makes
// the credited total differ from the debited total is a change to that decision,
// not an implementation detail, and belongs in front of the operator.
//
// 🔴 NO FRACTIONAL ACCRUAL, AND THAT IS A DELIBERATE REVERSAL. The design
// inherited "fractional accrual, daily sum-then-floor" from the licensing rail.
// It does not transfer. The licensing fee is fractional because it is priced
// per-IMAGE at 0.01 ⚡ and the viewer pays the CEILING of the sum, so the
// creator's share genuinely has sub-buzz resolution. This fee is
// `max(flatBuzz, pct × base)` FLOORED TO WHOLE BUZZ before the viewer is shown
// or charged it — D7 requires the viewer see the exact number before the run,
// and Buzz cannot express a fraction. There is no sub-buzz residue to carry.
// The daily batch therefore exists for LEDGER VOLUME (one mint per author per
// day instead of one per generation), not for rounding. (An earlier revision
// carried a defensive `Math.floor` here and a sentence explaining it; the floor
// was removed and the sentence outlived it by one commit. `fee_buzz` is an
// INTEGER column, so there is nothing to round.)
//
// ⚠️ THE CONSEQUENCE IS REAL AND SLICE 3 MUST SURFACE IT: an author who sets a 0
// flat leg and a low percentage earns NOTHING on cheap generations, forever —
// `floor(4 × 500/10000) = 0`, every time. That is the same shape as the $0.00
// spend bounty this whole arc replaced. The difference is that it is now the
// AUTHOR'S explicit choice and the platform default (flat 1 ⚡) avoids it.
// ─────────────────────────────────────────────────────────────────────────────

// ── THE `D<n>` LABELS USED BELOW, STATED SO THEY RESOLVE HERE ──────────────
// They index an internal decision memo that is NOT in this repository, so a bare
// `D6` is authority with no referent for anyone reading this file. Each is
// therefore stated in full at least once:
//
//   D1  The fee is additive, author-set and viewer-paid. The platform takes NO
//       cut and funds NOTHING — so the author is credited exactly the amount the
//       viewer was debited.
//   D6  A viewer spending blue Buzz pays the fee in blue, and the author receives
//       blue (non-withdrawable). Currency is carried end to end, never coerced.
//   D7  The resolved fee must be shown to the viewer BEFORE the run. That is what
//       forces the fee to be a whole number the viewer can be quoted, which is
//       why the accrual amount is an integer rather than a fraction.
//
// ⚠️ `D8` and `D10` appear in this PR's description but implement nothing here —
// D8 is a process decision (build in three audited slices) and D10 records that
// the percent leg prices off `base` only, which slice 1 already did and which
// needed no code change. Do not go looking for them in this file.

export const BLOCK_AUTHOR_FEE_LOG_NAME = 'block-author-fee' as const;

/**
 * Lifecycle of one accrual row.
 *
 * ⚠️ USED, not decorative — every status literal written or compared below is
 * annotated with this type. An earlier revision exported this and then wrote
 * bare string literals everywhere, so it was not referenced even inside this
 * file and a typo'd `'setled'` would have compiled and silently matched nothing.
 *
 * 🔴 THERE IS NO `clawed_back` STATE AND NO `entry_type` AXIS. Round 0 retired
 * the clawback: it had zero production callers, and its negative carry-forward
 * arm could not be reached until something had settled — two PRs away. The
 * reversal of a charge cannot be needed before the charge exists. Slice 2b adds
 * both together, when the refund path that drives it is real.
 */
export type BlockAuthorFeeAccrualStatus = 'accrued' | 'settled';

const STATUS_ACCRUED: BlockAuthorFeeAccrualStatus = 'accrued';
const STATUS_SETTLED: BlockAuthorFeeAccrualStatus = 'settled';

export type AccrueBlockAuthorFeeInput = {
  /** Orchestrator workflow id — the idempotency anchor. */
  workflowId: string;
  appId: string;
  appBlockId: string;
  /** The viewer who was debited. */
  viewerUserId: number;
  /** 🔴 D6 — the account the viewer paid from IS the account the author is paid in. */
  buzzType: BuzzAccountType;
  /** The slice-1 computation that produced the charge. */
  computation: BlockAuthorFeeComputation;
  /** The resolved generation type, or null when it could not be established. */
  generationType: string | null;
};

export type AccrueBlockAuthorFeeResult =
  | { accrued: true; id: string; feeBuzz: number }
  | { accrued: false; reason: 'zero-fee' | 'self-dealing' | 'app-missing' | 'duplicate' | 'error' };

/**
 * Record that a viewer has been debited an author fee, and that the app owner is
 * owed it.
 *
 * 🔴 CALL THIS ONLY AFTER THE VIEWER'S DEBIT HAS SUCCEEDED. The row asserts that
 * money was taken; writing it before the debit would make the platform owe an
 * author money it never collected, and the platform funds nothing.
 *
 * 🔴 AWAITED, NOT FIRE-AND-FORGET — unlike `recordSpendAttribution`, which is
 * telemetry off an already-billed submit and may be dropped. A viewer who has
 * been debited and whose accrual did not land is a real loss to a real author,
 * so the caller must know. It still does not THROW (see the catch): the decision
 * of what to do about a failed accrual — refund the viewer, or alert — belongs
 * to the charge path that holds the debit, not here.
 */
export async function accrueBlockAuthorFee(
  input: AccrueBlockAuthorFeeInput
): Promise<AccrueBlockAuthorFeeResult> {
  const { workflowId, appId, appBlockId, viewerUserId, buzzType, computation, generationType } =
    input;

  // A zero fee is not an accrual with an amount of zero — it is the absence of a
  // charge. Writing it would put rows in the ledger that can never settle (the
  // mint filters `amount > 0`) and would make "how many generations charged a
  // fee" unanswerable from the table.
  if (computation.feeBuzz <= 0) return { accrued: false, reason: 'zero-fee' };

  // Resolve + snapshot the app owner. 🔴 AT WRITE TIME, never at settlement: an
  // app that changes hands must not retroactively move earnings already accrued
  // to the previous owner (`app-ownership-transfer.service.ts` is the precedent).
  const app = await dbRead.oauthClient.findUnique({
    where: { id: appId },
    select: { id: true, userId: true },
  });
  if (!app?.userId) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'warning',
        message: 'accrual skipped: app or owner missing',
        workflowId,
        appId,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'app-missing' };
  }

  // 🔴 SELF-DEALING EXCLUSION (operator, 2026-09-18). An author running their own
  // app would otherwise pay themself, which is a round trip that inflates every
  // earnings number while moving no real money — and is the cheapest possible
  // way to fake traction on an app. Excluded at ACCRUAL rather than at
  // settlement, so a self-run generation never enters the ledger at all.
  //
  // ⚠️ IT IS IMPLEMENTED ONCE, HERE, AND NOTHING SHARES IT. An earlier revision
  // claimed "the charge path reads this same predicate before taking the money".
  // There is no charge path (slice 2b) and no shared predicate — slice 1 has no
  // self-dealing check of any kind. So today a self-dealing viewer would still be
  // DEBITED by a charge path that does not consult this, and only the accrual
  // would be skipped. 🔴 Slice 2b must call this predicate BEFORE the debit, or
  // extract it; do not assume the exclusion is already enforced upstream.
  //
  // It is COUNTED, not silently dropped, so the exclusion is a number rather
  // than an absence — 91% of the spend population to date is operator
  // self-testing, so this arm is expected to be hot early and should not be
  // mistaken for the fee failing.
  if (app.userId === viewerUserId) {
    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'info',
        message: 'accrual skipped: self-dealing',
        workflowId,
        appId,
        appOwnerUserId: app.userId,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'self-dealing' };
  }

  const id = newBlockAuthorFeeAccrualId();

  try {
    await dbWrite.blockAuthorFeeAccrual.create({
      data: {
        id,
        workflowId,
        appId,
        appBlockId,
        appOwnerUserId: app.userId,
        viewerUserId,
        buzzType,
        feeBuzz: computation.feeBuzz,
        baseGenerationBuzz: computation.baseGenerationBuzz,
        flatLegBuzz: computation.flatLegBuzz,
        pctLegBuzz: computation.pctLegBuzz,
        governingLeg: computation.governingLeg,
        generationType,
        status: STATUS_ACCRUED,
      },
    });
  } catch (error) {
    // The unique index on workflow_id is the idempotency guard: a
    // resubmit of the same workflow lands here rather than double-charging. It
    // is benign and must NOT be reported as a failure, or a retry would look
    // like a lost accrual and invite a compensating write.
    if (isUniqueViolation(error)) return { accrued: false, reason: 'duplicate' };

    logToAxiom(
      {
        name: BLOCK_AUTHOR_FEE_LOG_NAME,
        type: 'error',
        message: 'accrual write failed',
        workflowId,
        appId,
        feeBuzz: computation.feeBuzz,
        error: error instanceof Error ? error.message : String(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { accrued: false, reason: 'error' };
  }

  return { accrued: true, id, feeBuzz: computation.feeBuzz };
}

/**
 * Postgres unique-violation detection, by CODE rather than by message.
 *
 * ⚠️ Deliberately not `instanceof Prisma.PrismaClientKnownRequestError`: this
 * module is unit-tested against a mocked client, and an instanceof check against
 * the real Prisma class silently fails for a plain object carrying the right
 * code — turning the idempotency arm into dead code that no test can reach.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** One payable group: everything one owner accrued in one currency on one day. */
export type SettlementBucket = {
  appOwnerUserId: number;
  buzzType: string;
  /** The UTC day the rows in this bucket ACCRUED on — `YYYY-MM-DD`. */
  accrualDay: string;
  /** Total Buzz owed. Always > 0 — `fee_buzz > 0` is a CHECK. */
  totalBuzz: number;
  rowIds: string[];
};

export type SettleBlockAuthorFeesResult = {
  buckets: number;
  rowsSettled: number;
  buzzMinted: number;
  /** Accrual days skipped because they exceeded `limit` and could not be settled whole. */
  daysTruncated: number;
};

/**
 * Settle accrued author fees, one COMPLETE accrual day at a time.
 *
 * 🔴 THE KEY IS DERIVED FROM THE ROW'S ACCRUAL DAY, NOT FROM WHEN THE JOB RAN.
 * That is the whole idempotency story, and the previous two revisions both got it
 * wrong in ways their own comments denied. Recorded in full because the failure is
 * silent money movement and the wrong version reads perfectly reasonable:
 *
 *   REVISION 1 — keyed on the run day, scanned every `accrued` row. A second run
 *   on the same day swept rows accrued since the first and minted them under the
 *   already-used key: conflict, no money, rows flipped `settled`. Silent loss.
 *
 *   REVISION 2 — keyed on the run day, scanned rows accrued before midnight of the
 *   run day. This fixed the same-day sweep and nothing else, while asserting three
 *   times that it fixed both directions. It did NOT: a row whose flip failed stayed
 *   `accrued`, and the next day's run re-derived a DIFFERENT key (tomorrow's date),
 *   so the Buzz service saw a new `externalTransactionId` and PAID THE OWNER AGAIN.
 *   The comment claiming "an unflipped row still belongs to its original day, so
 *   its key is unchanged" was false: the day came from `args.date`, never from a row.
 *
 * Now the bucket carries `accrualDay` and the key is built from it, so the key a
 * row settles under is a function of the ROW. A retry tomorrow, next week, or after
 * the flag has been off for a month re-derives the SAME key and conflicts.
 *
 * 🔴 AND A BUCKET IS ALWAYS SETTLED WHOLE. A conflict tells you that key already
 * minted; it does NOT tell you those particular rows were in it. So a partially
 * settled bucket is indistinguishable from a fully settled one, and flipping on a
 * conflict would forgive whatever was left out. The only defence is never to mint a
 * partial bucket: one day is processed at a time, and if that day does not fit in
 * `limit` it is SKIPPED ENTIRELY and reported rather than truncated. This is why
 * the scan cannot simply page by row — `take` on an ordered row scan cuts buckets
 * in half, and that cut is exactly what revision 1 lost money to.
 */
export async function settleBlockAuthorFees(args: {
  /** Settle days strictly BEFORE this instant's UTC day. Defaults to now. */
  date?: Date;
  /** Max rows per accrual day. A day exceeding it is skipped whole, never cut. */
  limit?: number;
  /** Max PRODUCTIVE accrual days to settle in one run. Stuck days do not count. */
  maxDays?: number;
  /** Absolute cap on loop iterations, so accumulated stuck days cannot spin. */
  maxIterations?: number;
}): Promise<SettleBlockAuthorFeesResult> {
  const now = args.date ?? new Date();
  const boundary = utcDayStart(now);
  const limit = args.limit ?? 50_000;
  const maxDays = args.maxDays ?? 30;
  // A day that cannot settle still costs a round-trip; this keeps the loop finite
  // when many of them have accumulated, without letting them starve the good ones.
  const maxIterations = args.maxIterations ?? maxDays * 4;

  let buckets = 0;
  let rowsSettled = 0;
  let buzzMinted = 0;
  let daysTruncated = 0;

  // 🔴 A MONOTONIC CURSOR, AND IT IS WHAT MAKES THE LOOP TERMINATE. An earlier
  // revision re-selected "the oldest unsettled day" every iteration with nothing
  // to advance past a day that did not finish, which meant a day the loop could
  // not complete was selected again forever:
  //   * an OVERSIZED day broke the run and stayed the oldest, so it blocked EVERY
  //     later day permanently — and since the job passes no `limit`, the only
  //     recovery was a code change and a deploy;
  //   * a bucket the Buzz service keeps rejecting left its rows `accrued`, so the
  //     next iteration re-selected the same day and re-minted it, burning all
  //     `maxDays` iterations on one stuck owner while every other author stopped
  //     being paid.
  // Neither was a money defect — the row-derived key still makes a retry conflict
  // — but both halt settlement for everyone else, reported only as a log line.
  // The cursor advances past a day whether it settled, was skipped or failed, so
  // within one run a stuck day costs exactly one iteration.
  //
  // ⚠️ THAT BOUNDS BLOCKING WITHIN A RUN, NOT ACROSS RUNS, AND AN EARLIER
  // REVISION CLAIMED THE STRONGER PROPERTY ("nothing is abandoned permanently").
  // Both stuck-day arms are PERMANENT, not transient: an oversized day is
  // unsettleable until someone raises `limit` (the job passes none), and a
  // persistently-rejected owner's rows stay `accrued` forever. Each such day is
  // re-selected on EVERY later run. So `maxDays` counts only PRODUCTIVE days —
  // otherwise N accumulated stuck days eventually consume the whole budget and
  // settlement stops for everyone, which is the same end state the cursor was
  // added to prevent, reached N days later. `maxIterations` is the absolute
  // bound that keeps the loop finite when many days are stuck.
  let cursorFrom = new Date(0);
  let productiveDays = 0;

  for (let iteration = 0; iteration < maxIterations && productiveDays < maxDays; iteration += 1) {
    // The oldest unsettled day AT OR AFTER the cursor.
    const oldest = await dbWrite.blockAuthorFeeAccrual.findFirst({
      where: { status: STATUS_ACCRUED, accruedAt: { gte: cursorFrom, lt: boundary } },
      select: { accruedAt: true },
      orderBy: { accruedAt: 'asc' },
    });
    if (!oldest) break;

    const dayStart = utcDayStart(oldest.accruedAt);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const accrualDay = dayStart.toISOString().slice(0, 10);
    // Advance BEFORE any early exit below, so every path leaves this day behind.
    cursorFrom = dayEnd;

    // 🔴 READ THE PRIMARY. This scan decides who gets paid and the flip writes to
    // the primary; a lagging replica would re-offer a row another run just settled.
    // `take: limit + 1` so a full day is DETECTABLE rather than silently cut.
    const rows = await dbWrite.blockAuthorFeeAccrual.findMany({
      where: { status: STATUS_ACCRUED, accruedAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, appOwnerUserId: true, buzzType: true, feeBuzz: true },
      orderBy: { accruedAt: 'asc' },
      take: limit + 1,
    });

    if (rows.length > limit) {
      // Settling part of this day would mint a partial bucket, and the next run
      // would flip the remainder on a conflict without ever paying for it. Skip
      // the day WHOLE and shout — then CONTINUE, because the cursor has already
      // moved past it and later days must not be held hostage to this one.
      daysTruncated += 1;
      logToAxiom(
        {
          name: BLOCK_AUTHOR_FEE_LOG_NAME,
          type: 'error',
          message: 'accrual day exceeds the per-day limit — skipped, not truncated',
          accrualDay,
          limit,
        },
        'civitai-prod'
      ).catch(() => undefined);
      continue;
    }
    // The day emptied under us — a concurrent run settled it between the two
    // reads. Move on rather than ending the run; the cursor guarantees no spin.
    if (!rows.length) continue;

    const byBucket = new Map<string, SettlementBucket>();
    for (const row of rows) {
      const k = `${row.appOwnerUserId}:${row.buzzType}`;
      const bucket = byBucket.get(k) ?? {
        appOwnerUserId: row.appOwnerUserId,
        buzzType: row.buzzType,
        accrualDay,
        totalBuzz: 0,
        rowIds: [],
      };
      bucket.totalBuzz += row.feeBuzz;
      bucket.rowIds.push(row.id);
      byBucket.set(k, bucket);
    }

    const payable = [...byBucket.values()];
    buckets += payable.length;
    productiveDays += 1;

    // 🔴 ONE BUCKET PER CALL, so a drop is ATTRIBUTABLE. `createBuzzTransactionMany`
    // reports only counts and opaque ids, so a batch that under-reconciles cannot
    // say WHICH bucket failed. The previous revision's answer was to flip nothing in
    // the batch — which left SUCCESSFULLY MINTED buckets `accrued`, and under a
    // run-day key those were re-minted the next day. Per-bucket makes the question
    // answerable: this bucket moved, or it did not.
    for (const bucket of payable) {
      const key = keyForBucket(bucket);

      // 🔴 THE MINT IS WRAPPED, AND PER-BUCKET MINTING IS WHY IT HAS TO BE.
      // Unwrapped, bucket 1 of N throwing aborts buckets 2..N, the day loop and
      // the completion log. Splitting one batched call into N calls multiplied
      // that exposure by N, so the per-bucket change made wrapping necessary
      // rather than optional. A throw is treated exactly like a drop: the rows
      // stay `accrued` and the next run re-derives the same key, so money is
      // never at risk — only this bucket's timeliness.
      //
      // ⚠️ AN EARLIER REVISION SAID THE CLIENT'S "retry allowlist covers only
      // connection-level errors — a 5xx or a 504 throws on the first response".
      // THAT IS FALSE, and false in the reassuring direction. `createTransactions`
      // calls `post` with no options, so `shouldRetry` is undefined, and the
      // client's `withRetries` reads `shouldRetry ? predicate(...) : true` under a
      // comment saying "Absent predicate keeps the historical behaviour: retry
      // everything". `isSafeToRetry` is exported but never applied on this path.
      // So a 5xx is retried at the client default (3), and a run with N payable
      // buckets can issue up to 4N POSTs during an outage rather than N. Size any
      // timeout or alert against that number, not against N.
      let mint: Awaited<ReturnType<typeof createBuzzTransactionMany>> | null = null;
      let threw: unknown = null;
      try {
        mint = await createBuzzTransactionMany([
          {
            fromAccountId: 0,
            toAccountId: bucket.appOwnerUserId,
            fromAccountType: bucket.buzzType as BuzzAccountType,
            toAccountType: bucket.buzzType as BuzzAccountType,
            amount: bucket.totalBuzz,
            description: `App author fee (${bucket.accrualDay})`,
            type: TransactionType.Fee,
            externalTransactionId: key,
          },
        ]);
      } catch (error) {
        threw = error;
      }

      // A CONFLICT means this exact key already minted — and because the key is
      // row-derived and the bucket is whole, that is the same payment, so the rows
      // may be flipped.
      //
      // ⚠️ THE PRECONDITION, stated because it is an invariant nothing enforces:
      // this holds only while no row can JOIN a (day, owner, currency) group that
      // has already minted. Today that is safe because `accrued_at` defaults to
      // `now()`, so rows only ever leave the set. A backfill or import writing a
      // historical `accrued_at` would break it, and the break is a SILENT
      // UNDERPAYMENT — the mint conflicts on the old total and the newcomer is
      // flipped for free. Anything that writes a non-`now()` accrual time must
      // settle that day again under a different key, or not write one at all. A DROP means no money moved: leave them `accrued` and let
      // the next run re-derive this same key.
      // `mint` is assigned only inside the `try`, so it is null on every throw
      // path and this expression is already false there. An earlier revision
      // also conjoined `threw === null`; it was measured UNKILLABLE (deleting it
      // left the suite green) and removed rather than left to read as a guard.
      const moved = (mint?.transactions?.length ?? 0) + (mint?.conflicts?.length ?? 0) > 0;
      if (!moved) {
        logToAxiom(
          {
            name: BLOCK_AUTHOR_FEE_LOG_NAME,
            type: 'error',
            message: 'bucket mint did not land — left accrued for retry',
            accrualDay: bucket.accrualDay,
            appOwnerUserId: bucket.appOwnerUserId,
            buzzType: bucket.buzzType,
            buzz: bucket.totalBuzz,
            // 🔴 THE STATUS, NOT JUST THE MESSAGE. `buzzService` is constructed with
            // a `mapError`, so every non-2xx arrives here as a TRPCError whose
            // message is the fixed string "An unexpected error ocurred, please try
            // again later" — a permanent 400 and a transient 503 produce BYTE-
            // IDENTICAL log lines, repeated daily forever, so the permanent one is
            // indistinguishable from noise. `getBuzzApiStatus` reads the real
            // status back through the wrapper.
            threwStatus: getBuzzApiStatus(threw) ?? null,
            threw: threw instanceof Error ? threw.message : threw ? String(threw) : null,
          },
          'civitai-prod'
        ).catch(() => undefined);
        continue;
      }

      // 🔴 THE FLIP IS WRAPPED FOR THE SAME REASON THE MINT IS. An earlier
      // revision wrapped only the mint, and the sentence justifying that wrap —
      // "bucket 1 of N throwing aborts buckets 2..N, the day loop and the
      // completion log" — stayed true, verbatim, of this statement one line
      // below it. `id: { in: rowIds }` can carry up to `limit` ids, so it is a
      // genuinely heavy statement and a timeout here is not exotic. Money is
      // safe either way (the rows stay `accrued` and the key conflicts on
      // retry); what an unwrapped throw costs is every remaining bucket and
      // every later day in the run.
      let count = 0;
      try {
        ({ count } = await dbWrite.blockAuthorFeeAccrual.updateMany({
          where: { id: { in: bucket.rowIds }, status: STATUS_ACCRUED },
          data: { status: STATUS_SETTLED, settlementKey: key, settledAt: new Date() },
        }));
      } catch (error) {
        logToAxiom(
          {
            name: BLOCK_AUTHOR_FEE_LOG_NAME,
            type: 'error',
            message: 'settled rows could not be flipped — money moved, rows still accrued',
            accrualDay: bucket.accrualDay,
            appOwnerUserId: bucket.appOwnerUserId,
            settlementKey: key,
            error: error instanceof Error ? error.message : String(error),
          },
          'civitai-prod'
        ).catch(() => undefined);
        continue;
      }
      rowsSettled += count;
      // Only for rows THIS run flipped — a concurrent run that got there first
      // returns 0, and counting it would log a payment this run did not make.
      if (count > 0) buzzMinted += bucket.totalBuzz;
    }
  }

  logToAxiom(
    {
      name: BLOCK_AUTHOR_FEE_LOG_NAME,
      type: 'info',
      message: 'settlement complete',
      buckets,
      rowsSettled,
      buzzMinted,
      daysTruncated,
    },
    'civitai-prod'
  ).catch(() => undefined);

  return { buckets, rowsSettled, buzzMinted, daysTruncated };
}

/** Midnight UTC of the day `d` falls in. */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The settlement key. ONE spelling, used for the mint's `externalTransactionId`
 * and for the row's `settlementKey`, so row→mint traceability cannot drift.
 *
 * 🔴 Every component comes from the ROWS, never from the clock: change the day a
 * row accrued and the key changes; run the job at a different time and it does not.
 */
function keyForBucket(bucket: SettlementBucket): string {
  return `block-author-fee-${bucket.accrualDay}-${bucket.appOwnerUserId}-${bucket.buzzType}`;
}
