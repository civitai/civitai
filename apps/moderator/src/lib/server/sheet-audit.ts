import type { ReviewTier } from '@civitai/shared/review-batch';
import { logToAxiom } from './axiom';
import type { ExchangeRefusal } from './held-sheet';

// The phone sheets' sign-ins and sign-outs, one event each: the access audit for held media (who
// opened a sheet, when, and whether it let them in). Never a token, code, verifier, state or image
// id: only the tier, the moderator and a short batch tag.
export const SHEET_START_EVENT = 'held-sheet-start';
export const SHEET_EXCHANGE_EVENT = 'held-sheet-exchange';
export const SHEET_SIGNOUT_EVENT = 'review-sheet-signout';

/** Six characters of the batch's hash (a sha256 of its id): tells one batch's opens apart. */
const batchTag = (hash: string | undefined) => hash?.slice(0, 6);

/** A confirmed `auth/start`: `issued` when a code went to the sheet, else the status it refused with. */
export function auditSheetStart(event: {
  tier: ReviewTier;
  moderatorId: number;
  batch?: string;
  outcome: 'issued' | 'refused' | 'error';
  status?: number;
}) {
  void logToAxiom({
    name: SHEET_START_EVENT,
    type: 'info',
    tier: event.tier,
    moderatorId: event.moderatorId,
    batch: batchTag(event.batch),
    outcome: event.outcome,
    status: event.status,
  });
}

/**
 * An `auth/exchange`. A refusal is logged only once the code was found, so it names a moderator:
 * the route needs no sign-in, and anyone could otherwise fill this permanent stream with
 * malformed or unknown codes that say nothing about who was let in.
 */
export function auditSheetExchange(event: {
  tier: ReviewTier;
  outcome: 'ok' | 'refused' | 'error';
  reason?: ExchangeRefusal;
  moderatorId?: number;
  batch?: string;
}) {
  if (event.outcome === 'refused' && event.moderatorId === undefined) return;
  void logToAxiom({
    name: SHEET_EXCHANGE_EVENT,
    type: 'info',
    tier: event.tier,
    outcome: event.outcome,
    reason: event.reason,
    moderatorId: event.moderatorId,
    batch: batchTag(event.batch),
  });
}

/** The general sheet's Sign out that ended a session, or failed. A cookie naming no live session is
 *  not logged: the route needs no sign-in, so those say nothing about a moderator. */
export function auditSheetSignout(event: {
  moderatorId: number | null;
  ended: boolean;
  error?: true;
}) {
  if (!event.ended && !event.error) return;
  void logToAxiom({
    name: SHEET_SIGNOUT_EVENT,
    type: event.error ? 'error' : 'info',
    tier: 'general',
    moderatorId: event.moderatorId ?? undefined,
    // Not top-level: the main Axiom dataset is at its field limit and drops unlisted keys.
    payload: { ended: event.ended },
  });
}
