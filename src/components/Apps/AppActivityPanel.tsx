import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import {
  describeBlockAction,
  READ_SCOPE_LABELS,
  type BlockActionDetail,
} from '~/shared/constants/block-action-detail';

/**
 * Shared per-viewer app-activity timeline. Extracted from
 * `src/pages/apps/installed.tsx` (W5 v0.5) so the same interleaved feed can be
 * reused both there (whole-account view) AND on the run-frame "Permissions &
 * activity" drawer scoped to a single app (`appBlockId`). DRY: the humanise
 * helpers + row shape live here, in one tested place, instead of duplicated.
 *
 * Two cursor-paginated tRPC queries — `blocks.listMyAppActivity` (Buzz
 * attribution) + `blocks.listMyScopeInvocations` (scope-gated call audit) —
 * merged into one timeline sorted by createdAt desc.
 *
 * `appBlockId` drill-down: BOTH queries filter SERVER-side by the optional
 * `appBlockId` input, so each per-app feed paginates correctly (a whole-account
 * fetch + client filter would under-report this app's Buzz behind other apps'
 * rows on page 1). A client-side `item.appBlockId` check is kept as cheap
 * belt-and-suspenders. When `appBlockId` is omitted the feed is whole-account —
 * exactly the /apps/installed behaviour, unchanged.
 *
 * `enabled` gates the queries: pass `false` for an anonymous viewer (these
 * procedures are `protectedProcedure`, so firing them unauthenticated just
 * errors) — the panel then renders the friendly empty state instead.
 */
const ACTIVITY_STATUS_COLORS: Record<string, string> = {
  pending: 'blue',
  confirmed: 'green',
  paid_out: 'green',
  voided: 'red',
};

function ActivityStatusBadge({ status }: { status: string }) {
  const color = ACTIVITY_STATUS_COLORS[status] ?? 'gray';
  return (
    <Badge size="sm" color={color} variant="light">
      {status}
    </Badge>
  );
}

/**
 * Format an activity scope + amount into a one-line "Action" cell. The
 * v0 surface only has the subscription scope on the row — we humanise
 * the well-known scopes and pass through anything unknown.
 */
export function humaniseActivityAction(scope: string): string {
  switch (scope) {
    case 'per_model_install':
      return 'Spent Buzz on a per-model install';
    case 'publisher_all_my_models':
      return 'Spent Buzz via my publisher subscription';
    case 'viewer_personal':
      return 'Spent Buzz via my personal subscription';
    case 'platform_default':
      return 'Spent Buzz via a civitai-promoted default';
    default:
      return scope;
  }
}

const SCOPE_ACTION_LABELS: Record<string, string> = {
  'user:read:self': 'Read profile',
  'buzz:read:self': 'Read Buzz balance',
  'models:read:self': 'Read model',
  'media:read:owned': 'Read media',
  'block:settings:read': 'Read block settings',
  'block:settings:write': 'Write block settings',
  'ai:write:budgeted': 'Submit AI workflow',
  'social:tip:self': 'Tip',
};

export function humaniseScopeInvocation(scope: string, endpoint?: string): string {
  // Synthetic endpoints take precedence over the scope label — same
  // scope can fan out to different user-facing verbs (block:settings:write
  // covers both first-time saves and checkpoint pin swaps; apps:storage
  // covers both set and delete). The endpoint string is the source of
  // truth for what the app actually did.
  if (endpoint?.startsWith('workflow:submit')) return 'Generated an image';
  if (endpoint === 'user-settings:write') return 'Saved your block settings';
  if (endpoint?.startsWith('storage:set:')) return 'Wrote app-local storage';
  if (endpoint?.startsWith('storage:delete:')) return 'Deleted app-local storage';
  // Passive READS get a friendly label from the scope→label map (W13 — no
  // write-side change for reads). Fall through to the local write labels, then
  // the raw scope string for anything genuinely unknown.
  return READ_SCOPE_LABELS[scope] ?? SCOPE_ACTION_LABELS[scope] ?? scope;
}

/**
 * Strip synthetic prefixes off endpoints so the Detail column shows the
 * meaningful tail (workflowId, storage key, etc.). REST endpoints pass
 * through unchanged.
 */
export function humaniseScopeEndpoint(endpoint: string): string {
  const workflow = endpoint.match(/^workflow:submit:(.+)$/);
  if (workflow) {
    return workflow[1] === 'pending' ? '(no workflow id)' : `workflow ${workflow[1]}`;
  }
  const storage = endpoint.match(/^storage:(set|delete):(.+)$/);
  if (storage) return `key "${storage[2]}"`;
  if (endpoint === 'user-settings:write') return '';
  return endpoint;
}

