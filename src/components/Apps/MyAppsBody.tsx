import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Collapse,
  Group,
  Loader,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconApps,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { ListingProblemsIndicator } from '~/components/Apps/ListingProblemsIndicator';
import { showModRemovedNotice } from '~/components/Apps/listingPublishingActions';
import { AppListingScreenshotViewer } from '~/components/Apps/AppListingScreenshotViewer';
import {
  NO_BROKEN_SCREENSHOTS,
  withBrokenIndex,
  type BrokenScreenshotIndexes,
} from '~/components/Apps/appListingScreenshotNav';
import type { MyAppMediaKind, MyAppRow } from '~/components/Apps/myAppsView';
import {
  historyStatusColor,
  listingMediaIndex,
  listingMediaShots,
  listingStatusColor,
  myAppListingHref,
  orphanGroupStartsOpen,
  pageCount,
  pageSlice,
  partitionMyAppRows,
  sortByRecentlyUpdated,
} from '~/components/Apps/myAppsView';
import { ownerListingState, ownerStateChip } from '~/components/Apps/offsiteOwnerControls';
import { AppsTableColgroup, APPS_MINE_COLUMNS } from '~/components/Apps/appsWideLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { canOpenListingAuthoringPage } from '~/shared/constants/app-capabilities.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * `/apps/mine` — THE author's single view of every app they can act on.
 *
 * 🔴 THIS PAGE ABSORBED `/apps/my-submissions`, AND THE DIRECTION OF THE MERGE IS THE
 * WHOLE POINT. That page listed PUBLISH REQUESTS scoped to `submittedByUserId`, which
 * answers "what did I submit" — not "what do I own" and not "what do I hold a seat on". A
 * collaborator has submitted nothing, so it was empty for them; an owner who acquired a
 * listing by TRANSFER or by a moderator `claimListing` lost it there too, because the row
 * keeps the original submitter's id forever. This page reads `appListings.listMine`
 * (→ `listMyAppListings` → `resolveAccessibleListingIds`), which resolves ownership
 * canonically and unions accepted seats. **The row set MUST stay that read.** Re-deriving
 * it from a submissions query is the regression, and it is silent — the page still renders,
 * just without the apps those two populations own.
 *
 * Row identity is one row per APP.
 *
 * 🔴 A ROW IS A LISTING AND ITS LINK — the History disclosure and the owner
 * Unpublish/Republish pair BOTH MOVED to the canonical authoring page's History and
 * Publishing tabs. Do not bring either back here: two homes for one control is how the two
 * come to disagree, and a publish request is an EVENT on an app, which belongs on the app's
 * own page rather than nested in a list row. What stays is the row's LINK, which now points
 * at the tab that exists for that row (`myAppListingHref` → `editorTabsFor`), and the
 * "Submissions without a listing" group — the one population with no listing and therefore
 * no authoring page to move to.
 */

/** One row of `appListings.listMyOrphanedSubmissions` — a submission with no listing. */
export type OrphanedSubmissionRow = {
  id: string;
  slug: string;
  version: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  canWithdraw?: boolean;
};

/** Fixed media boxes. Both dimensions are attributes on the `img`, so the row reserves its
 *  space before the bytes arrive — a table with two images per row is otherwise a CLS
 *  machine. The placeholder uses the SAME box, so present and absent media never reflow. */
const ICON_BOX = 40;
const COVER_W = 96;
const COVER_H = 54; // 16:9

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return formatDate(value, 'MMM D, YYYY');
}

/**
 * 🔴 THE CLICK TARGET IS A REAL `<button>`, AND THE PLACEHOLDER IS NOT ONE.
 *
 * Both media components below wrap their image in `UnstyledButton` — which renders a
 * real `<button type="button">`, so it is tab-reachable, Enter/Space-activatable and
 * carries a focus ring. An `<img onClick>` would be a mouse-only affordance that LOOKS
 * wired up; the screenshot gallery this viewer is shared with learned that already
 * (`appListingScreenshotViewerWiring.test.ts`'s "the tile is a real button").
 *
 * 🔴 NOT Mantine `Anchor`. Its root sets `color: var(--mantine-color-anchor)`, which
 * recolours every `currentColor` descendant — including the "No cover" glyph inside the
 * placeholder. That bug is INVISIBLE on the has-image path (an `<img>` ignores `color`)
 * and only appears on the no-image path, which is the path that must not be a link at
 * all. It is also not a navigation: nothing gets an href.
 *
 * 🔴 A PLACEHOLDER IS INERT — no button, no `tabIndex`, no pointer cursor. There is
 * nothing to view, and a focusable control that opens an empty modal is worse than no
 * control: it adds a tab stop to every row of a table whose rows are mostly incomplete
 * listings (measured: all 11 `removed` listings have a null cover).
 */
function MediaButton({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      onClick={onOpen}
      aria-label={label}
      // `display: flex` so the button box is exactly the image box — a default
      // `display: block` UnstyledButton would add descender space under the image and
      // make the focus ring taller than the thing it is outlining.
      style={{ display: 'flex', cursor: 'zoom-in', borderRadius: 8 }}
    >
      {children}
    </UnstyledButton>
  );
}

