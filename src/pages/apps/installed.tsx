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
  Switch,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconBox,
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  SubscriptionRecord,
} from '~/server/schema/blocks/subscription.schema';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
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

interface SubscriptionRowProps {
  sub: SubscriptionRecord;
  onManage: (sub: SubscriptionRecord) => void;
}

function SubscriptionRow({ sub, onManage }: SubscriptionRowProps) {
  const utils = trpc.useUtils();
  const manifest = sub.manifest;
  const upsertMutation = trpc.blocks.upsertSubscription.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not toggle', error: new Error(e.message) }),
  });
  const deleteMutation = trpc.blocks.deleteSubscription.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
      showSuccessNotification({ title: 'Removed', message: 'Subscription removed.' });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not remove', error: new Error(e.message) }),
  });

  const filtersChips: string[] = [
    ...((sub.targetModelTypes ?? []) as string[]),
    ...((sub.targetBaseModels ?? []) as string[]),
  ];
  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs">
            <Text fw={500} className="truncate">
              {manifest.name ?? sub.blockId}
            </Text>
            <Badge size="xs" variant="light">
              {sub.scope === 'publisher_all_my_models' ? 'On my models' : 'On pages I view'}
            </Badge>
          </Group>
          {filtersChips.length > 0 ? (
            <Group gap={4}>
              {filtersChips.map((c) => (
                <Badge key={c} size="xs" variant="outline">
                  {c}
                </Badge>
              ))}
            </Group>
          ) : (
            <Text size="xs" c="dimmed">
              Applies to all models
            </Text>
          )}
        </Stack>
        <Group gap="xs">
          <Switch
            checked={sub.enabled}
            disabled={upsertMutation.isLoading}
            onChange={(e) => {
              const next = e.currentTarget.checked;
              upsertMutation.mutate({
                appBlockId: sub.appBlockId,
                scope: sub.scope,
                targetModelTypes: sub.targetModelTypes,
                targetBaseModels: sub.targetBaseModels,
                settings: sub.settings as Record<string, unknown>,
                enabled: next,
              });
            }}
            label={sub.enabled ? 'Enabled' : 'Disabled'}
          />
          <ActionIcon variant="default" onClick={() => onManage(sub)} title="Settings">
            <IconSettings size={16} />
          </ActionIcon>
          <ActionIcon
            variant="default"
            color="red"
            disabled={deleteMutation.isLoading}
            onClick={() => deleteMutation.mutate({ subscriptionId: sub.id })}
            title="Remove"
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>
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
            {grant.scopes.length === 0 ? (
              <Text size="xs" c="dimmed" fs="italic">
                This app doesn't claim any JWT scopes — it only consumes data from the host-bridge
                postMessage protocol.
              </Text>
            ) : (
              <Stack gap={4}>
                {grant.scopes.map((scope) => {
                  const desc = SCOPE_DESCRIPTIONS[scope];
                  return (
                    <Group key={scope} gap="xs" wrap="nowrap" align="flex-start">
                      <Badge size="sm" variant="light">
                        {scope}
                      </Badge>
                      {desc ? (
                        <Text size="xs" c="dimmed">
                          {desc}
                        </Text>
                      ) : (
                        <Text size="xs" c="dimmed" fs="italic">
                          (no description)
                        </Text>
                      )}
                    </Group>
                  );
                })}
              </Stack>
            )}
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
          <Text size="sm" c="dimmed">
            Apps haven't taken any actions on your behalf yet.
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
                    : humaniseScopeInvocation(item.scope)}
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
                    {item.endpoint}
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

