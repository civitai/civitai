import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconEyeOff,
  IconHistory,
  IconPlugConnected,
  IconPlus,
  IconSettings,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { Meta } from '~/components/Meta/Meta';
import { AppsSubNav } from '~/components/Apps/AppsSubNav';
import { groupSubscriptionsByApp } from '~/components/Apps/groupSubscriptionsByApp';
import type { GroupedApp } from '~/components/Apps/groupSubscriptionsByApp';
import { useHiddenBlockList, unhideBlock } from '~/components/AppBlocks/hiddenBlocks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  SubscriptionRecord,
} from '~/server/schema/blocks/subscription.schema';
import { BlockScopeList } from '~/components/Apps/BlockScopeList';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    return { props: {} };
  },
});

const PIN_LATEST_VALUE = '__latest__';

interface PinnedInstallRowProps {
  sub: SubscriptionRecord;
}

/**
 * One compact line for a single pinned (per-model-install) subscription —
 * slot_id non-NULL + target_model_ids non-empty. Carries the same controls
 * the old SubscriptionRow gave pinned rows: the model link badge(s), the
 * version Select (Latest + availableVersions), and the Uninstall action.
 *
 * Pinned subs are removed via `blocks.uninstallFromModel` (using the row's
 * preserved blockInstanceId) so the rank-1 NOT EXISTS in listForModel's SQL
 * stops suppressing platform defaults for the same slot. The original cache
 * invalidations (listMySubscriptions, listMyScopeGrants, listForModel) are
 * preserved verbatim.
 */