function ListingIcon({
  row,
  onOpenMedia,
}: {
  row: MyAppRow;
  onOpenMedia?: (row: MyAppRow, which: MyAppMediaKind) => void;
}) {
  if (!row.iconUrl) {
    return (
      <div
        data-testid={`apps-mine-icon-placeholder-${row.appListingId}`}
        aria-hidden
        style={{
          width: ICON_BOX,
          height: ICON_BOX,
          borderRadius: 8,
          flex: `0 0 ${ICON_BOX}px`,
          background: 'var(--mantine-color-dark-4)',
        }}
      />
    );
  }
  const img = (
    // 🔴 A PLAIN `<img>`, NOT `next/image`. The server already hands us a CDN-transformed
    // URL (`getEdgeUrl(..., { width })`), so `next/image` would put a SECOND optimizer in
    // front of an already-optimized asset — extra cost, no smaller bytes. The two things
    // `next/image` is usually reached for here are supplied directly: explicit
    // `width`/`height` attributes reserve the box (no CLS on a table with two images per
    // row) and `loading="lazy"` defers the off-screen ones.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid={`apps-mine-icon-${row.appListingId}`}
      src={row.iconUrl}
      alt=""
      width={ICON_BOX}
      height={ICON_BOX}
      loading="lazy"
      decoding="async"
      style={{ borderRadius: 8, objectFit: 'cover', flex: `0 0 ${ICON_BOX}px` }}
    />
  );
  if (!onOpenMedia) return img;
  return (
    <MediaButton label={`View icon image for ${row.name}`} onOpen={() => onOpenMedia(row, 'icon')}>
      {img}
    </MediaButton>
  );
}

function ListingCover({
  row,
  onOpenMedia,
}: {
  row: MyAppRow;
  onOpenMedia?: (row: MyAppRow, which: MyAppMediaKind) => void;
}) {
  if (!row.coverUrl) {
    return (
      <div
        data-testid={`apps-mine-cover-placeholder-${row.appListingId}`}
        style={{
          width: COVER_W,
          height: COVER_H,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--mantine-color-dark-5)',
        }}
      >
        <Text size="9px" c="dimmed">
          No cover
        </Text>
      </div>
    );
  }
  const img = (
    // Plain `<img>` for the same reason as the icon above — the URL is already a
    // width-transformed CDN URL, and the CLS/lazy properties are set explicitly.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid={`apps-mine-cover-${row.appListingId}`}
      src={row.coverUrl}
      alt=""
      width={COVER_W}
      height={COVER_H}
      loading="lazy"
      decoding="async"
      style={{ borderRadius: 6, objectFit: 'cover' }}
    />
  );
  if (!onOpenMedia) return img;
  return (
    <MediaButton
      label={`View cover image for ${row.name}`}
      onOpen={() => onOpenMedia(row, 'cover')}
    >
      {img}
    </MediaButton>
  );
}

/**
 * The app's NAME — a link to the authoring page.
 *
 * 🔴 IT IS NOW A LINK ON EVERY ROW WHOSE STATUS THE ROUTE OPENS ON, INCLUDING A REMOVED OR
 * REJECTED ONE, and that reversal is load-bearing rather than cosmetic. It used to be plain
 * text on any non-authorable status because `getAppListingAuthoringContext` refused those
 * with FORBIDDEN — linking there offered a guaranteed 403. That route now opens on them in
 * a NARROWED mode (at most Publishing + History; no Details, no Collaborators), and this PR
 * moved BOTH the History disclosure and the Unpublish/Republish pair off this row and into
 * that page. So the link is the only way the author reaches either one, and leaving a
 * REMOVED row unlinked would strand exactly the population that most needs its history.
 *
 * 🔴 `rejected` RIDES ALONG AS A FAIL-SAFE, NOT AS A SERVED POPULATION. Nothing writes
 * `AppListing.status = 'rejected'` (measured across all 33 `appListing` write sites: an
 * on-site reject deletes the draft listing, an off-site reject writes `removed`). The value
 * is in the DB CHECK and legacy rows may carry it, so linking it is correct — but the
 * rescue argument above is about `removed` alone. Rejected FIRST VERSIONS are served by the
 * orphan group further down this page, which is deliberately untouched by this PR.
 *
 * 🔴 IT DELIBERATELY DOES **NOT** READ `role`, AND AN EARLIER DRAFT OF THIS FILE DID — on a
 * premise that was simply false. That draft withheld the link from a seated EDITOR on a
 * removed listing, justified as "the page would refuse them". It does not:
 * `resolveListingAccess` returns `role:'editor'` for any accepted seat REGARDLESS of the
 * listing's status, and `getAppListingAuthoringContext` refuses only on a missing role or a
 * status the route does not open on — neither of which fires there. The server serves that
 * editor a History-only page, exactly as `editorTabsFor` says it does. So the role clause
 * was not a mirror of a server gate; it was an unannounced REGRESSION, because
 * pre-PR the row's History toggle rendered unconditionally and a seated editor could open a
 * removed app's history from here. Withholding the link now would leave them no route at
 * all short of typing the URL.
 *
 * The predicate is therefore `canOpenListingAuthoringPage` itself, called directly rather
 * than wrapped: one rule, one place, and no second name to drift from it.
 */
