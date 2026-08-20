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

/** Human label for a listing kind. */
export function listingKindLabel(kind: string): string {
  return kind === 'onsite' ? 'On-site' : 'External';
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