function ScopeStatusBadge({ statusCode }: { statusCode: number }) {
  const color =
    statusCode < 300 ? 'green' : statusCode < 400 ? 'blue' : statusCode < 500 ? 'orange' : 'red';
  return (
    <Badge size="sm" color={color} variant="light">
      {statusCode}
    </Badge>
  );
}

/**
 * W5 v0.5: combined activity feed. Two cursor-paginated tRPC queries
 * (block_buzz_attribution + block_scope_invocations) merged into one
 * timeline. Both are page-by-page, so we fetch the same page on each side
 * and merge-sort by createdAt — good enough at the page sizes the user
 * actually sees. A scope-invocation row carries (endpoint, statusCode)
 * instead of (amount, status); humaniseActivityAction is overloaded.
 *
 * `detail` (W13): a scope-invocation row carries an optional structured
 * `BlockActionDetail` (stable action code + subject-ref ids). When present the
 * view resolves its ids → display names (batched) and renders a human sentence;
 * when absent (passive read / pre-W13 row) it falls back to the humanised
 * scope+endpoint.
 */
type ActivityFeedRow =
  | {
      kind: 'buzz';
      id: string;
      createdAt: Date;
      appBlockId: string;
      appName: string;
      appSlug: string;
      scope: string;
      usdAmountCents: number;
      status: string;
    }
  | {
      kind: 'scope';
      id: string;
      createdAt: Date;
      appBlockId: string;
      appName: string;
      appSlug: string;
      scope: string;
      endpoint: string;
      statusCode: number;
      detail: BlockActionDetail | null;
    };

