import {
  filterAuthorPendingHolds,
  type CsamHoldImage,
  type CsamHoldRow,
} from './csam-holds.queries';
import { callModEndpoint } from './user-actions.service';

export {
  AUTHOR_HOLDS_LIMIT,
  countCsamHoldsByType,
  countPendingCsamHolds,
  csamHoldSearch,
  getCleanRescans,
  getHoldAuthorHolds,
  getHoldCoverImages,
  listCsamHolds,
  type AuthorHoldSummary,
  type CsamHoldCovers,
  type CsamHoldImage,
  type CsamHoldRow,
  type HoldAuthorHolds,
} from './csam-holds.queries';

export type CsamHoldItem = CsamHoldRow & {
  coverImages: CsamHoldImage[];
  imageTotal: number;
  /** When the content was last scanned clean on text other than the held one; null while nothing says it changed. */
  cleanRescanAt: Date | null;
};

export type CsamHoldDecisionResult = { ok: true } | { ok: false; error: string };

/** Mirrors the main app's `CSAM_HOLD_DECISIONS`; the page's zod enum is checked against this at compile time. */
export type CsamHoldDecision =
  | 'dismiss'
  | 'remove'
  | 'remove_strike'
  | 'remove_ban'
  | 'remove_ban_report';

const MAY_HAVE_COMPLETED =
  'Could not confirm the decision. It may already have completed — reload the queue before retrying.';

/** The main app applies the decision (removal, strike, ban) and records it with the hold in one step. */
export async function decideCsamHold({
  holdId,
  textHash,
  decision,
  note,
}: {
  holdId: number;
  /** The hold's `textHash` as the moderator saw it; the main app refuses the decision if the text changed since. */
  textHash: string;
  decision: CsamHoldDecision;
  note?: string;
}): Promise<CsamHoldDecisionResult> {
  const result = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holdId, textHash, decision, ...(note ? { note } : {}) },
    'Decide hold'
  );
  if (!result.ok) {
    // Nobody answered, yet the request left: the main app may have applied it.
    if (!result.requestNeverSent && result.status === undefined)
      return { ok: false, error: MAY_HAVE_COMPLETED };
    return { ok: false, error: result.error };
  }
  const expected = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
  if (result.body.status !== expected)
    return {
      ok: false,
      error: `The main app did not report the hold as ${expected.toLowerCase()}.`,
    };
  return { ok: true };
}

export type AlsoDecidedHold = { holdId: number; textHash: string };
export type AlsoDecidedResult = { holdId: number; ok: boolean; error?: string };

/**
 * What the author's other holds get. The strike or ban of a decision is the author's, applied once with
 * the hold the moderator is on; the rest are only taken down, so a strike is never issued per hold.
 */
export const decisionForOtherHolds = (decision: CsamHoldDecision): CsamHoldDecision =>
  decision === 'dismiss' ? 'dismiss' : 'remove';

/** Mirrors the main app's `CSAM_HOLD_BATCH_MAX`. */
const BATCH_MAX = 50;
// The main app decides the holds one after another inside one request.
const BATCH_TIMEOUT_MS = 120_000;

/** Decides the author's other pending holds in one call, each against the hash its listing gave; a changed hold is reported, never forced. Call only after the on-screen hold is decided, so a refused strike or ban never leaves the others removed. */
export async function decideAuthorHolds({
  holdId,
  also,
  decision,
  note,
}: {
  holdId: number;
  also: AlsoDecidedHold[];
  decision: CsamHoldDecision;
  note?: string;
}): Promise<AlsoDecidedResult[]> {
  const targets = [...new Map(also.map((hold) => [hold.holdId, hold])).values()].filter(
    (hold) => hold.holdId !== holdId
  );
  const sameAuthor = new Set(
    (
      await filterAuthorPendingHolds(
        holdId,
        targets.map((hold) => hold.holdId)
      )
    ).map((hold) => hold.id)
  );
  const decidable = targets.filter((target) => sameAuthor.has(target.holdId));
  const outcome = new Map<number, AlsoDecidedResult>();
  for (const target of targets)
    if (!sameAuthor.has(target.holdId))
      outcome.set(target.holdId, {
        holdId: target.holdId,
        ok: false,
        error: 'Not a pending hold of the same author.',
      });
  for (const target of decidable.slice(BATCH_MAX))
    outcome.set(target.holdId, {
      holdId: target.holdId,
      ok: false,
      error: 'Too many holds at once.',
    });

  const batch = decidable.slice(0, BATCH_MAX);
  if (batch.length) {
    for (const result of await decideBatch(batch, decision, note))
      outcome.set(result.holdId, result);
  }
  return targets.map((target) => outcome.get(target.holdId)!);
}

async function decideBatch(
  batch: AlsoDecidedHold[],
  decision: CsamHoldDecision,
  note: string | undefined
): Promise<AlsoDecidedResult[]> {
  const other = decisionForOtherHolds(decision);
  const expected = other === 'dismiss' ? 'Dismissed' : 'Confirmed';
  const response = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holds: batch, decision: other, ...(note ? { note } : {}) },
    'Decide holds',
    BATCH_TIMEOUT_MS
  );
  if (!response.ok) {
    // Nobody answered, yet the request left: the main app may have applied some of it.
    const error =
      !response.requestNeverSent && response.status === undefined
        ? MAY_HAVE_COMPLETED
        : response.error;
    return batch.map((hold) => ({ holdId: hold.holdId, ok: false, error }));
  }

  const reported = new Map(
    (Array.isArray(response.body.results) ? (response.body.results as BatchEntry[]) : []).map(
      (entry) => [entry.holdId, entry]
    )
  );
  return batch.map(({ holdId }) => {
    const entry = reported.get(holdId);
    if (entry?.ok && entry.status === expected) return { holdId, ok: true };
    const error = entry?.ok
      ? `The main app did not report the hold as ${expected.toLowerCase()}.`
      : entry?.error ?? 'The main app did not report this hold.';
    return { holdId, ok: false, error };
  });
}

type BatchEntry = { holdId: number; ok: boolean; status?: string; error?: string };
