import {
  APP_FEEDBACK_HIDDEN_FILTERS,
  APP_FEEDBACK_OWNER_STATUS_FILTERS,
  APP_FEEDBACK_PAGE_LIMIT,
  type AppFeedbackOwnerStatusFilter,
  type ModListAppFeedbackInput,
} from '~/server/schema/app-feedback.schema';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';
import { moderatorFeedbackReportPath } from '~/shared/constants/moderator-app';

/**
 * Whether the viewer may see the "App feedback" tab on `/apps/review`.
 *
 * Mirrors `moderatorProcedure` (`user.isModerator`), which every `appFeedback.mod*` procedure
 * requires — NOT `isAppReviewer`, the page gate. The two agree today, but `isAppReviewer` is the
 * predicate that is expected to change, and a reviewer who is not a moderator would get a tab whose
 * every query is FORBIDDEN.
 */
export function canMonitorAppFeedback(
  user: { isModerator?: boolean | null } | null | undefined
): boolean {
  return user?.isModerator === true;
}

export type AppFeedbackHiddenFilter = (typeof APP_FEEDBACK_HIDDEN_FILTERS)[number];

export type AppFeedbackModFilters = {
  appListingId: string | null;
  listingDeleted: boolean;
  ownerStatus: AppFeedbackOwnerStatusFilter | null;
  flagged: boolean;
  hidden: AppFeedbackHiddenFilter;
};

export const DEFAULT_APP_FEEDBACK_MOD_FILTERS: AppFeedbackModFilters = {
  appListingId: null,
  listingDeleted: false,
  ownerStatus: null,
  flagged: false,
  hidden: 'all',
};

/** Query-string keys, beside the page's own `?tab=`. */
export const APP_FEEDBACK_FILTER_PARAMS = {
  appListingId: 'app',
  listingDeleted: 'listingDeleted',
  ownerStatus: 'ownerStatus',
  flagged: 'flagged',
  hidden: 'hidden',
} as const;

const LISTING_ID_MAX_LENGTH = 64;

function firstValue(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : undefined;
}

function isOneOf<T extends string>(options: readonly T[], value: string | undefined): value is T {
  return value !== undefined && (options as readonly string[]).includes(value);
}

/**
 * Reads the filters from a router query. Anything unrecognised falls back to "no filter" rather
 * than an error. A listing id and "listing deleted" cannot both hold — no row has a deleted
 * listing AND an id — so "listing deleted" wins and the id is dropped.
 */
export function parseAppFeedbackModFilters(query: Record<string, unknown>): AppFeedbackModFilters {
  const p = APP_FEEDBACK_FILTER_PARAMS;
  const listingDeleted = firstValue(query[p.listingDeleted]) === '1';
  const app = firstValue(query[p.appListingId]);
  const ownerStatus = firstValue(query[p.ownerStatus]);
  const hidden = firstValue(query[p.hidden]);
  return {
    appListingId: !listingDeleted && app && app.length <= LISTING_ID_MAX_LENGTH ? app : null,
    listingDeleted,
    ownerStatus: isOneOf(APP_FEEDBACK_OWNER_STATUS_FILTERS, ownerStatus) ? ownerStatus : null,
    flagged: firstValue(query[p.flagged]) === '1',
    hidden: isOneOf(APP_FEEDBACK_HIDDEN_FILTERS, hidden) ? hidden : 'all',
  };
}

/**
 * The query-string entries for these filters. Every key is present: a filter at its default maps
 * to `undefined`, which the caller's router drops, so clearing a filter removes its param.
 */
export function appFeedbackModFiltersToQuery(
  filters: AppFeedbackModFilters
): Record<string, string | undefined> {
  const p = APP_FEEDBACK_FILTER_PARAMS;
  return {
    [p.appListingId]: filters.listingDeleted ? undefined : filters.appListingId ?? undefined,
    [p.listingDeleted]: filters.listingDeleted ? '1' : undefined,
    [p.ownerStatus]: filters.ownerStatus ?? undefined,
    [p.flagged]: filters.flagged ? '1' : undefined,
    [p.hidden]: filters.hidden === 'all' ? undefined : filters.hidden,
  };
}

/**
 * The `appFeedback.modList` input (minus the cursor, which the infinite query owns).
 *
 * `flagged` and `listingDeleted` are sent only as `true`: the schema accepts nothing else, so an
 * unticked box must OMIT the key rather than send `false`.
 */
export function toModListInput(
  filters: AppFeedbackModFilters
): Omit<ModListAppFeedbackInput, 'cursor'> {
  return {
    limit: APP_FEEDBACK_PAGE_LIMIT,
    hidden: filters.hidden,
    ...(filters.listingDeleted
      ? { listingDeleted: true as const }
      : filters.appListingId
      ? { appListingId: filters.appListingId }
      : {}),
    ...(filters.ownerStatus ? { ownerStatus: filters.ownerStatus } : {}),
    ...(filters.flagged ? { flagged: true as const } : {}),
  };
}

export const APP_FEEDBACK_OWNER_STATUS_LABELS: Readonly<Record<FeedbackOwnerStatus, string>> = {
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};

export const APP_FEEDBACK_OWNER_STATUS_FILTER_OPTIONS: { value: string; label: string }[] =
  APP_FEEDBACK_OWNER_STATUS_FILTERS.map((value) => ({
    value,
    label: value === 'new' ? 'New' : APP_FEEDBACK_OWNER_STATUS_LABELS[value],
  }));

