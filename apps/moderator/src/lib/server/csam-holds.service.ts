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
  getHoldAuthorHolds,
  getHoldCoverImages,
  listCsamHolds,
  type AuthorHoldSummary,
  type CsamHoldCovers,
  type CsamHoldImage,
  type CsamHoldRow,
  type HoldAuthorHolds,
} from './csam-holds.queries';

export type CsamHoldItem = CsamHoldRow & { coverImages: CsamHoldImage[]; imageTotal: number };

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

/**
 * Decides the author's other pending holds one by one, each against the text hash the moderator saw: a
 * hold that changed since is reported, never forced. Call it only after the hold on screen was decided,
 * so a refused strike or ban never leaves the others already removed.
 */
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
  const results: AlsoDecidedResult[] = [];
  for (const target of targets) {
    if (!sameAuthor.has(target.holdId)) {
      results.push({
        holdId: target.holdId,
        ok: false,
        error: 'Not a pending hold of the same author.',
      });
      continue;
    }
    const result = await decideCsamHold({
      holdId: target.holdId,
      textHash: target.textHash,
      decision: decisionForOtherHolds(decision),
      note,
    });
    results.push(
      result.ok
        ? { holdId: target.holdId, ok: true }
        : { holdId: target.holdId, ok: false, error: result.error }
    );
  }
  return results;
}