export function AppActivityPanel({
  appBlockId,
  enabled = true,
}: {
  /** When set, scopes the timeline to a single app (server-filtered scope
   *  invocations + client-filtered Buzz rows). Omitted → whole-account feed. */
  appBlockId?: string;
  /** Gate the (protected) queries. Pass `false` for an anonymous viewer. */
  enabled?: boolean;
}) {
  const buzz = trpc.blocks.listMyAppActivity.useInfiniteQuery(
    { limit: 25, ...(appBlockId ? { appBlockId } : {}) },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, enabled }
  );
  const scopes = trpc.blocks.listMyScopeInvocations.useInfiniteQuery(
    { limit: 25, ...(appBlockId ? { appBlockId } : {}) },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, enabled }
  );

  const items = useMemo<ActivityFeedRow[]>(() => {
    const buzzRows: ActivityFeedRow[] =
      buzz.data?.pages.flatMap((p) =>
        p.items
          // Server already filters by appBlockId (see the query above); this
          // client check is cheap belt-and-suspenders against a stale page.
          .filter((item) => !appBlockId || item.appBlockId === appBlockId)
          .map<ActivityFeedRow>((item) => ({
            kind: 'buzz',
            id: `buzz:${item.id}`,
            createdAt: item.createdAt,
            appBlockId: item.appBlockId,
            appName: item.appName,
            appSlug: item.appSlug,
            scope: item.scope,
            usdAmountCents: item.usdAmountCents,
            status: item.status,
          }))
      ) ?? [];
    const scopeRows: ActivityFeedRow[] =
      scopes.data?.pages.flatMap((p) =>
        p.items.map<ActivityFeedRow>((item) => ({
          kind: 'scope',
          id: `scope:${item.id}`,
          createdAt: item.createdAt,
          appBlockId: item.appBlockId,
          appName: item.appName,
          appSlug: item.appSlug,
          scope: item.scope,
          endpoint: item.endpoint,
          statusCode: item.statusCode,
          // W13 structured per-action detail (null for a passive read / pre-W13
          // row). Resolved to names + a sentence at render time below.
          detail: (item as { detail?: BlockActionDetail | null }).detail ?? null,
        }))
      ) ?? [];
    return [...buzzRows, ...scopeRows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }, [buzz.data, scopes.data, appBlockId]);

  // W13 name resolution — collect the unique subject-ref ids across the rich
  // rows and resolve them in ONE batched round-trip each (never per-row/N+1):
  // model versions via the existing `getVersionsByIds`, recipients via
  // `user.getById` coalesced through the tRPC http-batch link. The view renders
  // ids until the names settle (progressive), then swaps in @username / name.
  const userIds = useMemo(
    () =>
      Array.from(
        new Set(
          items.flatMap((i) =>
            i.kind === 'scope' && i.detail?.toUserId != null ? [i.detail.toUserId] : []
          )
        )
      ),
    [items]
  );
  // Version-name lookups are keyed on the (entityType==='ModelVersion', entityId)
  // subject ref the writers actually emit — batched across all rows (no N+1).
  const versionIds = useMemo(
    () =>
      Array.from(
        new Set(
          items.flatMap((i) =>
            i.kind === 'scope' && i.detail?.entityType === 'ModelVersion' && i.detail.entityId != null
              ? [i.detail.entityId]
              : []
          )
        )
      ),
    [items]
  );

  const versionsQuery = trpc.modelVersion.getVersionsByIds.useQuery(
    { ids: versionIds },
    { enabled: versionIds.length > 0 }
  );
  const userQueries = trpc.useQueries((t) => userIds.map((id) => t.user.getById({ id })));

  const usernameById = useMemo(() => {
    const map = new Map<number, string>();
    userQueries.forEach((q, idx) => {
      const username = (q.data as { username?: string | null } | undefined)?.username;
      if (username) map.set(userIds[idx], username);
    });
    return map;
  }, [userQueries, userIds]);

  const versionNameById = useMemo(() => {
    const map = new Map<number, string>();
    (versionsQuery.data ?? []).forEach((v) => {
      if (v?.id != null && v.name) map.set(v.id, v.name);
    });
    return map;
  }, [versionsQuery.data]);

  // Anonymous / disabled: the protected queries never fired — show the empty
  // state rather than an indefinite loader.
  if (!enabled) {
    return <EmptyActivity />;
  }

  const isLoading = buzz.isLoading || scopes.isLoading;
  const hasNextPage = !!(buzz.hasNextPage || scopes.hasNextPage);
  const isFetchingNextPage = !!(buzz.isFetchingNextPage || scopes.isFetchingNextPage);
  const loadMore = () => {
    // Load whichever feeds still have more — usually both. Cheap; the
    // queries are independent.
    if (buzz.hasNextPage) void buzz.fetchNextPage();
    if (scopes.hasNextPage) void scopes.fetchNextPage();
  };

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (items.length === 0) {
    return <EmptyActivity />;
  }
  return (
    <Stack gap="sm">
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th>
            <Table.Th>App</Table.Th>
            <Table.Th>Action</Table.Th>
            <Table.Th>Detail</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((item) => (
            <Table.Tr key={item.id}>
              <Table.Td>
                <Tooltip label={item.createdAt.toString()}>
                  <Text size="xs">{formatDate(item.createdAt, 'YYYY-MM-DD HH:mm')}</Text>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={500} className="truncate">
                    {item.appName}
                  </Text>
                  <Badge size="xs" variant="outline">
                    {item.appSlug}
                  </Badge>
                </Group>
              </Table.Td>
              <Table.Td>
                <Text size="xs">
                  {item.kind === 'buzz'
                    ? humaniseActivityAction(item.scope)
                    : item.detail
                    ? // W13 rich mutation row — resolve ids → names + a sentence.
                      describeBlockAction(item.detail, {
                        username:
                          item.detail.toUserId != null
                            ? usernameById.get(item.detail.toUserId)
                            : null,
                        subjectName:
                          item.detail.entityType === 'ModelVersion' &&
                          item.detail.entityId != null
                            ? versionNameById.get(item.detail.entityId)
                            : null,
                      })
                    : humaniseScopeInvocation(item.scope, item.endpoint)}
                </Text>
              </Table.Td>
              <Table.Td>
                {item.kind === 'buzz' ? (
                  <Text size="xs">
                    {item.usdAmountCents > 0
                      ? `${(item.usdAmountCents / 100).toFixed(2)} USD`
                      : '(no cost)'}
                  </Text>
                ) : (
                  <Text
                    size="xs"
                    style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
                  >
                    {/* The Action cell carries the human sentence when a rich
                        detail is present; the Detail cell always shows the raw
                        technical ref (workflow id / storage key / endpoint). */}
                    {humaniseScopeEndpoint(item.endpoint)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                {item.kind === 'buzz' ? (
                  <ActivityStatusBadge status={item.status} />
                ) : (
                  <ScopeStatusBadge statusCode={item.statusCode} />
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {hasNextPage && (
        <Center>
          <Button variant="default" size="xs" loading={isFetchingNextPage} onClick={loadMore}>
            Load more
          </Button>
        </Center>
      )}
    </Stack>
  );
}

function EmptyActivity() {
  return (
    <Center py="md">
      <Stack align="center" gap="xs">
        <IconHistory size={28} opacity={0.5} />
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          No activity yet. This feed populates whenever an app runs a generation, calls a
          scope-gated Civitai API, or sources a Buzz purchase on your behalf.
        </Text>
        <Anchor component={Link} href="/apps" size="sm">
          Browse the marketplace
        </Anchor>
      </Stack>
    </Center>
  );
}
