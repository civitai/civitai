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
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { IconPlugConnected, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
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
import { createServerSideProps } from '~/server/utils/server-side-helpers';
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
      <Meta title="Installed Apps — Civitai" />
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
        </Stack>
      </Container>
    </>
  );
}