function ListingName({ row }: { row: MyAppRow }) {
  if (canOpenListingAuthoringPage(row.status)) {
    return (
      <Link href={myAppListingHref(row)} data-testid={`apps-mine-link-${row.appListingId}`}>
        <Text fw={600}>{row.name}</Text>
      </Link>
    );
  }
  return (
    <Text fw={600} c="dimmed" data-testid={`apps-mine-unlinked-${row.appListingId}`}>
      {row.name}
    </Text>
  );
}

/**
 * 🔴 THERE IS NO KIND BADGE HERE, AND ITS ABSENCE IS THE DECISION.
 *
 * `/apps/mine` used to render one (testid `apps-mine-kind-<id>`). It is DELETED: the
 * author already knows what they built, the word cost a badge slot in a row that also
 * carries role, status and the completeness advisory, and the page is not where anyone
 * looks the kind up. The kind still renders on the listing DETAIL page
 * (`appListingDetailRows`' "Kind" row) and on the edit surface, which are the places
 * that answer a question about it.
 *
 * 🔴 SO THIS FILE IS DELIBERATELY **NOT** ENROLLED in
 * `__tests__/standaloneWordingCallSites.test.ts`. Enrolling it would assert that it
 * resolves the kind word from the one source — a claim that is only meaningful for a
 * surface that renders one. The absence is pinned instead, by
 * `MyAppsBody.browser.test.tsx`'s "no row shape renders a kind badge", so a future
 * "helpfully restore the badge" change is visible rather than silent.
 */
function StatusBadges({ row }: { row: MyAppRow }) {
  return (
    /*
     * 🔴 THIS ROW MAY WRAP, AND THAT IS THE STRUCTURAL HALF OF A LAYOUT FIX — NOT A
     * COSMETIC PREFERENCE. It was `wrap="nowrap"`, and in the table layout that made the
     * badges paint ON TOP of the Updated column at every viewport ≤ 1440 (measured, last
     * badge's right minus the date's left: +22px at 1280, +13 at 1366, +6 at 1440).
     *
     * The mechanism, because "make it wrap" is not self-evidently the cure. Under
     * automatic table layout a column with a specified width is still floored at its
     * cell's MIN-CONTENT width, which is what normally expands a column whose content
     * does not fit. Here that floor lied: Mantine's `Badge` sets `overflow: hidden`, so
     * as a flex item its automatic minimum size collapses, and this cell reported a
     * min-content of 78px while a `flex-shrink: 0` badge row actually painted 185.17px.
     * `<td>` is `overflow: visible`, so the 60px that did not fit was not clipped — it was
     * drawn over the next cell.
     *
     * Allowing the row to wrap makes the min-content honest (the widest single badge
     * rather than a number no layout can produce), so the cell can never paint outside
     * itself again REGARDLESS of the ledger. The ledger's Status share (18%, see
     * `APPS_MINE_COLUMNS`) is the other half and does a different job: it keeps the
     * ordinary two-badge row on ONE line from 1280 up. The long case — "Collaborator" plus
     * "removed by a moderator" plus the advisory — is ~307px and no percentage that is
     * also sane at 2560 can hold it on one line; with wrapping it reflows instead of
     * overlapping, which is the point of keeping both halves.
     */
    <Group gap={6}>
      {/* 🔴 The role badge is not decoration: an editor cannot invite, remove or transfer,
          so saying which one they are is what makes the missing controls legible rather
          than looking broken. */}
      <Badge
        variant="filled"
        color={row.role === 'owner' ? 'teal' : 'indigo'}
        data-testid={`apps-mine-role-${row.appListingId}`}
      >
        {row.role === 'owner' ? 'Owner' : 'Collaborator'}
      </Badge>
      {/*
        🔴 A REMOVED LISTING'S BADGE SAYS *WHO* REMOVED IT. `status` reads `removed` for an
        owner self-unpublish and for a moderator takedown alike, which is precisely the
        distinction the author needs — one of those they can undo themselves and the other
        they cannot. `ownerStateChip` returns null for every other state, so the normal
        status badge is unchanged there. Same override the off-site and on-site submissions
        lists apply, from the same function.
      */}
      {(() => {
        const chip = ownerStateChip(
          ownerListingState({
            listingStatus: row.status,
            lastModerationAction: row.lastModerationAction,
          })
        );
        return (
          <Badge
            variant="outline"
            color={chip ? chip.color : listingStatusColor(row.status)}
            data-testid={`apps-mine-status-${row.appListingId}`}
          >
            {chip ? chip.label : row.status}
          </Badge>
        );
      })()}
      {/*
        🔴 THE COMPLETENESS ADVISORY'S ONLY REMAINING HOME. It hung off the two
        `/apps/my-submissions` tables, which lost their importer when that page merged
        here — so without this the author stops being told that the icon, cover,
        screenshots, description, tagline or category are missing. It is also what makes
        `listingCoverUrl`'s "no screenshot fallback, the author must see the gap"
        rationale true rather than merely asserted: that comment cites this warning.
      */}
      <span data-testid={`apps-mine-problems-${row.appListingId}`}>
        <ListingProblemsIndicator problems={row.problems ?? []} />
      </span>
    </Group>
  );
}

