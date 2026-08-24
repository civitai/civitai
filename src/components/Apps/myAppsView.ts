import type { EditorTab } from '~/components/Apps/appListingEditorTabs';
import { editorTabsFor, listingEditHref } from '~/components/Apps/appListingEditorTabs';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import type { ListingProblem } from '~/server/services/blocks/listing-problems';
import type {
  AppRole,
  ListingCapability,
  ListingKind,
} from '~/shared/constants/app-capabilities.constants';

/**
 * `/apps/mine` — the pure view-model behind the ONE merged author table.
 *
 * Kept out of the component for the usual reason: the rules below are the ones a naive
 * re-merge gets wrong, and they are only provable without mounting a table if they are
 * functions. This module lives in the **`unit`** vitest project (`src/**\/*.test.ts`),
 * which is the tier that actually gates, unlike the browser-mode `component` project.
 */

/**
 * The container width. Alias-with-a-consumer, the same shape as
 * `LISTING_STORE_CONTAINER_SIZE` — `appsPageWidths.test.ts` recognises the pattern and
 * checks the page really reads it.
 */
export const MY_APPS_CONTAINER_SIZE: number = APPS_PAGE_WIDTHS['/apps/mine'];

/** Rows per page in the Inactive collapse. */
export const INACTIVE_PAGE_SIZE = 10;

/**
 * 🔴 THE INACTIVE SET IS LISTING-LEVEL AND TERMINAL. NOTHING ELSE.
 *
 * These are the two `app_listings.status` values an app cannot come back from on its own:
 * a moderator `removed` it, or the listing itself was `rejected`. Everything else —
 * `draft`, `pending`, `approved` — is ACTIVE and belongs in the main table.
 *
 * 🔴 A SUBMISSION STATUS IS NOT A LISTING STATUS, and conflating them is the specific bug
 * this constant exists to prevent. The two enums are DISJOINT: `app_listings.status` is
 * `{draft, pending, approved, rejected, removed}` and has NO `withdrawn`; a publish
 * request's status is `{pending, approved, rejected, withdrawn}` and has NO `removed`. So
 * a `withdrawn` submission on an `approved` app says nothing about the app — the app is
 * live, the author merely pulled one request. Putting `'withdrawn'` in this list would
 * hide healthy, published apps from their own owners; production carries 33 withdrawn
 * block requests and 4 withdrawn listing requests against 0 rejected listings, so the
 * mistake would be far louder than the state it was meant to model.
 *
 * The partition therefore reads the LISTING ROW's status and never looks at history.
 */
export const INACTIVE_LISTING_STATUSES = ['rejected', 'removed'] as const;
export type InactiveListingStatus = (typeof INACTIVE_LISTING_STATUSES)[number];

/** Is this LISTING status one the Inactive collapse owns? */
export function isInactiveListing(status: string): boolean {
  return (INACTIVE_LISTING_STATUSES as readonly string[]).includes(status);
}

/** The client's copy of one `appListings.listMine` row. */
export type MyAppRow = {
  appListingId: string;
  slug: string;
  name: string;
  /** `draft|pending|approved|rejected|removed` — the LISTING's own status. */
  status: string;
  kind: ListingKind;
  appBlockId: string | null;
  role: AppRole;
  capabilities: Readonly<Record<ListingCapability, boolean>>;
  iconUrl: string | null;
  coverUrl: string | null;
  updatedAt: string | Date;
  /**
   * The listing's most-recent moderation-event action — `owner-unpublish` when the OWNER
   * took it down, a moderator action (`delist`/`purge`/…) otherwise.
   *
   * 🔴 ONLY MEANINGFUL WHEN `status === 'removed'`, and it is the only thing that separates
   * "I unpublished this and may put it back" from "a moderator removed this and only a
   * moderator can restore it". `status` alone reads `removed` for both. Optional on the type
   * so a fixture need not spell it; absent is read as a moderator removal, which is the safe
   * direction (it withholds a button the server would refuse rather than inventing one).
   */
  lastModerationAction?: string | null;
  /**
   * The listing-completeness advisory (missing icon / cover / screenshots / description /
   * tagline / category), computed server-side by `computeListingProblems`.
   *
   * 🔴 THIS TABLE IS THE ADVISORY'S ONLY HOME NOW. It rendered on the two
   * `/apps/my-submissions` tables, which lost their importer when that page merged here.
   * Optional on the type so a fixture need not spell it, never optional in the payload.
   */
  problems?: ListingProblem[];
};

