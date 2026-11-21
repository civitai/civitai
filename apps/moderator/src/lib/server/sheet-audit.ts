import type { ReviewTier } from '@civitai/shared/review-batch';
import { logToAxiom } from './axiom';
import type { ExchangeRefusal } from './held-sheet';

// The phone sheets' sign-ins and sign-outs, one event each. They are the access audit for held media
// (who opened a sheet, when, and whether it let them in), so they stay after any one test that reads
// them. Never a token, code, verifier, state or image id: only the tier, the moderator and a short
// tag of the batch.
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

/** An `auth/exchange`. `moderatorId` is unknown when the code was malformed or never found. */
export function auditSheetExchange(event: {
  tier: ReviewTier;
  outcome: 'ok' | 'refused' | 'error';
  reason?: ExchangeRefusal | 'not-json';
  moderatorId?: number;
  batch?: string;
}) {
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

/** The general sheet's Sign out. `ended` is false when the cookie named no live session. */
export function auditSheetSignout(event: {
  moderatorId: number | null;
  ended: boolean;
  error?: true;
}) {
  void logToAxiom({
    name: SHEET_SIGNOUT_EVENT,
    type: event.error ? 'error' : 'info',
    tier: 'general',
    moderatorId: event.moderatorId ?? undefined,
    ended: event.ended,
  });
}