/**
 * "Removed by a moderator" — a STATEMENT, not an action, which is why it is not in the
 * ledger's action set and why it renders for a collaborator too.
 *
 * 🔴 IT EXISTS SO THE MISSING BUTTON IS LEGIBLE. An owner-unpublished row and a
 * moderator-removed row differ only by the presence of Republish; without this line the
 * second one is an empty cell, and an empty cell is what a dropped control looks like.
 */
function ModRemovedNotice({ row }: { row: MyAppRow }) {
  if (!showModRemovedNotice(row)) return null;
  return (
    /*
     * 🔴 IT STATES THE CONSEQUENCE, NOT A CAUSE, AND THE DIFFERENCE IS TRUTH. An earlier
     * wording read "Removed by a moderator — contact them to restore it", which asserts WHO
     * removed the app. That is not what this state means: the server's guard refuses an owner
     * republish whenever the newest moderation event is anything other than `owner-unpublish`,
     * and `resolveReport`/`dismissReport` write event rows too. So an owner who unpublishes
     * their own app and then has a pre-existing report closed by a moderator lands here — the
     * refusal is real and the mirror is faithful, but nobody removed their app. The sentence
     * now says only the part that is true in every case that reaches it.
     *
     * (The `removed by a moderator` BADGE has the same problem and is deliberately untouched:
     * it comes from the shared `ownerStateChip`, which the off-site and on-site submissions
     * lists also render. Rewording it is a cross-surface copy change, not this PR's.)
     */
    <Text size="xs" c="red" data-testid={`apps-mine-mod-removed-${row.appListingId}`}>
      Only a moderator can restore this listing.
    </Text>
  );
}

/**
 * 🔴 A ROW IS NOW A LISTING AND ITS LINK — NOTHING ELSE. The History disclosure and the
 * Unpublish/Republish pair both moved to `/apps/listing/<id>/edit`, so a row carries no
 * per-row query, no expansion state and no mutation. That is why `expanded`/`onToggle`/
 * `history*`/`onWithdraw`/`onUnpublish`/`onRepublish` are gone from this type rather than
 * being threaded through unused.
 */
type RowRenderProps = {
  row: MyAppRow;
  group: 'active' | 'inactive';
  /** Open the row's image viewer at the image that was clicked. */
  onOpenMedia?: (row: MyAppRow, which: MyAppMediaKind) => void;
};

function rowTestId(group: 'active' | 'inactive', appListingId: string): string {
  return group === 'active'
    ? `apps-mine-row-${appListingId}`
    : `apps-mine-inactive-row-${appListingId}`;
}