function PinnedInstallRow({ sub }: PinnedInstallRowProps) {
  const utils = trpc.useUtils();
  const manifest = sub.manifest;
  const uninstallMutation = trpc.blocks.uninstallFromModel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.blocks.listMySubscriptions.invalidate(),
        utils.blocks.listMyScopeGrants.invalidate(),
        // Pinned subs render on exactly one modelId; targeted cache bust.
        sub.targetModelIds && sub.targetModelIds[0]
          ? utils.blocks.listForModel.invalidate({ modelId: sub.targetModelIds[0] })
          : Promise.resolve(),
      ]);
      showSuccessNotification({ title: 'Removed', message: 'Uninstalled from model.' });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not uninstall', error: new Error(e.message) }),
  });
  const pinVersionMutation = trpc.blocks.setSubscriptionPinnedVersion.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not change version', error: new Error(e.message) }),
  });

  const versionOptions: { value: string; label: string }[] = [
    {
      value: PIN_LATEST_VALUE,
      label: sub.currentVersion ? `Latest (${sub.currentVersion})` : 'Latest',
    },
    ...sub.availableVersions.map((v) => ({ value: v.version, label: v.version })),
  ];

  const pinnedTo = (sub.targetModelIds ?? []).map((id) => ({
    id,
    name: sub.pinnedModelNames?.[id] ?? `Model ${id}`,
  }));

  const onConfirmUninstall = () => {
    const targetName = pinnedTo[0]?.name ?? 'this model';
    openConfirmModal({
      title: `Uninstall ${manifest.name ?? sub.blockId}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This removes the install row entirely. The block will stop appearing on{' '}
            <strong>{targetName}</strong>. Any platform default for the same slot will become
            eligible again. The app's data and any other installs of it are untouched.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Uninstall', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (sub.blockInstanceId) {
          uninstallMutation.mutate({ blockInstanceId: sub.blockInstanceId });
        }
      },
    });
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
      <Group gap={4} wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
        {pinnedTo.map(({ id, name }) => (
          <Badge
            key={id}
            size="xs"
            variant="outline"
            component={Link}
            href={`/models/${id}`}
            style={{ cursor: 'pointer' }}
          >
            {name}
          </Badge>
        ))}
        {!sub.enabled && (
          <Badge size="xs" variant="light" color="gray">
            Disabled
          </Badge>
        )}
      </Group>
      <Group gap="xs" wrap="nowrap" align="center">
        <Tooltip
          label="Which manifest the host uses for this install. Latest tracks the most recent approved release; pinning a version freezes scopes + settings to that version's manifest."
          multiline
          w={280}
          withArrow
        >
          <Select
            size="xs"
            w={170}
            data={versionOptions}
            value={sub.pinnedVersion ?? PIN_LATEST_VALUE}
            disabled={pinVersionMutation.isPending}
            onChange={(value) => {
              if (value == null) return;
              const next = value === PIN_LATEST_VALUE ? null : value;
              if (next === sub.pinnedVersion) return;
              pinVersionMutation.mutate({
                subscriptionId: sub.id,
                version: next,
              });
            }}
            comboboxProps={{ withinPortal: true }}
            aria-label={`Version for ${manifest.name ?? sub.blockId} on ${
              pinnedTo[0]?.name ?? 'model'
            }`}
          />
        </Tooltip>
        <ActionIcon
          variant="default"
          color="red"
          disabled={uninstallMutation.isPending}
          onClick={onConfirmUninstall}
          title="Uninstall"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

interface InstalledAppCardProps {
  app: GroupedApp;
  onManage: (sub: SubscriptionRecord) => void;
}

/**
 * One row per installed app. Collapses the two blanket "surfaces"
 * (publisher / viewer) into a single card with a "Shows on" summary; pinned
 * per-model installs are listed in a subsection below. Toggling which
 * surfaces are active happens through the existing AppSettingsModal (the
 * Manage button), which already supports both scopes.
 */
function InstalledAppCard({ app, onManage }: InstalledAppCardProps) {
  const { blanketPublisher, blanketViewer, pinned } = app;
  const name = app.manifest.name ?? app.blockId;
  // Any blanket sub on the app is enough to seed the Manage modal — it
  // re-scans all subs for the appBlockId internally.
  const manageSeed = blanketPublisher ?? blanketViewer ?? pinned[0];
  const hasBlanket = !!(blanketPublisher || blanketViewer);

  return (
    <Card withBorder padding="sm" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
          <Text fw={600} className="truncate" style={{ minWidth: 0, flex: 1 }}>
            {name}
          </Text>
          {manageSeed && (
            <Button
              variant="default"
              size="xs"
              leftSection={<IconSettings size={14} />}
              onClick={() => onManage(manageSeed)}
            >
              Manage
            </Button>
          )}
        </Group>

        <Group gap="xs" wrap="wrap" align="center">
          <Text size="xs" c="dimmed">
            Shows on:
          </Text>
          {hasBlanket ? (
            <>
              {blanketPublisher && (
                <Tooltip label="Visible to anyone who views your models." withArrow>
                  <Badge
                    size="sm"
                    variant="light"
                    color={blanketPublisher.enabled ? undefined : 'gray'}
                  >
                    On my models
                    {!blanketPublisher.enabled ? ' · Disabled' : ''}
                  </Badge>
                </Tooltip>
              )}
              {blanketViewer && (
                <Tooltip
                  label="Visible only to you, on every model page you open."
                  withArrow
                >
                  <Badge
                    size="sm"
                    variant="light"
                    color={blanketViewer.enabled ? undefined : 'gray'}
                  >
                    On every page I view
                    {!blanketViewer.enabled ? ' · Disabled' : ''}
                  </Badge>
                </Tooltip>
              )}
            </>
          ) : (
            <Text size="xs" c="dimmed" fs="italic">
              Not on a blanket surface — pinned to specific models below.
            </Text>
          )}
        </Group>

        {pinned.length > 0 && (
          <>
            <Divider />
            <Stack gap="xs">
              <Text size="xs" c="dimmed" fw={500}>
                Pinned to specific models
              </Text>
              {pinned.map((sub) => (
                <PinnedInstallRow key={sub.id} sub={sub} />
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <Center py="md">
      <Stack align="center" gap="xs">
        <IconPlugConnected size={28} opacity={0.5} />
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <Anchor component={Link} href="/apps" size="sm">
          Browse the marketplace
        </Anchor>
      </Stack>
    </Center>
  );
}

/**
 * Surface where the user has the app installed in one short string.
 */
function buildSurfaceLine(surfaces: {
  modelInstallCount: number;
  subscriptionScopes: string[];
}): string {
  const parts: string[] = [];
  if (surfaces.modelInstallCount > 0) {
    parts.push(
      `${surfaces.modelInstallCount} model install${surfaces.modelInstallCount === 1 ? '' : 's'}`
    );
  }
  if (surfaces.subscriptionScopes.length > 0) {
    parts.push(
      `Subscriptions: ${surfaces.subscriptionScopes
        .map((s) => (s === 'publisher_all_my_models' ? 'publisher' : 'viewer'))
        .join(' / ')}`
    );
  } else if (surfaces.modelInstallCount === 0) {
    parts.push('Subscriptions: none');
  }
  return parts.join(' · ');
}

function ScopeGrantsPanel() {
  const { data: grants, isLoading } = trpc.blocks.listMyScopeGrants.useQuery();

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!grants || grants.length === 0) {
    return <EmptyState label="No apps installed or subscribed yet." />;
  }
  return (
    <Stack gap="md">
      {grants.map((grant) => (
        <Card key={grant.appBlockId} withBorder padding="sm" radius="md">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                <Group gap="xs">
                  <Text fw={600} className="truncate">
                    {grant.name}
                  </Text>
                  <Badge size="xs" variant="outline">
                    {grant.slug}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {buildSurfaceLine(grant.surfaces)}
                </Text>
              </Stack>
            </Group>
            <Divider />
            <BlockScopeList scopes={grant.scopes} />
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

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
function humaniseActivityAction(scope: string): string {
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

/**
 * W5 v0.5: combined activity feed. Two cursor-paginated tRPC queries
 * (block_buzz_attribution + block_scope_invocations) merged into one
 * timeline. Both are page-by-page, so we fetch the same page on each side
 * and merge-sort by createdAt — good enough at the page sizes the user
 * actually sees. A scope-invocation row carries (endpoint, statusCode)
 * instead of (amount, status); humaniseActivityAction is overloaded.
 */
type ActivityFeedRow =
  | {
      kind: 'buzz';
      id: string;
      createdAt: Date;
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
      appName: string;
      appSlug: string;
      scope: string;
      endpoint: string;
      statusCode: number;
    };

function ActivityPanel() {
  const buzz = trpc.blocks.listMyAppActivity.useInfiniteQuery(
    { limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const scopes = trpc.blocks.listMyScopeInvocations.useInfiniteQuery(
    { limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );

  const items = useMemo<ActivityFeedRow[]>(() => {
    const buzzRows: ActivityFeedRow[] =
      buzz.data?.pages.flatMap((p) =>
        p.items.map<ActivityFeedRow>((item) => ({
          kind: 'buzz',
          id: `buzz:${item.id}`,
          createdAt: item.createdAt,
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
          appName: item.appName,
          appSlug: item.appSlug,
          scope: item.scope,
          endpoint: item.endpoint,
          statusCode: item.statusCode,
        }))
      ) ?? [];
    return [...buzzRows, ...scopeRows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }, [buzz.data, scopes.data]);

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
          <Button
            variant="default"
            size="xs"
            loading={isFetchingNextPage}
            onClick={loadMore}
          >
            Load more
          </Button>
        </Center>
      )}
    </Stack>
  );
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

function humaniseScopeInvocation(scope: string, endpoint?: string): string {
  // Synthetic endpoints take precedence over the scope label — same
  // scope can fan out to different user-facing verbs (block:settings:write
  // covers both first-time saves and checkpoint pin swaps; apps:storage
  // covers both set and delete). The endpoint string is the source of
  // truth for what the app actually did.
  if (endpoint?.startsWith('workflow:submit')) return 'Generated an image';
  if (endpoint === 'user-settings:write') return 'Saved your block settings';
  if (endpoint?.startsWith('storage:set:')) return 'Wrote app-local storage';
  if (endpoint?.startsWith('storage:delete:')) return 'Deleted app-local storage';
  return SCOPE_ACTION_LABELS[scope] ?? scope;
}

/**
 * Strip synthetic prefixes off endpoints so the Detail column shows the
 * meaningful tail (workflowId, storage key, etc.). REST endpoints pass
 * through unchanged.
 */
function humaniseScopeEndpoint(endpoint: string): string {
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
 * Viewer-local "Hide app block" restore surface. The ⋯ menu on a block's host
 * trust-frame lets a viewer hide an owner-installed block; that lives only in
 * this browser's localStorage (see components/AppBlocks/hiddenBlocks.ts), so it
 * has no server-side row and isn't part of the user's installs/subscriptions —
 * hence its own tab. "Restore" un-hides it, and the block reappears on the
 * model page (reactively, via the shared change event).
 */
function HiddenBlocksPanel() {
  const hidden = useHiddenBlockList();

  if (hidden.length === 0) {
    return (
      <Center py="md">
        <Stack align="center" gap="xs">
          <IconEyeOff size={28} opacity={0.5} />
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            You haven't hidden any app blocks. Use the ⋯ menu on a block to hide it on this
            device — it only affects what you see, never the publisher or other viewers.
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Stack gap="sm">
      {hidden.map((block) => (
        <Card key={block.blockInstanceId} withBorder padding="sm" radius="md">
          <Group justify="space-between" wrap="nowrap" gap="md" align="center">
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text fw={600} className="truncate">
                {block.appName ?? 'App block'}
              </Text>
              <Group gap={6} wrap="wrap">
                {block.modelId ? (
                  <Anchor component={Link} href={`/models/${block.modelId}`} size="xs">
                    {block.modelName ?? `Model ${block.modelId}`}
                  </Anchor>
                ) : null}
                {block.hiddenAt > 0 && (
                  <Text size="xs" c="dimmed">
                    Hidden {formatDate(new Date(block.hiddenAt), 'YYYY-MM-DD')}
                  </Text>
                )}
              </Group>
            </Stack>
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                unhideBlock(block.blockInstanceId);
                showSuccessNotification({
                  title: 'Restored',
                  message: `${block.appName ?? 'App block'} will show again.`,
                });
              }}
            >
              Restore
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

export default function InstalledAppsPage() {
  const features = useFeatureFlags();
  const { data: subs, isLoading } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks,
  });

  const groupedApps = useMemo(
    () => groupSubscriptionsByApp(subs ?? []),
    [subs]
  );

  function handleManage(sub: SubscriptionRecord) {
    // Build an AvailableBlock-shaped object from the subscription's
    // denormalised app_block row so we can reuse the marketplace modal.
    const block: AvailableBlock = {
      id: sub.appBlockId,
      blockId: sub.blockId,
      appId: sub.appId,
      appName: null,
      manifest: sub.manifest as Record<string, unknown>,
      installCount: 0,
      // E3 marketplace-card fields — unused on the Manage path (modal-only).
      category: null,
      scopesSummary: [],
      // Marketplace reviews — unused on the Manage path (modal-only).
      avgRating: null,
      reviewCount: 0,
    };
    const existingByScope: Partial<Record<typeof sub.scope, SubscriptionRecord>> = {};
    for (const candidate of subs ?? []) {
      if (candidate.appBlockId === sub.appBlockId) {
        existingByScope[candidate.scope] = candidate;
      }
    }
    openAppSettingsModal({ block, existingByScope });
  }

  if (!features.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="Installed Apps — Civitai" deIndex />
      <Container size="lg" py="md">
        <Stack gap="lg">
          <AppsSubNav />
          <Group justify="space-between">
            <Stack gap={2}>
              <Title order={2}>Your installed apps</Title>
              <Text size="sm" c="dimmed">
                Manage where Civitai App Blocks show up across the site.
              </Text>
            </Stack>
            <Button
              component={Link}
              href="/apps"
              leftSection={<IconPlus size={16} />}
              variant="default"
            >
              Browse marketplace
            </Button>
          </Group>

          <Tabs defaultValue="subscriptions" variant="outline">
            <Tabs.List>
              <Tabs.Tab value="subscriptions" leftSection={<IconPlugConnected size={14} />}>
                Installs
              </Tabs.Tab>
              <Tabs.Tab value="permissions" leftSection={<IconShieldLock size={14} />}>
                Apps & permissions
              </Tabs.Tab>
              <Tabs.Tab value="activity" leftSection={<IconHistory size={14} />}>
                Recent activity
              </Tabs.Tab>
              <Tabs.Tab value="hidden" leftSection={<IconEyeOff size={14} />}>
                Hidden
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="subscriptions" pt="md">
              {isLoading ? (
                <Center py="xl">
                  <Loader />
                </Center>
              ) : groupedApps.length === 0 ? (
                <EmptyState label="Nothing installed yet — browse the marketplace." />
              ) : (
                <Stack gap="md">
                  {groupedApps.map((app) => (
                    <InstalledAppCard
                      key={app.appBlockId}
                      app={app}
                      onManage={handleManage}
                    />
                  ))}
                </Stack>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="permissions" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  What each app you've installed can request, and where you have it. This is a
                  reflection of the current state — to revoke access, remove the install or
                  subscription on the Subscriptions tab.
                </Text>
                <ScopeGrantsPanel />
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="activity" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  Recent actions apps have taken on your behalf — Buzz spends plus every
                  scope-gated API call (read profile, read model, etc.).
                </Text>
                <ActivityPanel />
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="hidden" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  App blocks you've hidden on this device. Hiding is local to your browser —
                  it never affects the publisher's install or other viewers. Restore one to
                  have it show on its model page again.
                </Text>
                <HiddenBlocksPanel />
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}