/**
 * Split the caller's apps into the main table and the Inactive collapse.
 *
 * 🔴 IT READS `status` AND NOTHING ELSE. Not the row's history, not a submission status,
 * not a derived "looks dead" heuristic — see {@link INACTIVE_LISTING_STATUSES}. Order
 * within each group is preserved, so the caller sorts once and partitions after.
 */
export function partitionMyAppRows<T extends { status: string }>(
  rows: readonly T[]
): { active: T[]; inactive: T[] } {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const row of rows) (isInactiveListing(row.status) ? inactive : active).push(row);
  return { active, inactive };
}

/** Milliseconds since epoch, or 0 for anything unparseable (never NaN — see below). */
function updatedAtMs(value: string | Date | null | undefined): number {
  if (value == null) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  // 🔴 NaN would make every comparison involving this row return false, so `sort` would
  // leave the array in an order that depends on the engine's algorithm rather than on the
  // data. 0 is a real, orderable answer: "we do not know when, so treat it as oldest".
  return Number.isFinite(t) ? t : 0;
}

/**
 * Newest-updated first, with the id as a stable tiebreak.
 *
 * The server orders by `serialId desc` (newest LISTING first) because that keyset is what
 * makes its `take: limit` deterministic. "Recently updated" is a different question and is
 * answered here, on the page that asks it.
 */
export function sortByRecentlyUpdated<T extends { updatedAt: string | Date; appListingId: string }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort((a, b) => {
    const diff = updatedAtMs(b.updatedAt) - updatedAtMs(a.updatedAt);
    if (diff !== 0) return diff;
    return a.appListingId < b.appListingId ? -1 : a.appListingId > b.appListingId ? 1 : 0;
  });
}

/** Number of pages the Inactive collapse needs. Always ≥ 1 so the control has a state. */
export function pageCount(total: number, pageSize: number = INACTIVE_PAGE_SIZE): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * The rows on `page` (1-based). Clamps out-of-range pages rather than returning `[]`, so a
 * shrinking list (an app leaves the inactive set) cannot strand the user on a blank page.
 */
