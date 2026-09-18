import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import {
  BLOCK_AUTHOR_FEE_LOG_NAME,
  STATUS_ACCRUED,
  STATUS_SETTLED,
} from './author-fee-accrual.service';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — slice 2b, the SETTLEMENT RAIL.
//
// HOP 2 of the two-hop design stated in `author-fee-accrual.service.ts`. Hop 1
// (slice 2a, #4944) writes an `accrued` row recording a debit the viewer has
// already been charged. This file sums those rows per (owner × buzz type ×
// ACCRUAL DAY) and mints the total to the owner.
//
// 🔴 THIS SLICE IS SEPARATE FROM THE LEDGER ON PURPOSE, AND THE REASON IS ITS
// ENTRY CONDITION. Settlement has no consumer until a charge path supplies rows:
// `accrueBlockAuthorFee` has no callers, so the table is empty by construction,
// so this rail's first real exercise would be the day that charge path lands.
// Shipping it earlier would put money-moving code in production whose only
// evidence of correctness is its unit tests. It merges with the viewer-charge
// path that gives it rows.
//
// 🔴 THE PLATFORM IS A CONDUIT, NOT A PARTY. D1: the platform takes NO cut and
// funds NOTHING. The author is credited EXACTLY what the viewer was debited —
// `feeBuzz` on the row is one number used on both sides. Any change that makes
// the credited total differ from the debited total is a change to that decision,
// not an implementation detail, and belongs in front of the operator.
//
// 🔴 THE STATUS LITERALS AND THE LOG NAME ARE IMPORTED, NOT RE-DECLARED. They
// name a CHECK-constrained column and a log stream that slice 2a owns. A second
// spelling here would compile, match no row, and fail silently — which is the
// whole failure mode this rail is built to avoid.
// ─────────────────────────────────────────────────────────────────────────────

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
  /**
   * Buckets whose mint landed but whose flip threw.
   *
   * 🔴 THE ONE COUNTER THAT MEANS MONEY MOVED WITHOUT A SETTLED ROW. Before the
   * flip was wrapped, such a throw failed the whole job and was loud. Wrapping it
   * fixed the liveness problem and made the failure SILENT — a systemic flip
   * failure (pool exhaustion, a lock, a statement timeout on an `IN` list of up to
   * `limit` ids) would otherwise report `rowsSettled: 0` on a job that returns
   * success, every night, while money leaves on day one of each bucket. Alert on
   * this being non-zero.
   */
  flipFailures: number;
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
  // 🔴 THE SAME PREDICATE THE REVERSAL PATH REFUSES ON — one spelling, two
  // readers. See `settlementBoundary`.
  const boundary = settlementBoundary(now);
  const limit = args.limit ?? 50_000;
  const maxDays = args.maxDays ?? 30;
  // A day that cannot settle still costs a round-trip; this keeps the loop finite
  // when many of them have accumulated, without letting them starve the good ones.
  const maxIterations = args.maxIterations ?? maxDays * 4;

  let buckets = 0;
  let rowsSettled = 0;
  let buzzMinted = 0;
  let daysTruncated = 0;
  let flipFailures = 0;

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
    // 🔴 COUNTED AFTER THE BUCKET LOOP, CONDITIONAL ON SOMETHING LANDING — see the
    // increment below. An earlier revision counted here, before a single mint was
    // attempted, which delivered only HALF of what its own comment promised: the
    // oversized arm was excluded (it continues above this point) but the
    // persistently-rejected-owner arm was not. A day on which every bucket dropped
    // still burned a productive-day slot, so thirty such days would exhaust the
    // budget and stop settlement for everyone — exactly the failure the productive
    // count was added to prevent.
    let landedAny = false;

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
            // a `mapError` whose `default` branch collapses every status it does
            // not name into the fixed string "An unexpected error ocurred, please
            // try again later". `getBuzzApiStatus` reads the real status back
            // through the TRPCError's `cause`.
            //
            // ⚠️ AN EARLIER REVISION MOTIVATED THIS WITH "a permanent 400 and a
            // transient 503 produce BYTE-IDENTICAL log lines", AND 400 IS THE ONE
            // STATUS FOR WHICH THAT IS FALSE: `mapError` names 400, 404 and 409
            // explicitly ("Your request is invalid", "Not found", "There is a
            // conflict with the transaction"), so those three were already
            // distinguishable. The fix is still worth having — 401, 403, 408, 429,
            // 500, 502 and 503 all fall to `default` and genuinely are identical,
            // so a permanent auth failure and a transient outage were the
            // indistinguishable pair. The example was wrong, not the reason.
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
            // A connection drop AFTER the UPDATE commits raises here with the rows
            // already flipped, so "rows still accrued" would be the opposite of
            // the truth on a line an operator acts on. This says only what the
            // code can observe.
            message: 'settled rows may not have been flipped — mint landed, flip did not confirm',
            accrualDay: bucket.accrualDay,
            appOwnerUserId: bucket.appOwnerUserId,
            settlementKey: key,
            // The one case where money actually moved — so the amount belongs on
            // the line. Reconciling "how much left the platform with no settled
            // row" should not require the Buzz service.
            buzz: bucket.totalBuzz,
            error: error instanceof Error ? error.message : String(error),
          },
          'civitai-prod'
        ).catch(() => undefined);
        flipFailures += 1;
        continue;
      }
      rowsSettled += count;
      landedAny = true;
      // Counts Buzz only for rows THIS run flipped.
      //
      // ⚠️ IT IS NOT THE TEST THE OLD COMMENT CLAIMED ("a payment this run did not
      // make"). `count > 0` cannot distinguish a fresh mint from a CONFLICT on a
      // key an earlier run already paid — and the wrapped flip below makes that
      // ordinary rather than exotic: a run whose flip throws leaves rows accrued,
      // and the next run conflicts, flips them, and adds the total here. The
      // cross-run sum stays correct (the failing run added nothing), so this is a
      // reporting imprecision, not money. Stated rather than reworded, because the
      // exact claim is what a reader would otherwise rely on.
      if (count > 0) buzzMinted += bucket.totalBuzz;
    }

    if (landedAny) productiveDays += 1;
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
      flipFailures,
    },
    'civitai-prod'
  ).catch(() => undefined);

  return { buckets, rowsSettled, buzzMinted, daysTruncated, flipFailures };
}

