/**
 * App Store Listings (W13) — P3b REPORT VIEW MODEL (pure, React-free).
 *
 * The reason-option list + inline-error copy for the off-site report affordance,
 * extracted so the correctness gate lives in the node `unit` project (the civitai
 * browser-mode component suites are REPORT-ONLY / non-blocking — so the real,
 * blocking coverage for the report picker lives here, mirroring
 * `appListingCardView` / `appListingDetailView`).
 *
 * The reason VALUES are the single-source tuple from the moderation schema (the
 * same tuple the service re-validates + the migration CHECK enforces), so the
 * picker can never drift from what the DB accepts.
 */

import {
  APP_LISTING_REPORT_REASONS,
  type AppListingReportReason,
} from '~/server/schema/blocks/offsite-moderation.schema';

export type ReportReasonOption = { value: AppListingReportReason; label: string };

/** Human labels for each report reason (keyed by the schema tuple). */
const REASON_LABELS: Record<AppListingReportReason, string> = {
  impersonation: 'Impersonation — not the real app or owner',
  'phishing-malware': 'Phishing or malware',
  broken: 'Broken — does not work',
  inappropriate: 'Inappropriate content',
  spam: 'Spam',
  other: 'Something else',
};

/**
 * Reason options in the schema's declared order, for the modal's reason picker.
 * Built from the schema tuple so adding a reason (schema + CHECK) surfaces it here
 * automatically (the `Record` type makes a missing label a COMPILE error).
 */
export const APP_LISTING_REPORT_REASON_OPTIONS: ReportReasonOption[] =
  APP_LISTING_REPORT_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }));

/** Human label for a stored reason value (falls back to the raw value). */
export function getReportReasonLabel(reason: string): string {
  return (REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

/** Type-guard narrowing an arbitrary picker value to a valid report reason (no cast). */
export function isReportReason(value: string): value is AppListingReportReason {
  return (APP_LISTING_REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * Map a caught `reportListing` mutation error to inline modal copy. The duplicate-
 * report case (DB partial-unique → CONFLICT) gets the friendly "already reported"
 * message; a not-reportable / not-found case surfaces the server message; anything
 * else is a generic fallback (the raw infra message is never surfaced — the router
 * already collapses unknown errors to a generic INTERNAL message).
 */
export function reportErrorMessage(
  err: { data?: { code?: string | null } | null; message?: string | null } | null | undefined
): string {
  const code = err?.data?.code ?? null;
  if (code === 'CONFLICT') {
    return 'You have already reported this app — a moderator is reviewing it.';
  }
  if (code === 'NOT_FOUND' || code === 'BAD_REQUEST') {
    return err?.message ?? 'This app can no longer be reported.';
  }
  return 'Something went wrong submitting your report. Please try again later.';
}