export function pageSlice<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = INACTIVE_PAGE_SIZE
): T[] {
  if (pageSize <= 0) return [...rows];
  const clamped = Math.min(Math.max(Math.trunc(page), 1), pageCount(rows.length, pageSize));
  const start = (clamped - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/** Mantine colour for a LISTING status badge. */
export function listingStatusColor(status: string): string {
  switch (status) {
    case 'approved':
      return 'green';
    case 'pending':
      return 'blue';
    case 'draft':
      return 'gray';
    case 'rejected':
      return 'red';
    case 'removed':
      return 'orange';
    default:
      return 'gray';
  }
}

/** Mantine colour for one HISTORY entry's status badge (the request enum, not the row's). */
export function historyStatusColor(status: string): string {
  switch (status) {
    case 'approved':
      return 'green';
    case 'pending':
      return 'blue';
    case 'rejected':
      return 'red';
    case 'withdrawn':
      return 'gray';
    default:
      return 'gray';
  }
}

/**
 * 🔴 `listingKindLabel` USED TO LIVE HERE AND IS GONE ON PURPOSE. Do not re-add it.
 *
 * It was a second, DIVERGENT implementation of the App-store kind label (it returned
 * `'On-site' | 'External'`) whose NAME COLLIDED with the canonical
 * `~/components/Apps/listingKindLabels`' export of the same name. The collision is
 * what made the drift invisible: `MyAppsBody` imported the local one, the import line
 * read exactly like the enrolled one, and the ledger's own SHRINKS rule could not see
 * it because this page was never enrolled. That is how `/apps/mine` kept rendering
 * the retired word "External" straight through the #4247 wording sweep.
 *
 * `/apps/mine` no longer renders a kind at all (see `MyAppsBody`'s `StatusBadges`),
 * so there is no caller to re-point at the canonical module — the function is
 * DELETED rather than left dead. Any future surface that needs the word imports
 * `LISTING_KIND_LABELS` / `listingKindLabel` from `listingKindLabels` and enrols in
 * `__tests__/standaloneWordingCallSites.test.ts`.
 */

/** Which of a row's two images a click was on. Positional, not URL-keyed — see below. */
export type MyAppMediaKind = 'cover' | 'icon';

/**
 * The row's images as a VIEWER LIST — `[cover, icon]`, absent entries skipped.
 *
 * 🔴 ONE LIST FOR BOTH IMAGES, so prev/next works. Opening each image in its own
 * single-entry modal is the shape that looks right and is worse: the viewer's arrows
 * would be permanently disabled and the `N / M` counter would always read `1 / 1`.
 *
 * 🔴 COVER FIRST. The order is the ONE thing `listingMediaIndex` depends on, so it is
 * stated here rather than inferred at the call site — the two functions are a pair and
 * a disagreement between them opens the wrong picture with nothing erroring.
 *
 * The captions are what give the viewer's `<img>` its accessible name: the viewer sets
 * `alt=""` whenever a caption is present (the caption is rendered as visible text
 * beside it), so an empty caption here would leave the image unnamed.
 */
export function listingMediaShots(
  row: Pick<MyAppRow, 'name' | 'iconUrl' | 'coverUrl'>
): { url: string; caption: string | null }[] {
  const shots: { url: string; caption: string | null }[] = [];
  if (row.coverUrl) shots.push({ url: row.coverUrl, caption: `${row.name} cover image` });
  if (row.iconUrl) shots.push({ url: row.iconUrl, caption: `${row.name} icon` });
  return shots;
}

/**
 * Where `which` sits in {@link listingMediaShots}, or `null` when that image is absent.
 *
 * 🔴 POSITIONAL, NOT A URL LOOKUP. A `findIndex` on the url would collapse the two
 * entries whenever a listing's icon and cover happen to be the SAME url — clicking the
 * icon would open the cover. `null` is the signal that there is nothing to view, which
 * is what keeps a placeholder inert.
 */
export function listingMediaIndex(
  row: Pick<MyAppRow, 'iconUrl' | 'coverUrl'>,
  which: MyAppMediaKind
): number | null {
  if (which === 'cover') return row.coverUrl ? 0 : null;
  if (!row.iconUrl) return null;
  return row.coverUrl ? 1 : 0;
}

/**
 * Is this orphaned submission one the author can DO something about?
 *
 * Two shapes, and each is a call to action rather than a status: a REJECTION REASON is
 * the only text on the whole record telling the developer what to change, and a
 * PENDING request the server says this caller may withdraw is a decision still open to
 * them. Everything else — an approved-and-superseded request, an already-withdrawn
 * one, a rejection with no reason attached — is history.
 */
export function isActionableOrphan(row: {
  status: string;
  rejectionReason: string | null;
  canWithdraw?: boolean;
}): boolean {
  if ((row.rejectionReason ?? '').trim().length > 0) return true;
  return row.status === 'pending' && row.canWithdraw === true;
}

/**
 * Does the "Submissions without a listing" group start OPEN?
 *
 * 🔴 THIS IS WHAT PRESERVES THE GROUP'S ORIGINAL GUARANTEE while collapsing it. See
 * `OrphanedSubmissionsSection`'s header for the measured reason the group must not
 * simply be hidden behind a toggle.
 */
export function orphanGroupStartsOpen(
  rows: readonly { status: string; rejectionReason: string | null; canWithdraw?: boolean }[]
): boolean {
  return rows.some(isActionableOrphan);
}

/**
 * 🔴 THE ROW LINKS TO A TAB THE ROW'S OWN KIND AND CAPABILITIES ALLOW.
 *
 * Moved here verbatim from `MyAppListingsPanel` (which the merged table replaces) so the
 * href derivation stays PER-ROW rather than being flattened into one unconditional
 * `/edit` link. `editorTabsFor` is the single derivation, so a row can never deep-link an
 * off-site listing at `?tab=manifest`.
 *
 * 🔴 STATED HONESTLY, as it was before: `tabs[0]` is `'details'` for every shape today,
 * because Details is the one tab every kind and role can always open. So this call cannot
 * currently produce a kind-specific href, and a test asserting "never `?tab=manifest` for
 * off-site" would pass whatever the capability table said. It is written this way so it
 * STAYS correct if the first tab ever becomes conditional. The real kind-derivation guard
 * is `appListingEditorTabs.test.ts`.
 */
export function myAppListingHref(row: {
  appListingId: string;
  kind: ListingKind;
  appBlockId: string | null;
  role: AppRole;
  capabilities: Readonly<Record<ListingCapability, boolean>>;
}): string {
  const tabs: EditorTab[] = editorTabsFor({
    kind: row.kind,
    appBlockId: row.appBlockId,
    role: row.role,
    capabilities: row.capabilities,
  });
  return listingEditHref(row.appListingId, tabs[0]);
}