export const APP_FEEDBACK_HIDDEN_FILTER_OPTIONS: {
  value: AppFeedbackHiddenFilter;
  label: string;
}[] = [
  { value: 'all', label: 'All' },
  { value: 'visible', label: 'Visible to developer' },
  { value: 'hidden', label: 'Hidden from developer' },
];

/** The subset of a `modList` row this view reads. */
export type AppFeedbackModRow = {
  id: number;
  status: string;
  triageNote: string | null;
  appListingId: string | null;
  appBlockVersion: string | null;
  appBlockSha: string | null;
  ownerStatus: string | null;
  ownerStatusAt: Date | null;
  ownerStatusByUsername: string | null;
  ownerFlaggedAt: Date | null;
  hiddenFromOwnerAt: Date | null;
  hiddenByModeratorUsername: string | null;
  reporterId: number;
  reporterUsername: string | null;
  reporterBanned: boolean;
  reporterMuted: boolean;
  appName: string | null;
  appSlug: string | null;
  appOwnerId: number | null;
  appOwnerUsername: string | null;
  surface: 'slot' | 'page' | null;
  modelId: number | null;
};

export type AppFeedbackModRowView = {
  listingDeleted: boolean;
  appLabel: string;
  appHref: string | null;
  ownerLabel: string | null;
  reporterLabel: string;
  reporterHref: string | null;
  reporterBanned: boolean;
  reporterMuted: boolean;
  versionLabel: string | null;
  surfaceLabel: string | null;
  modelHref: string | null;
  modelLabel: string | null;
  ownerStatusLabel: string;
  ownerStatusBy: string | null;
  ownerStatusAt: Date | null;
  flagged: boolean;
  hidden: boolean;
  hiddenBy: string | null;
  triageStatus: string;
  triageNote: string | null;
  triageHref: string;
  action: 'hide' | 'unhide';
};

const SHA_DISPLAY_LENGTH = 7;
const SURFACE_LABELS = { slot: 'Model page slot', page: 'App page' } as const;

function userLabel(id: number, username: string | null): string {
  return username ?? `#${id}`;
}

function ownerStatusLabel(status: string | null): string {
  if (status === null) return 'New';
  return APP_FEEDBACK_OWNER_STATUS_LABELS[status as FeedbackOwnerStatus] ?? status;
}

/** Everything a moderator row shows, derived from one `modList` row. */
export function toAppFeedbackModRowView(
  row: AppFeedbackModRow,
  moderatorAppUrl: (path: string) => string
): AppFeedbackModRowView {
  const listingDeleted = row.appListingId === null;
  const version = [
    row.appBlockVersion ? `v${row.appBlockVersion}` : null,
    row.appBlockSha ? row.appBlockSha.slice(0, SHA_DISPLAY_LENGTH) : null,
  ].filter(Boolean);
  return {
    listingDeleted,
    appLabel: listingDeleted ? 'Listing deleted' : row.appName ?? row.appListingId ?? '',
    appHref: !listingDeleted && row.appSlug ? getListingDetailHref(row.appSlug) : null,
    ownerLabel: row.appOwnerId !== null ? userLabel(row.appOwnerId, row.appOwnerUsername) : null,
    reporterLabel: userLabel(row.reporterId, row.reporterUsername),
    reporterHref: row.reporterUsername ? `/user/${encodeURIComponent(row.reporterUsername)}` : null,
    reporterBanned: row.reporterBanned,
    reporterMuted: row.reporterMuted,
    versionLabel: version.length ? version.join(' · ') : null,
    surfaceLabel: row.surface ? SURFACE_LABELS[row.surface] : null,
    modelHref: row.modelId !== null ? `/models/${row.modelId}` : null,
    modelLabel: row.modelId !== null ? `Model #${row.modelId}` : null,
    ownerStatusLabel: ownerStatusLabel(row.ownerStatus),
    ownerStatusBy: row.ownerStatus !== null ? row.ownerStatusByUsername : null,
    ownerStatusAt: row.ownerStatus !== null ? row.ownerStatusAt : null,
    flagged: row.ownerFlaggedAt !== null,
    hidden: row.hiddenFromOwnerAt !== null,
    hiddenBy: row.hiddenFromOwnerAt !== null ? row.hiddenByModeratorUsername : null,
    triageStatus: row.status,
    triageNote: row.triageNote,
    triageHref: moderatorAppUrl(moderatorFeedbackReportPath(row.id)),
    action: row.hiddenFromOwnerAt === null ? 'hide' : 'unhide',
  };
}

export const APP_FEEDBACK_HIDE_COPY = {
  hide: {
    button: 'Hide from developer',
    title: 'Hide this report from the developer?',
    body: 'The developer and their collaborators will no longer see it. You can unhide it later.',
    done: 'Hidden from the developer',
  },
  unhide: {
    button: 'Unhide',
    title: 'Show this report to the developer again?',
    body: 'It reappears in the developer’s feedback inbox.',
    done: 'Visible to the developer again',
  },
} as const;

export const APP_FEEDBACK_HIDE_CONFLICT_MESSAGE =
  'Another moderator already changed this report. The list has been refreshed.';

/**
 * How a failed hide/unhide is reported. A CONFLICT means the row moved since it was loaded (a
 * second moderator, or a double click), so the list must be refetched to show its current state.
 */
export function appFeedbackHideErrorView(
  error: { message?: string; data?: { code?: string } | null } | null | undefined
): { message: string; refetch: boolean } {
  if (error?.data?.code === 'CONFLICT')
    return { message: APP_FEEDBACK_HIDE_CONFLICT_MESSAGE, refetch: true };
  return { message: error?.message || 'Something went wrong.', refetch: false };
}