/** Midnight UTC of the day `d` falls in. */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The instant this rail will not scan at or after: `settleBlockAuthorFees` only
 * ever considers rows accrued STRICTLY BEFORE midnight UTC of the run's own day,
 * because a day still in progress cannot be settled whole.
 *
 * 🔴 EXPORTED BECAUSE THE REVERSAL PATH REFUSES ON IT, AND THAT IS THE WHOLE
 * POINT. `reverseBlockAuthorFee` must answer "can a mint have landed for this
 * row?" and `status` cannot answer it: the mint happens at the
 * `createBuzzTransactionMany` above and the status only moves at the `updateMany`
 * after it, so between those two statements the money is already the author's
 * while the row still reads `accrued`. Worse, that window is not a race — when
 * the flip throws, `flipFailures` is incremented and the rows stay `accrued`
 * until the next nightly run, so it is ~24h wide and deterministic.
 *
 * This boundary is the structural answer, and it is a property of THE ROW plus
 * the clock rather than a word another code path can write: a row accrued in the
 * CURRENT UTC day is not visible to any settlement run, so no mint can have been
 * attempted for it; a row accrued before it may have minted at any moment,
 * whatever its status says. One spelling, read by the scan that decides who gets
 * paid and by the guard that decides who may be refunded, so the two cannot
 * disagree.
 *
 * ⚠️ WHAT IT DOES NOT ELIMINATE. Both sides compare against their OWN clock, so
 * a reversal evaluating just before midnight and a settlement run starting just
 * after it are separated by clock skew, not by a lock. That residue is seconds
 * wide at one instant a day, against the ~24h window it replaces; closing it
 * completely needs a claim COLUMN the reversal can read, which needs a schema
 * change (see `reverseBlockAuthorFee`).
 */
export function settlementBoundary(now: Date): Date {
  return utcDayStart(now);
}

/**
 * True when this row's accrual day is COMPLETE — i.e. a settlement run may
 * already have minted it, whatever its `status` column says.
 */
export function isSettlementEligible(accruedAt: Date, now: Date): boolean {
  return accruedAt.getTime() < settlementBoundary(now).getTime();
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
