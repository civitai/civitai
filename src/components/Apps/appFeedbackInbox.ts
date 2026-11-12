import { listingEditHref } from '~/components/Apps/appListingEditorTabs';
import type {
  AppFeedbackBrowserFamily,
  AppFeedbackEnvironment,
  AppFeedbackOsFamily,
  AppFeedbackOwnerStatusFilter,
  AppFeedbackRecentError,
  AppFeedbackSurface,
  SetAppFeedbackOwnerStatusInput,
} from '~/server/schema/app-feedback.schema';
import { canOpenListingAuthoringPage } from '~/shared/constants/app-capabilities.constants';
import type { FeedbackOwnerStatus } from '~/shared/constants/feedback.constants';
import {
  APP_FEEDBACK_READERS,
  FEEDBACK_OWNER_STATUSES,
} from '~/shared/constants/feedback.constants';

/**
 * Pure decisions behind the Feedback tab and the `/apps/build` badge, kept out of the components
 * so the node `unit` project covers them.
 */

export const OWNER_STATUS_LABELS: Readonly<Record<FeedbackOwnerStatus, string>> = Object.freeze({
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
});

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

/** No way back to "New": `setOwnerStatus` accepts no null. */
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

/**
 * The commit the developer's own CLI reported at submit, e.g. "reported source 05c2d58
 * (unverified)" or "reported source 05c2d58 (unverified, uncommitted changes)". Nothing confirms the
 * bundle was built from it, and it may exist only on the developer's machine. A NULL dirty flag is
 * unknown, so it claims neither clean nor dirty.
 */
export function feedbackSourceLabel(row: {
  appSourceCommit?: string | null;
  appSourceDirty?: boolean | null;
}): string | null {
  if (!row.appSourceCommit) return null;
  const sha = row.appSourceCommit.slice(0, 7);
  return row.appSourceDirty === true
    ? `reported source ${sha} (unverified, uncommitted changes)`
    : `reported source ${sha} (unverified)`;
}

/**
 * Version, platform commit, reported source commit and surface, e.g.
 * ["v1.4.0 (platform commit 3f9c2ab)", "reported source 05c2d58 (unverified)", "App page"]; the
 * caller appends the date. The platform commit is the release commit in the app's build repo
 * (civitai-apps/<slug>), not in its source repo (see INBOX_COMMITS_NOTE).
 */
export function feedbackRowMeta(row: {
  appBlockVersion: string | null;
  appBlockSha: string | null;
  appSourceCommit?: string | null;
  appSourceDirty?: boolean | null;
  surface: AppFeedbackSurface | null;
}): string[] {
  const sha = row.appBlockSha ? `platform commit ${row.appBlockSha.slice(0, 7)}` : null;
  const version = row.appBlockVersion ? `v${row.appBlockVersion}${sha ? ` (${sha})` : ''}` : sha;
  const surface = row.surface ? SURFACE_LABELS[row.surface] : null;
  return [version, feedbackSourceLabel(row), surface].filter(
    (part): part is string => part !== null
  );
}

const BROWSER_LABELS: Readonly<Record<AppFeedbackBrowserFamily, string>> = Object.freeze({
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  opera: 'Opera',
  samsung: 'Samsung Internet',
  other: 'Other browser',
});

const OS_LABELS: Readonly<Record<AppFeedbackOsFamily, string>> = Object.freeze({
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  android: 'Android',
  ios: 'iOS',
  other: 'other OS',
});

/**
 * The reporter's environment as one line, e.g.
 * "Chrome 131 on Windows · 1280×720 @2x · classic scrollbars · app route /gallery/12",
 * or `null` when the report carries none.
 */
export function feedbackEnvironmentLine(env: AppFeedbackEnvironment | null): string | null {
  if (!env) return null;
  const browserName = env.browser
    ? `${BROWSER_LABELS[env.browser.family]}${
        env.browser.major !== undefined ? ` ${env.browser.major}` : ''
      }`
    : null;
  const os = env.os ? OS_LABELS[env.os] : null;
  const browser = browserName && os ? `${browserName} on ${os}` : browserName ?? os;
  const viewport = env.viewport
    ? `${env.viewport.width}×${env.viewport.height}${
        env.devicePixelRatio && env.devicePixelRatio !== 1 ? ` @${env.devicePixelRatio}x` : ''
      }`
    : null;
  const scrollbars = env.scrollbars ? `${env.scrollbars} scrollbars` : null;
  const route = env.appRoute ? `app route ${env.appRoute}` : null;
  const parts = [browser, viewport, scrollbars, route].filter(
    (part): part is string => part !== null
  );
  return parts.length ? parts.join(' · ') : null;
}