function humaniseScopeInvocation(scope: string): string {
  return SCOPE_ACTION_LABELS[scope] ?? scope;
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

type ModelInstallSurface = {
  blockInstanceId: string;
  installId: string;
  modelId: number;
  modelName: string;
  modelVersionId: number | null;
  slotId: string;
  enabled: boolean;
  pinnedVersion: string | null;
  appBlockId: string;
  appSlug: string;
  appName: string;
  currentVersion: string | null;
  availableVersions: { version: string; approvedAt: Date | null }[];
};

const PIN_LATEST_VALUE = '__latest__';

function ModelInstallRow({ install }: { install: ModelInstallSurface }) {
  const utils = trpc.useUtils();
  const pinMutation = trpc.blocks.setInstallPinnedVersion.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMyModelInstalls.invalidate();
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not change version', error: new Error(e.message) }),
  });
  const uninstallMutation = trpc.blocks.uninstallFromModel.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.blocks.listMyModelInstalls.invalidate(),
        utils.blocks.listMyScopeGrants.invalidate(),
        utils.blocks.listForModel.invalidate({ modelId: install.modelId }),
      ]);
      showSuccessNotification({
        title: 'Removed',
        message: `Uninstalled ${install.appName} from ${install.modelName}.`,
      });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not uninstall', error: new Error(e.message) }),
  });

  const versionOptions: { value: string; label: string }[] = [
    {
      value: PIN_LATEST_VALUE,
      label: install.currentVersion
        ? `Latest (${install.currentVersion})`
        : 'Latest',
    },
    ...install.availableVersions.map((v) => ({
      value: v.version,
      label: v.version,
    })),
  ];

  const onConfirmUninstall = () => {
    openConfirmModal({
      title: `Uninstall ${install.appName}?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            This removes the install row entirely. The block will stop appearing on{' '}
            <strong>{install.modelName}</strong>. Any platform default for the same slot will
            become eligible again. The app's data and any other installs of it are untouched.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Uninstall', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        uninstallMutation.mutate({ blockInstanceId: install.blockInstanceId });
      },
    });
  };

  return (
    <Card withBorder padding="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" gap="md" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} className="truncate">
              {install.appName}
            </Text>
            <Badge size="xs" variant="outline">
              {install.appSlug}
            </Badge>
            {!install.enabled && (
              <Badge size="xs" variant="light" color="gray">
                Disabled
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            on{' '}
            <Anchor component={Link} href={`/models/${install.modelId}`} size="xs">
              {install.modelName}
            </Anchor>{' '}
            · slot <code>{install.slotId}</code>
          </Text>
        </Stack>

        <Group gap="xs" wrap="nowrap" align="flex-start">
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
              value={install.pinnedVersion ?? PIN_LATEST_VALUE}
              disabled={pinMutation.isPending || uninstallMutation.isPending}
              onChange={(value) => {
                if (value == null) return;
                const next = value === PIN_LATEST_VALUE ? null : value;
                if (next === install.pinnedVersion) return;
                pinMutation.mutate({
                  blockInstanceId: install.blockInstanceId,
                  version: next,
                });
              }}
              comboboxProps={{ withinPortal: true }}
              aria-label={`Version for ${install.appName} on ${install.modelName}`}
            />
          </Tooltip>
          <ActionIcon
            variant="default"
            color="red"
            disabled={uninstallMutation.isPending}
            onClick={onConfirmUninstall}
            title="Uninstall"
            aria-label={`Uninstall ${install.appName} from ${install.modelName}`}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>
    </Card>
  );
}

function ModelInstallsPanel() {
  const { data, isLoading } = trpc.blocks.listMyModelInstalls.useQuery();

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!data || data.length === 0) {
    return (
      <Center py="md">
        <Stack align="center" gap="xs">
          <IconBox size={28} opacity={0.5} />
          <Text size="sm" c="dimmed">
            You haven't installed any apps on a model yet.
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
      {(data as ModelInstallSurface[]).map((install) => (
        <ModelInstallRow key={install.blockInstanceId} install={install} />
      ))}
    </Stack>
  );
}

export default function InstalledAppsPage() {
  const features = useFeatureFlags();
  const { data: subs, isLoading } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks,
  });

  const { publisher, viewer } = useMemo(() => {
    const pub: SubscriptionRecord[] = [];
    const view: SubscriptionRecord[] = [];
    for (const s of subs ?? []) {
      if (s.scope === 'publisher_all_my_models') pub.push(s);
      else view.push(s);
    }
    return { publisher: pub, viewer: view };
  }, [subs]);

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
                Subscriptions
              </Tabs.Tab>
              <Tabs.Tab value="model-installs" leftSection={<IconBox size={14} />}>
                Model installs
              </Tabs.Tab>
              <Tabs.Tab value="permissions" leftSection={<IconShieldLock size={14} />}>
                Apps & permissions
              </Tabs.Tab>
              <Tabs.Tab value="activity" leftSection={<IconHistory size={14} />}>
                Recent activity
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="subscriptions" pt="md">
              {isLoading ? (
                <Center py="xl">
                  <Loader />
                </Center>
              ) : (
                <Stack gap="lg">
                  <Stack gap="xs">
                    <Title order={4}>On models I own</Title>
                    <Divider />
                    {publisher.length === 0 ? (
                      <EmptyState label="Nothing installed on your models yet." />
                    ) : (
                      publisher.map((sub) => (
                        <SubscriptionRow key={sub.id} sub={sub} onManage={handleManage} />
                      ))
                    )}
                  </Stack>

                  <Stack gap="xs">
                    <Title order={4}>On model pages I view</Title>
                    <Divider />
                    {viewer.length === 0 ? (
                      <EmptyState label="Nothing installed on pages you visit yet." />
                    ) : (
                      viewer.map((sub) => (
                        <SubscriptionRow key={sub.id} sub={sub} onManage={handleManage} />
                      ))
                    )}
                  </Stack>
                </Stack>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="model-installs" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">
                  Apps you've installed on a specific model. Pick which version's manifest the
                  host uses, or uninstall to remove the block from that model's page.
                </Text>
                <ModelInstallsPanel />
              </Stack>
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
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}