/** Desktop: one `<tr>`. */
function AppTableRow(props: RowRenderProps) {
  const { row, group } = props;
  return (
    <>
      <Table.Tr data-testid={rowTestId(group, row.appListingId)}>
        <Table.Td>
          <Group gap="sm" wrap="nowrap">
            <ListingIcon row={row} onOpenMedia={props.onOpenMedia} />
            <Stack gap={0}>
              <ListingName row={row} />
              <Text size="xs" c="dimmed">
                {row.slug}
              </Text>
            </Stack>
          </Group>
        </Table.Td>
        <Table.Td>
          <ListingCover row={row} onOpenMedia={props.onOpenMedia} />
        </Table.Td>
        <Table.Td>
          <Stack gap={4} align="flex-start">
            <StatusBadges row={row} />
            <ModRemovedNotice row={row} />
          </Stack>
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {formatWhen(row.updatedAt)}
          </Text>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

/**
 * Mobile: the SAME row as a card.
 *
 * 🔴 A CARD, NOT A HORIZONTALLY-SCROLLING TABLE. Two images per row makes the table's
 * natural width far wider than a phone, and the alternative to reflowing is a side-scroll
 * that hides the status and the controls off-screen. Exactly ONE of the two layouts is
 * rendered (the container picks with `useMediaQuery`, the View takes it as a prop), so
 * there is never a duplicate copy of a row in the DOM.
 */
function AppCardRow(props: RowRenderProps) {
  const { row, group } = props;
  return (
    <Paper withBorder p="sm" radius="md" data-testid={rowTestId(group, row.appListingId)}>
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ListingIcon row={row} onOpenMedia={props.onOpenMedia} />
          <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
            <ListingName row={row} />
            <Text size="xs" c="dimmed">
              {row.slug}
            </Text>
          </Stack>
          <ListingCover row={row} onOpenMedia={props.onOpenMedia} />
        </Group>
        <StatusBadges row={row} />
        <ModRemovedNotice row={row} />
        <Text size="xs" c="dimmed">
          Updated {formatWhen(row.updatedAt)}
        </Text>
      </Stack>
    </Paper>
  );
}

function AppGroup({
  rows,
  group,
  compact,
  testId,
  renderRow,
}: {
  rows: MyAppRow[];
  group: 'active' | 'inactive';
  compact: boolean;
  testId: string;
  renderRow: (row: MyAppRow, group: 'active' | 'inactive') => RowRenderProps;
}) {
  if (compact) {
    return (
      <Stack gap="xs" data-testid={testId}>
        {rows.map((row) => (
          <AppCardRow key={row.appListingId} {...renderRow(row, group)} />
        ))}
      </Stack>
    );
  }
  return (
    <Card withBorder p={0} data-testid={testId}>
      <Table verticalSpacing="sm" horizontalSpacing="md">
        {/*
          🔴 FIRST CHILD, BEFORE the row groups — HTML requires it there; the ordering is
          pinned by `__tests__/appsWideLayout.test.ts`. `App` carries the icon, the name and
          the slug and is the ledger's primary column, so the container's surplus width
          lands there instead of being distributed as padding across four columns.
        */}
        <AppsTableColgroup columns={APPS_MINE_COLUMNS} />
        <Table.Thead>
          <Table.Tr>
            <Table.Th data-testid="apps-mine-col-app">App</Table.Th>
            <Table.Th>Cover</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Updated</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <AppTableRow key={row.appListingId} {...renderRow(row, group)} />
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

export type MyAppsBodyViewProps = {
  rows: MyAppRow[];
  isLoading?: boolean;
  errorMessage?: string | null;
  /** Render the card layout. Injected rather than measured so tests are deterministic. */
  compact?: boolean;
  /**
   * Is the VERSION-withdraw mutation reachable for this viewer? Defaults to `true`; the
   * container passes `features.appBlocks`, because `blocks.withdrawPublishRequest` carries
   * `enforceAppBlocksFlag` while this page does not.
   *
   * 🔴 IT SURVIVES THE HISTORY MOVE BECAUSE THE ORPHAN GROUP STILL NEEDS IT. Every other
   * withdraw affordance on this page went with the History panel; the orphaned-submission
   * rows are submission-keyed, have no listing and therefore no authoring page, so their
   * Withdraw button stays here — and it is a BLOCK publish request, i.e. exactly the half
   * this flag gates.
   */
  withdrawEnabled?: boolean;
  /** Is an orphan withdraw in flight? Disables the button rather than double-firing. */
  withdrawing?: boolean;
  /** Submissions whose listing was deleted — see `listMyOrphanedSubmissions`. */
  orphanedSubmissions?: OrphanedSubmissionRow[];
  /** Message from a FAILED orphan read. Never conflate with an empty one. */
  orphanedError?: string | null;
  /** Is the orphan read still in flight? An empty result mid-stream is not an empty set. */
  orphanedLoading?: boolean;
  onWithdrawOrphan?: (row: OrphanedSubmissionRow) => void;
};

export function MyAppsBodyView({
  rows,
  isLoading = false,
  errorMessage = null,
  compact = false,
  withdrawEnabled = true,
  withdrawing = false,
  orphanedSubmissions = [],
  orphanedError = null,
  orphanedLoading = false,
  onWithdrawOrphan,
}: MyAppsBodyViewProps) {
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [inactivePage, setInactivePage] = useState(1);

  /**
   * The row whose images are open in the viewer, and which one is on screen.
   *
   * 🔴 ONE VIEWER FOR THE WHOLE PAGE, not one per row. A `<Modal>` per row would put
   * `rows.length` dialogs in the DOM, each registering its own capture-phase `keydown`
   * listener for Escape — and this table routinely renders dozens of rows.
   *
   * 🔴 `broken` IS RESET ON EVERY OPEN, because it is a set of indices into THIS row's
   * `[cover, icon]` list. Carrying it across rows would mean "index 1 is broken" —
   * learned from one listing's icon — silently hiding a different listing's icon. That
   * is the same index-space rule the screenshot gallery states in
   * `appListingScreenshotNav.ts`; here the list changes per row rather than per refetch.
   */
  const [mediaTarget, setMediaTarget] = useState<{ rowId: string; index: number } | null>(null);
  const [mediaBroken, setMediaBroken] = useState<BrokenScreenshotIndexes>(NO_BROKEN_SCREENSHOTS);

  const openMedia = useCallback((row: MyAppRow, which: MyAppMediaKind) => {
    const index = listingMediaIndex(row, which);
    // 🔴 `null` means that image is absent. Unreachable from the UI today (a placeholder
    // renders no button at all), so this is the structural half of that guarantee rather
    // than its only enforcement — an opened-on-nothing viewer is an empty modal.
    if (index === null) return;
    setMediaBroken(NO_BROKEN_SCREENSHOTS);
    setMediaTarget({ rowId: row.appListingId, index });
  }, []);
  const closeMedia = useCallback(() => setMediaTarget(null), []);
  const markMediaBroken = useCallback(
    (index: number) => setMediaBroken((prev) => withBrokenIndex(prev, index)),
    []
  );

  const { active, inactive } = useMemo(
    () => partitionMyAppRows(sortByRecentlyUpdated(rows)),
    [rows]
  );
  const inactivePages = pageCount(inactive.length);
  const inactiveVisible = pageSlice(inactive, inactivePage);

  // Resolved from `rows` rather than stored on open, so the viewer can never outlive
  // the row it is showing (see the mount site).
  const mediaRow = mediaTarget
    ? rows.find((r) => r.appListingId === mediaTarget.rowId) ?? null
    : null;

  const renderRow = useCallback(
    (row: MyAppRow, group: 'active' | 'inactive'): RowRenderProps => ({
      row,
      group,
      onOpenMedia: openMedia,
    }),
    [openMedia]
  );

  /**
   * 🔴 A FAILED `listMine` MUST NOT SWALLOW THE ORPHAN GROUP. This used to `return` the
   * alert, which meant one failing read blanked the ONE surface a rejected first
   * submission is reachable from — an invisible population arriving by a different route,
   * i.e. the same failure mode as the defect this page exists to fix. The alert now
   * renders BESIDE whatever else resolved.
   *
   * 🔴 AND THE GUARD KEYS ON THE ORPHAN READ'S *ERROR* AS WELL AS ITS DATA. Keying on
   * `orphanedSubmissions.length` alone reopened the same hole one door along: with BOTH
   * reads failed and zero orphan rows, the early return fired and the orphan failure
   * reported nothing, permanently. Zero rows is not the same fact as "the read succeeded
   * and found none" — that is the whole silent-zero lesson, applied to the guard itself.
   */
  const rowsFailed = !!errorMessage;
  if (rowsFailed && orphanedSubmissions.length === 0 && !orphanedError) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-mine-error"
      >
        {errorMessage}
      </Alert>
    );
  }
  /**
   * 🔴 WHAT THIS GUARD ACTUALLY DOES, stated because its first comment described only the
   * error case while its real effect is here: once the ORPHAN read resolves while `rows`
   * are still loading, the loader stops rendering and the rows area would be empty with no
   * loading affordance. Falling through is correct — the orphan group is real content and
   * showing it beats a spinner over data that already arrived — but the page must then not
   * claim the account is empty, which is what `orphanedLoading` below is for.
   */
  if (isLoading && orphanedSubmissions.length === 0) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  /**
   * 🔴 THE EMPTY STATE IS NOT AN EARLY RETURN, and that distinction is a defect this
   * suite caught. An account whose ONLY records are orphaned submissions has zero
   * listings, so returning here would render "you don't own any apps yet" over the top of
   * the one group that finally makes their rejected first version visible — the original
   * defect, reappearing one layer up. The alert renders INSIDE the stack, beside them.
   */
  /**
   * 🔴 `orphanedLoading` IS PART OF THIS PREDICATE, and it is reachable rather than
   * defensive. The two procedures batch into ONE request under `httpBatchStreamLink` but
   * stream back INDEPENDENTLY, so `rowsQuery` resolving empty while the orphan read is
   * still in flight is an ordinary interleaving — and without this term the page renders
   * "You don't own or collaborate on any apps yet" over a pending read. Streaming makes
   * that MORE reachable, not less.
   */
  const hasNothingAtAll =
    rows.length === 0 &&
    orphanedSubmissions.length === 0 &&
    !rowsFailed &&
    !orphanedError &&
    !orphanedLoading;

  return (
    <Stack gap="lg" data-testid="apps-mine-list">
      {rowsFailed && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="apps-mine-error"
        >
          {errorMessage}
        </Alert>
      )}
      {/*
        🔴 A FAILING ORPHAN READ MUST SAY SO. `orphansQuery.error` was read NOWHERE, so a
        failure rendered nothing and reported nothing — indistinguishable from "you have no
        rejected submissions", which is the exact lie this group was added to stop telling.
        A reassuring empty result is not evidence of an empty set.
      */}
      {orphanedError && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="apps-mine-orphaned-error"
        >
          {orphanedError}
        </Alert>
      )}
      {hasNothingAtAll && (
        <Alert
          color="gray"
          variant="light"
          icon={<IconApps size={16} />}
          data-testid="apps-mine-empty"
        >
          You don’t own or collaborate on any apps yet.
        </Alert>
      )}
      {rows.length === 0 ? null : active.length === 0 ? (
        <Alert color="gray" variant="light" data-testid="apps-mine-active-empty">
          Every app you can access is inactive. Open “Inactive” below to see them.
        </Alert>
      ) : (
        <AppGroup
          rows={active}
          group="active"
          compact={compact}
          testId="apps-mine-table"
          renderRow={renderRow}
        />
      )}

      {inactive.length > 0 && (
        <Stack gap="xs">
          {/*
            🔴 COLLAPSED BY DEFAULT, WITH THE COUNT IN THE HEADER. A count on a closed
            control is what makes it worth opening; without it the section is an
            unlabelled box and the removed/rejected apps are simply gone as far as the
            owner can tell.
          */}
          <UnstyledButton
            onClick={() => setInactiveOpen((v) => !v)}
            aria-expanded={inactiveOpen}
            aria-controls="apps-mine-inactive-panel"
            data-testid="apps-mine-inactive-toggle"
          >
            <Group gap={6}>
              {inactiveOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
              <Text fw={600} size="sm">
                Inactive
              </Text>
              <Badge variant="light" color="gray" data-testid="apps-mine-inactive-count">
                {inactive.length}
              </Badge>
            </Group>
          </UnstyledButton>
          <Collapse in={inactiveOpen}>
            <Stack gap="xs" id="apps-mine-inactive-panel" data-testid="apps-mine-inactive-panel">
              <AppGroup
                rows={inactiveVisible}
                group="inactive"
                compact={compact}
                testId="apps-mine-inactive-table"
                renderRow={renderRow}
              />
              {inactivePages > 1 && (
                <Group justify="center" data-testid="apps-mine-inactive-pagination">
                  <Pagination
                    total={inactivePages}
                    value={Math.min(inactivePage, inactivePages)}
                    onChange={setInactivePage}
                    size="sm"
                  />
                </Group>
              )}
            </Stack>
          </Collapse>
        </Stack>
      )}

      {orphanedSubmissions.length > 0 && (
        <OrphanedSubmissionsSection
          rows={orphanedSubmissions}
          onWithdraw={onWithdrawOrphan}
          withdrawing={withdrawing}
          withdrawEnabled={withdrawEnabled}
        />
      )}

      {/*
        🔴 REUSED, NOT REBUILT — and the alternatives were rejected for a STRUCTURAL
        reason, not by omission. `ImageViewer` and `ImageDetailModal` are keyed on a
        numeric civitai `Image` id and driven by a `?imageId=` query param; a row here
        carries a CDN URL STRING (`getEdgeUrl`) and no image id exists to hand them.
        `AppListingScreenshotViewer` is URL-keyed, which is exactly the shape this page
        has — see its own rejected-alternatives ledger for the longer version.

        It is mounted OUTSIDE the row list so it survives pagination and the Inactive
        collapse closing under it; `mediaRow` is looked up from `rows`, so a row that
        leaves the list (a withdraw, a refetch) leaves `shots` empty and the viewer's
        own rescue effect closes it rather than framing a dead URL.

        Its `stackId` is INERT here — degrading cleanly with no `Modal.Stack` ancestor
        is a documented property of that component, and `/apps/mine` nests no dialogs.
      */}
      <AppListingScreenshotViewer
        shots={mediaRow ? listingMediaShots(mediaRow) : []}
        name={mediaRow?.name ?? ''}
        broken={mediaBroken}
        index={mediaRow ? mediaTarget?.index ?? null : null}
        onIndexChange={(index) => setMediaTarget((prev) => (prev ? { ...prev, index } : prev))}
        onBroken={markMediaBroken}
        onClose={closeMedia}
      />
    </Stack>
  );
}

/**
 * Submissions whose LISTING NO LONGER EXISTS — the population no app-keyed row can show.
 *
 * 🔴 SUBMISSION-KEYED, NOT APP-KEYED, and that is forced rather than chosen. A first
 * version that is rejected or withdrawn has its pre-approval draft listing DELETED to
 * release the slug, so there is no app to nest this under. Measured on production
 * 2026-08-20: **3 of 3 rejected** and **27 of 33 withdrawn** on-site requests are in that
 * state — i.e. 100% of rejections were unreachable from anywhere in the product, including
 * from the "your app was rejected" notification that now points at this page.
 *
 * 🔴 COLLAPSIBLE, BUT IT OPENS ITSELF WHENEVER IT HAS SOMETHING ACTIONABLE — and that
 * conditional is what carries the old "ALWAYS VISIBLE" guarantee forward rather than
 * dropping it. The previous rule was that this group must never sit behind a toggle,
 * for three reasons that all still hold: it is the only surface in the product showing
 * a REJECTION REASON, the "your app was rejected" notification deep-links to this page,
 * and on production 2026-08-20 **3 of 3 rejected** and **27 of 33 withdrawn** on-site
 * requests were unreachable from anywhere before it existed.
 *
 * Read those three reasons precisely: every one of them is about a row the author can
 * still ACT ON. None of them is an argument for keeping an unbounded pile of settled
 * history permanently expanded above the fold. So the rule is now:
 *
 *   - a row with a rejection reason, or a `pending` row the SERVER says this caller may
 *     withdraw → the group is open on arrival, with no interaction. The notification
 *     deep-link lands on an open group, which is the guarantee that mattered;
 *   - nothing actionable → collapsed, because it is archive.
 *
 * 🔴 THE COUNT BADGE STAYS ON THE HEADER, closed or open. A collapsed group with no
 * count is an unlabelled box, which is indistinguishable from the rows being GONE — the
 * exact impression this whole section exists to stop giving. The predicate itself is
 * `orphanGroupStartsOpen` in `myAppsView.ts`, in the blocking `unit` project.
 *
 * 🔴 STILL NOT INSIDE THE INACTIVE COLLAPSE. That has not changed and is not the same
 * question: this is its OWN disclosure, whose open state it decides from its OWN rows.
 * Nesting it under Inactive would put an actionable rejection two clicks deep behind a
 * control that says nothing about it.
 */
function OrphanedSubmissionsSection({
  rows,
  onWithdraw,
  withdrawing,
  withdrawEnabled,
}: {
  rows: OrphanedSubmissionRow[];
  onWithdraw?: (row: OrphanedSubmissionRow) => void;
  withdrawing: boolean;
  withdrawEnabled: boolean;
}) {
  /**
   * Initial state ONLY — deliberately not re-derived on every `rows` change. Once the
   * author has opened or closed this group, a refetch (or a withdraw removing the one
   * actionable row) must not reach in and move it under their hands.
   */
  const [open, setOpen] = useState(() => orphanGroupStartsOpen(rows));
  return (
    <Stack gap="xs" data-testid="apps-mine-orphaned">
      <UnstyledButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="apps-mine-orphaned-panel"
        data-testid="apps-mine-orphaned-toggle"
      >
        <Group gap={6}>
          {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          <Text fw={600} size="sm">
            Submissions without a listing
          </Text>
          <Badge variant="light" color="gray" data-testid="apps-mine-orphaned-count">
            {rows.length}
          </Badge>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap="xs" id="apps-mine-orphaned-panel" data-testid="apps-mine-orphaned-panel">
          <Text size="xs" c="dimmed">
            These apps never got a store listing — a first version that was rejected or withdrawn
            releases its slug, so there is no app page to show them on.
          </Text>
          <Stack gap="xs">
            {rows.map((r) => (
              <Paper
                key={r.id}
                withBorder
                p="sm"
                radius="md"
                data-testid={`apps-mine-orphaned-row-${r.id}`}
              >
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Stack gap={2}>
                    <Text fw={600}>{r.slug}</Text>
                    <Text size="xs" c="dimmed">
                      v{r.version} · submitted {formatWhen(r.submittedAt)}
                    </Text>
                  </Stack>
                  <Group gap="xs">
                    <Badge
                      variant="outline"
                      color={historyStatusColor(r.status)}
                      data-testid={`apps-mine-orphaned-status-${r.id}`}
                    >
                      {r.status}
                    </Badge>
                    {r.canWithdraw && onWithdraw && withdrawEnabled ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        disabled={withdrawing}
                        onClick={() => onWithdraw(r)}
                        data-testid={`apps-mine-orphaned-withdraw-${r.id}`}
                      >
                        Withdraw
                      </Button>
                    ) : null}
                  </Group>
                </Group>
                {/* 🔴 THE REVIEWER'S REASON IS THE POINT OF THIS GROUP. It is the only thing
                on the whole record that tells the developer what to change, and it was
                unreachable before this section existed. */}
                {r.rejectionReason ? (
                  <Text size="xs" c="red" mt={6} data-testid={`apps-mine-orphaned-notes-${r.id}`}>
                    {r.rejectionReason}
                  </Text>
                ) : r.approvalNotes ? (
                  <Text
                    size="xs"
                    c="dimmed"
                    mt={6}
                    data-testid={`apps-mine-orphaned-notes-${r.id}`}
                  >
                    {r.approvalNotes}
                  </Text>
                ) : null}
              </Paper>
            ))}
          </Stack>
        </Stack>
      </Collapse>
    </Stack>
  );
}

/**
 * The container.
 *
 * 🔴 TWO READS, NO MUTATIONS EXCEPT THE ORPHAN WITHDRAW. The lazy per-row `listingHistory`
 * query, the `unpublishOwnListing` modal and the `republishOwnListing` mutation all moved
 * to the authoring page's Publishing / History tabs. What is left here is the row list and
 * the orphan group — the one population with no listing, and therefore no authoring page to
 * move to.
 */
export function MyAppsBody() {
  // 🔴 `48em` is Mantine's `sm` breakpoint. `useMediaQuery` returns `undefined` before it
  // has measured, so the `=== true` keeps the first paint on the table rather than
  // flashing the card layout on desktop.
  const isCompact = useMediaQuery('(max-width: 48em)') === true;
  /**
   * 🔴 READ FOR THE *WRITE*, NOT FOR THE PAGE. The page and both of its reads gate on
   * `appBlocksAuthor` ONLY — deliberately, because `appBlocks` is store VISIBILITY and an
   * author must be able to see their own apps when the store narrows. But
   * `blocks.withdrawPublishRequest` carries `.use(enforceAppBlocksFlag)`, so with
   * `appBlocksAuthor` on and `appBlocks` off the page renders and the orphan Withdraw 403s.
   */
  const features = useFeatureFlags();

  const rowsQuery = trpc.appListings.listMine.useQuery(undefined, { retry: false });

  /**
   * Submissions whose listing was deleted. One flat, bounded read alongside the rows —
   * this group IS the only surface these records have, so it is not lazy.
   */
  const orphansQuery = trpc.appListings.listMyOrphanedSubmissions.useQuery(undefined, {
    retry: false,
  });

  const utils = trpc.useUtils();
  const withdrawVersion = trpc.blocks.withdrawPublishRequest.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      void utils.appListings.listMine.invalidate();
      void utils.appListings.listMyOrphanedSubmissions.invalidate();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Withdraw failed', error: new Error(e.message) }),
  });

  // An orphan is by construction a BLOCK publish request, so it only ever has one proc.
  const onWithdrawOrphan = useCallback(
    (rowToWithdraw: OrphanedSubmissionRow) => {
      withdrawVersion.mutate({ publishRequestId: rowToWithdraw.id });
    },
    [withdrawVersion]
  );

  return (
    <MyAppsBodyView
      rows={(rowsQuery.data ?? []) as MyAppRow[]}
      isLoading={rowsQuery.isLoading}
      errorMessage={rowsQuery.error?.message ?? null}
      compact={isCompact}
      orphanedSubmissions={(orphansQuery.data ?? []) as OrphanedSubmissionRow[]}
      orphanedError={orphansQuery.error?.message ?? null}
      orphanedLoading={orphansQuery.isLoading}
      onWithdrawOrphan={onWithdrawOrphan}
      withdrawing={withdrawVersion.isPending}
      withdrawEnabled={!!features?.appBlocks}
    />
  );
}
