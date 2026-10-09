import { listingEditHref } from '~/components/Apps/appListingEditorTabs';
import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import type {
  AppFeedbackOwnerStatusFilter,
  AppFeedbackSurface,
  SetAppFeedbackOwnerStatusInput,
} from '~/server/schema/app-feedback.schema';
import type { ListingKind } from '~/shared/constants/app-capabilities.constants';
import { canOpenListingAuthoringPage } from '~/shared/constants/app-capabilities.constants';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';
import { FEEDBACK_OWNER_STATUSES } from '~/shared/constants/feedback.constants';

/**
 * Pure decisions behind the owner's feedback inbox (the listing editor's Feedback tab) and the
 * `/apps/build` new-feedback badge. They live here so the node `unit` project covers them; the
 * `*.browser.test.tsx` suites do not gate merges.
 */

export const OWNER_STATUS_LABELS: Readonly<Record<FeedbackOwnerStatus, string>> = Object.freeze({
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
});

/** `null` in the column means the developer has not acted on it yet. */
export function ownerStatusLabel(status: FeedbackOwnerStatus | null): string {
  return status ? OWNER_STATUS_LABELS[status] : 'New';
}

export function ownerStatusColor(status: FeedbackOwnerStatus | null): string {
  switch (status) {
    case null:
      return 'blue';
    case 'acknowledged':
      return 'yellow';
    case 'resolved':
      return 'green';
    case 'wont_fix':
      return 'gray';
  }
}

/** The inbox filter, in display order; `all` sends no filter at all. */
export const INBOX_STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  ...FEEDBACK_OWNER_STATUSES.map((s) => ({ value: s, label: OWNER_STATUS_LABELS[s] })),
] as const satisfies ReadonlyArray<{
  value: 'all' | AppFeedbackOwnerStatusFilter;
  label: string;
}>;
export type InboxStatusFilter = (typeof INBOX_STATUS_FILTERS)[number]['value'];

export function inboxStatusFilterInput(
  filter: InboxStatusFilter
): AppFeedbackOwnerStatusFilter | undefined {
  return filter === 'all' ? undefined : filter;
}

/** Statuses the owner can move a row to. There is no way back to "New". */
export function ownerStatusChoices(current: FeedbackOwnerStatus | null): FeedbackOwnerStatus[] {
  return FEEDBACK_OWNER_STATUSES.filter((s) => s !== current);
}

/**
 * The write is scoped on what the owner last SAW, so a second tab or a co-editor who changed
 * the row in between gets a conflict instead of having their change silently overwritten.
 */
export function buildSetOwnerStatusInput(
  appListingId: string,
  row: { id: number; ownerStatus: FeedbackOwnerStatus | null },
  next: FeedbackOwnerStatus
): SetAppFeedbackOwnerStatusInput {
  return {
    id: row.id,
    appListingId,
    ownerStatus: next,
    expectedOwnerStatus: row.ownerStatus,
  };
}

const SURFACE_LABELS: Readonly<Record<AppFeedbackSurface, string>> = Object.freeze({
  page: 'App page',
  slot: 'Model page',
});

/** "v1.4.0 (3f9c2ab) · App page" — what was running and where; the date renders separately. */
export function feedbackRowMeta(row: {
  appBlockVersion: string | null;
  appBlockSha: string | null;
  surface: AppFeedbackSurface | null;
}): string[] {
  const sha = row.appBlockSha ? row.appBlockSha.slice(0, 7) : null;
  const version = row.appBlockVersion
    ? `v${row.appBlockVersion}${sha ? ` (${sha})` : ''}`
    : sha
    ? `build ${sha}`
    : null;
  const surface = row.surface ? SURFACE_LABELS[row.surface] : null;
  return [version, surface].filter((part): part is string => part !== null);
}

export const INBOX_EMPTY_MESSAGE =
  'No feedback yet. When people using this app send it private feedback, it shows up here. Only you, your collaborators and Civitai moderators can read it.';
export const INBOX_EMPTY_OFFSITE_NOTE = `Feedback is sent from the menu of an app running on Civitai, so ${STANDALONE_KIND_LABEL} apps don't receive any yet.`;
export const INBOX_FILTER_EMPTY_MESSAGE = 'No feedback with this status.';

export function inboxEmptyMessages(kind: ListingKind, filter: InboxStatusFilter): string[] {
  if (filter !== 'all') return [INBOX_FILTER_EMPTY_MESSAGE];
  return kind === 'offsite'
    ? [INBOX_EMPTY_MESSAGE, INBOX_EMPTY_OFFSITE_NOTE]
    : [INBOX_EMPTY_MESSAGE];
}

export function reporterLabel(username: string | null): string {
  return username ?? 'Deleted account';
}

export const INBOX_STALE_MESSAGE = 'Someone already changed this feedback. Refresh to see it.';
export const INBOX_NO_ACCESS_MESSAGE = "You no longer have access to this app's feedback.";
export const INBOX_GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export type InboxActionError = { kind: 'stale' | 'no_access' | 'other'; message: string };

type TrpcLikeError = { message?: string | null; data?: { code?: string | null } | null };

/**
 * A CONFLICT means the row moved since the owner loaded it (another status, already flagged,
 * or hidden by a moderator) — the fix is a refresh, never a retry of the same write.
 */
export function inboxActionError(error: TrpcLikeError): InboxActionError {
  switch (error.data?.code) {
    case 'CONFLICT':
      return { kind: 'stale', message: INBOX_STALE_MESSAGE };
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
      return { kind: 'no_access', message: INBOX_NO_ACCESS_MESSAGE };
    default:
      return { kind: 'other', message: INBOX_GENERIC_ERROR_MESSAGE };
  }
}

export type NewFeedbackBadge = { count: number; label: string; href: string };

/**
 * The `/apps/build` row badge. Only where the editor route opens, since the badge is a link
 * into its Feedback tab.
 */
export function newFeedbackBadge(
  counts: Readonly<Record<string, number>> | undefined,
  row: { appListingId: string; status: string }
): NewFeedbackBadge | null {
  const count = counts?.[row.appListingId] ?? 0;
  if (count <= 0 || !canOpenListingAuthoringPage(row.status)) return null;
  return {
    count,
    label: `${count} new feedback`,
    href: listingEditHref(row.appListingId, 'feedback'),
  };
}