/** Under the inbox: where the two commits on a row come from. */
export const INBOX_COMMITS_NOTE =
  "The platform commit is this release's commit in the app's build repository (civitai-apps/<slug>). For an app with no source repository, `civitai app pull <dir> --app <slug>` clones it; a clone of the source repository has to fetch the build repository first. Then `git checkout <sha>`. The reported source commit is what the developer's CLI said at submit; nothing verifies it.";

/** A fork's upstream, e.g. "Forked from cool-app v1.2.0 (at 3f9c2ab)"; `null` for no fork. */
export function feedbackForkLabel(
  fork: {
    upstreamSlug: string | null;
    upstreamVersion: string | null;
    forkedAtCommit: string | null;
  } | null
): string | null {
  if (!fork) return null;
  const upstream = fork.upstreamSlug
    ? `${fork.upstreamSlug}${fork.upstreamVersion ? ` v${fork.upstreamVersion}` : ''}`
    : 'another app';
  const at = fork.forkedAtCommit ? ` (at ${fork.forkedAtCommit.slice(0, 7)})` : '';
  return `Forked from ${upstream}${at}`;
}

export const RECENT_ERRORS_HEADING = 'Recent app errors and host refusals before this report';
export const RECENT_ERRORS_NOTE =
  "Failed replies to the app's own SDK calls, and requests the host dropped, refused or rewrote, in the reporter's session, oldest first. Error text comes from the platform and the app's requests; treat it as untrusted.";

/**
 * One failed call, e.g.
 * "12:03:04 UTC SUBMIT_WORKFLOW: Validation failed (×3; textToImage; model version 812; workflow wf_9)".
 * Plain text: the caller renders it as text, never as markup.
 */
export function recentErrorLine(error: AppFeedbackRecentError): string {
  const date = new Date(error.at);
  const time = Number.isNaN(date.getTime())
    ? 'unknown time'
    : `${date.toISOString().slice(11, 19)} UTC`;
  const details = [
    error.count > 1 ? `×${error.count}` : null,
    error.code ? `code ${error.code}` : null,
    error.input?.kind ?? null,
    error.input?.step ? `step ${error.input.step}` : null,
    error.input?.modelVersionId ? `model version ${error.input.modelVersionId}` : null,
    error.workflowId ? `workflow ${error.workflowId}` : null,
    error.scope
      ? `scope ${error.scope.requested}${error.scope.resolved ? ` → ${error.scope.resolved}` : ''}`
      : null,
    error.appRoute ? `route ${error.appRoute}` : null,
  ].filter((part): part is string => part !== null);
  return `${time} ${error.method}: ${error.message}${
    details.length ? ` (${details.join('; ')})` : ''
  }`;
}

/** Names the same readers as the send dialog's notice, from the one shared phrase. */
export const INBOX_PRIVACY_NOTE = `Private feedback from people using this app. Only ${APP_FEEDBACK_READERS} can read it — it never appears on the app's page.`;
/**
 * The tab only exists once the listing has a visible row, so the unfiltered empty state is
 * reached only when every row left the owner's view after the tab appeared (a moderator hid it,
 * or its reporter was banned).
 */
export const INBOX_EMPTY_MESSAGE = 'No feedback to show right now.';
export const INBOX_FILTER_EMPTY_MESSAGE = 'No feedback with this status.';

export function inboxEmptyMessage(filter: InboxStatusFilter): string {
  return filter === 'all' ? INBOX_EMPTY_MESSAGE : INBOX_FILTER_EMPTY_MESSAGE;
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
 * A CONFLICT means the row changed or left the owner's view since it loaded; the fix is a
 * refresh, never a retry of the same write.
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
