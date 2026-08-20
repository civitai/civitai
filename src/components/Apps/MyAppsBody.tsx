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

import type { MyAppRow } from '~/components/Apps/myAppsView';
import {
  historyStatusColor,
  listingKindLabel,
  listingStatusColor,
  myAppListingHref,
  pageCount,
  pageSlice,
  partitionMyAppRows,
  sortByRecentlyUpdated,
} from '~/components/Apps/myAppsView';
import { isAuthorableListingStatus } from '~/shared/constants/app-capabilities.constants';
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
 * Row identity is one row per APP. A publish request is an EVENT on an app, not a thing an
 * author manages, so the request stream is nested history inside the row and is fetched
 * only when a row is opened.
 */

/** One entry from `appListings.listingHistory` — see that service for the two streams. */
export type MyAppHistoryEntry = {
  id: string;
  source: 'version' | 'listing';
  status: string;
  version: string | null;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  changelog: string | null;
  deployState: string | null;
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

function ListingIcon({ row }: { row: MyAppRow }) {
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
  return (
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
}

function ListingCover({ row }: { row: MyAppRow }) {
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
  return (
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
}

/**
 * The app's NAME — a link to the authoring page, or plain text when the editor would
 * refuse.
 *
 * 🔴 NO LINK ON A NON-AUTHORABLE STATUS, carried over unchanged from the panel this
 * replaces. `getAppListingAuthoringContext` throws FORBIDDEN on a moderator-REMOVED or
 * REJECTED listing, so linking there offers a guaranteed 403 — and on a removed listing
 * the page used to open with a fully live Collaborators tab. The row still LISTS: an owner
 * needs to see the app exists and what became of it. Since every INACTIVE row is exactly
 * one of those two statuses, this is also why the Inactive collapse has no edit affordance.
 */
function ListingName({ row }: { row: MyAppRow }) {
  if (isAuthorableListingStatus(row.status)) {
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

function StatusBadges({ row }: { row: MyAppRow }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Badge
        variant="light"
        color={row.kind === 'onsite' ? 'blue' : 'grape'}
        data-testid={`apps-mine-kind-${row.appListingId}`}
      >
        {listingKindLabel(row.kind)}
      </Badge>
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
      <Badge
        variant="outline"
        color={listingStatusColor(row.status)}
        data-testid={`apps-mine-status-${row.appListingId}`}
      >
        {row.status}
      </Badge>
    </Group>
  );
}

/**
 * The expand control.
 *
 * 🔴 `aria-expanded` READS THE LIVE STATE and `aria-controls` NAMES A REAL ELEMENT ID.
 * Both are derived from the same `expanded` boolean the panel renders from, so they cannot
 * report a state the DOM does not have — a toggle whose `aria-expanded` stays `false`
 * reads to assistive tech (and to a test) as "the element is missing", which is an
 * expensive way to look broken.
 */
function HistoryToggle({
  row,
  expanded,
  onToggle,
}: {
  row: MyAppRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={historyPanelId(row.appListingId)}
      data-testid={`apps-mine-expand-${row.appListingId}`}
    >
      <Group gap={4} wrap="nowrap">
        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <Text size="xs" c="dimmed">
          History
        </Text>
      </Group>
    </UnstyledButton>
  );
}

export function historyPanelId(appListingId: string): string {
  return `apps-mine-history-${appListingId}`;
}

function HistoryPanel({
  row,
  expanded,
  entries,
  loading,
  errorMessage,
  onWithdraw,
  withdrawing,
}: {
  row: MyAppRow;
  expanded: boolean;
  entries: MyAppHistoryEntry[];
  loading: boolean;
  errorMessage: string | null;
  onWithdraw?: (entry: MyAppHistoryEntry) => void;
  withdrawing: boolean;
}) {
  return (
    <div id={historyPanelId(row.appListingId)} data-testid={historyPanelId(row.appListingId)}>
      {!expanded ? null : errorMessage ? (
        <Alert
          color="red"
          variant="light"
          data-testid={`apps-mine-history-error-${row.appListingId}`}
        >
          {errorMessage}
        </Alert>
      ) : loading ? (
        <Group gap="xs" data-testid={`apps-mine-history-loading-${row.appListingId}`}>
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Loading history…
          </Text>
        </Group>
      ) : entries.length === 0 ? (
        <Text size="xs" c="dimmed" data-testid={`apps-mine-history-empty-${row.appListingId}`}>
          No submissions yet for this app.
        </Text>
      ) : (
        <Stack gap={6}>
          {entries.map((e) => (
            <Group
              key={e.id}
              gap="xs"
              wrap="wrap"
              data-testid={`apps-mine-history-entry-${e.id}`}
              data-history-source={e.source}
            >
              <Badge size="xs" variant="light" color={e.source === 'version' ? 'blue' : 'grape'}>
                {e.source === 'version' ? `v${e.version ?? '?'}` : 'Listing edit'}
              </Badge>
              <Badge
                size="xs"
                variant="outline"
                color={historyStatusColor(e.status)}
                data-testid={`apps-mine-history-status-${e.id}`}
              >
                {e.status}
              </Badge>
              <Text size="xs" c="dimmed">
                {formatWhen(e.submittedAt)}
              </Text>
              {e.deployState ? (
                <Text size="xs" c="dimmed">
                  · {e.deployState}
                </Text>
              ) : null}
              {e.rejectionReason ? (
                <Text size="xs" c="red" data-testid={`apps-mine-history-notes-${e.id}`}>
                  {e.rejectionReason}
                </Text>
              ) : e.approvalNotes ? (
                <Text size="xs" c="dimmed" data-testid={`apps-mine-history-notes-${e.id}`}>
                  {e.approvalNotes}
                </Text>
              ) : null}
              {e.status === 'pending' && onWithdraw ? (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  disabled={withdrawing}
                  onClick={() => onWithdraw(e)}
                  data-testid={`apps-mine-history-withdraw-${e.id}`}
                >
                  Withdraw
                </Button>
              ) : null}
            </Group>
          ))}
        </Stack>
      )}
    </div>
  );
}

type RowRenderProps = {
  row: MyAppRow;
  group: 'active' | 'inactive';
  expanded: boolean;
  onToggle: () => void;
  history: MyAppHistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  onWithdraw?: (entry: MyAppHistoryEntry) => void;
  withdrawing: boolean;
};

function rowTestId(group: 'active' | 'inactive', appListingId: string): string {
  return group === 'active'
    ? `apps-mine-row-${appListingId}`
    : `apps-mine-inactive-row-${appListingId}`;
}

/** Desktop: one `<tr>` pair (the row, then its history row). */
function AppTableRow(props: RowRenderProps) {
  const { row, group, expanded } = props;
  return (
    <>
      <Table.Tr data-testid={rowTestId(group, row.appListingId)}>
        <Table.Td>
          <Group gap="sm" wrap="nowrap">
            <ListingIcon row={row} />
            <Stack gap={0}>
              <ListingName row={row} />
              <Text size="xs" c="dimmed">
                {row.slug}
              </Text>
            </Stack>
          </Group>
        </Table.Td>
        <Table.Td>
          <ListingCover row={row} />
        </Table.Td>
        <Table.Td>
          <StatusBadges row={row} />
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {formatWhen(row.updatedAt)}
          </Text>
        </Table.Td>
        <Table.Td>
          <HistoryToggle row={row} expanded={expanded} onToggle={props.onToggle} />
        </Table.Td>
      </Table.Tr>
      <Table.Tr>
        <Table.Td colSpan={5} p={expanded ? undefined : 0} style={{ borderTop: 'none' }}>
          <HistoryPanel
            row={row}
            expanded={expanded}
            entries={props.history}
            loading={props.historyLoading}
            errorMessage={props.historyError}
            onWithdraw={props.onWithdraw}
            withdrawing={props.withdrawing}
          />
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
  const { row, group, expanded } = props;
  return (
    <Paper withBorder p="sm" radius="md" data-testid={rowTestId(group, row.appListingId)}>
      <Stack gap="xs">
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <ListingIcon row={row} />
          <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
            <ListingName row={row} />
            <Text size="xs" c="dimmed">
              {row.slug}
            </Text>
          </Stack>
          <ListingCover row={row} />
        </Group>
        <StatusBadges row={row} />
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text size="xs" c="dimmed">
            Updated {formatWhen(row.updatedAt)}
          </Text>
          <HistoryToggle row={row} expanded={expanded} onToggle={props.onToggle} />
        </Group>
        <HistoryPanel
          row={row}
          expanded={expanded}
          entries={props.history}
          loading={props.historyLoading}
          errorMessage={props.historyError}
          onWithdraw={props.onWithdraw}
          withdrawing={props.withdrawing}
        />
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
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Cover</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Updated</Table.Th>
            <Table.Th />
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
  /** The open row, if any. Controlled so the container can key its lazy query off it. */
  expandedId?: string | null;
  onToggleExpand?: (appListingId: string | null) => void;
  history?: MyAppHistoryEntry[];
  historyLoading?: boolean;
  historyError?: string | null;
  onWithdraw?: (entry: MyAppHistoryEntry) => void;
  withdrawing?: boolean;
};

export function MyAppsBodyView({
  rows,
  isLoading = false,
  errorMessage = null,
  compact = false,
  expandedId = null,
  onToggleExpand,
  history = [],
  historyLoading = false,
  historyError = null,
  onWithdraw,
  withdrawing = false,
}: MyAppsBodyViewProps) {
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [inactivePage, setInactivePage] = useState(1);

  const { active, inactive } = useMemo(
    () => partitionMyAppRows(sortByRecentlyUpdated(rows)),
    [rows]
  );
  const inactivePages = pageCount(inactive.length);
  const inactiveVisible = pageSlice(inactive, inactivePage);

  const renderRow = useCallback(
    (row: MyAppRow, group: 'active' | 'inactive'): RowRenderProps => {
      const expanded = expandedId === row.appListingId;
      return {
        row,
        group,
        expanded,
        onToggle: () => onToggleExpand?.(expanded ? null : row.appListingId),
        history: expanded ? history : [],
        historyLoading: expanded ? historyLoading : false,
        historyError: expanded ? historyError : null,
        onWithdraw,
        withdrawing,
      };
    },
    [expandedId, history, historyLoading, historyError, onToggleExpand, onWithdraw, withdrawing]
  );

  if (errorMessage) {
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
  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (rows.length === 0) {
    return (
      <Alert
        color="gray"
        variant="light"
        icon={<IconApps size={16} />}
        data-testid="apps-mine-empty"
      >
        You don’t own or collaborate on any apps yet.
      </Alert>
    );
  }

  return (
    <Stack gap="lg" data-testid="apps-mine-list">
      {active.length === 0 ? (
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
    </Stack>
  );
}

/** The container: `listMine` for the rows, and ONE lazy history query keyed to the open row. */
export function MyAppsBody() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 🔴 `48em` is Mantine's `sm` breakpoint. `useMediaQuery` returns `undefined` before it
  // has measured, so the `=== true` keeps the first paint on the table rather than
  // flashing the card layout on desktop.
  const isCompact = useMediaQuery('(max-width: 48em)') === true;

  const rowsQuery = trpc.appListings.listMine.useQuery(undefined, { retry: false });

  /**
   * 🔴 LAZY. `enabled` is false until a row is opened, so the initial render issues ONE
   * query (the rows) rather than a per-row fan-out. The page this replaced fetched every
   * submission for every app up front.
   */
  const historyQuery = trpc.appListings.listingHistory.useQuery(
    { appListingId: expandedId ?? '' },
    { enabled: !!expandedId, retry: false }
  );

  const utils = trpc.useUtils();
  const refetchHistory = useCallback(() => {
    void utils.appListings.listingHistory.invalidate();
    void utils.appListings.listMine.invalidate();
  }, [utils]);

  const onWithdrawError = useCallback((message: string) => {
    showErrorNotification({ title: 'Withdraw failed', error: new Error(message) });
  }, []);

  const withdrawVersion = trpc.blocks.withdrawPublishRequest.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      refetchHistory();
    },
    onError: (e) => onWithdrawError(e.message),
  });
  const withdrawListing = trpc.appListings.withdrawExternalRequest.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      refetchHistory();
    },
    onError: (e) => onWithdrawError(e.message),
  });

  /**
   * 🔴 THE WITHDRAW MUTATION IS CHOSEN BY THE ENTRY'S OWN `source`, because the two
   * streams live in different tables with different procs — see
   * `app-listing-history.service`. Sending a listing-revision id to the block proc (or the
   * reverse) is a guaranteed NOT_FOUND.
   */
  const onWithdraw = useCallback(
    (entry: MyAppHistoryEntry) => {
      if (entry.source === 'version') withdrawVersion.mutate({ publishRequestId: entry.id });
      else withdrawListing.mutate({ publishRequestId: entry.id });
    },
    [withdrawVersion, withdrawListing]
  );

  return (
    <MyAppsBodyView
      rows={(rowsQuery.data ?? []) as MyAppRow[]}
      isLoading={rowsQuery.isLoading}
      errorMessage={rowsQuery.error?.message ?? null}
      compact={isCompact}
      expandedId={expandedId}
      onToggleExpand={setExpandedId}
      history={(historyQuery.data ?? []) as MyAppHistoryEntry[]}
      historyLoading={!!expandedId && historyQuery.isLoading}
      historyError={historyQuery.error?.message ?? null}
      onWithdraw={onWithdraw}
      withdrawing={withdrawVersion.isPending || withdrawListing.isPending}
    />
  );
}
