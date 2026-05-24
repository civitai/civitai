import {
  Center,
  Chip,
  Container,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

type SlotFilter = 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';

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

export default function AppsPage() {
  const features = useFeatureFlags();
  const [slotFilter, setSlotFilter] = useState<SlotFilter | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

  const { data: availableData, isLoading } = trpc.blocks.listAvailable.useQuery(
    {
      slotId: slotFilter ?? undefined,
      query: debouncedSearch || undefined,
      limit: 50,
    },
    { enabled: !!features.appBlocks }
  );
  const { data: mySubs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks,
  });

  // Index existing subscriptions by appBlockId so we know whether to show
  // Install vs Manage on each card.
  const subsByBlock = useMemo(() => {
    const map = new Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>();
    for (const sub of mySubs ?? []) {
      const existing = map.get(sub.appBlockId) ?? {};
      existing[sub.scope] = sub;
      map.set(sub.appBlockId, existing);
    }
    return map;
  }, [mySubs]);

  function handleOpen(block: AvailableBlock) {
    openAppSettingsModal({
      block,
      existingByScope: subsByBlock.get(block.id) ?? {},
    });
  }

  if (!features.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="Apps — Civitai" description="Civitai App Blocks marketplace" />
      <Container size="xl" py="md">
        <Stack gap="md">
          <Stack gap={4}>
            <Title order={2}>Civitai App Blocks</Title>
            <Text c="dimmed" size="sm">
              Add interactive blocks to your models, or subscribe to ones you want to see
              everywhere.
            </Text>
          </Stack>

          <Group gap="md" align="end">
            <TextInput
              label="Search"
              placeholder="Search by name or block id"
              leftSection={<IconSearch size={16} />}
              value={searchInput}
              onChange={(e) => setSearchInput(e.currentTarget.value)}
              style={{ flex: 1, minWidth: 240 }}
            />
            <Chip.Group
              value={slotFilter ?? ''}
              onChange={(v) => setSlotFilter((v || null) as SlotFilter | null)}
            >
              <Group gap={6}>
                <Chip value="">All slots</Chip>
                <Chip value="model.sidebar_top">Model sidebar</Chip>
                <Chip value="model.below_images">Below images</Chip>
                <Chip value="model.actions_extra">Model actions</Chip>
              </Group>
            </Chip.Group>
          </Group>

          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : (availableData?.items ?? []).length === 0 ? (
            <Center py="xl">
              <Stack align="center" gap={4}>
                <Text size="lg" fw={500}>
                  No app blocks match
                </Text>
                <Text size="sm" c="dimmed">
                  Try clearing your filters or search query.
                </Text>
              </Stack>
            </Center>
          ) : (
            <Grid gutter="md">
              {(availableData?.items ?? []).map((block) => (
                <Grid.Col key={block.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
                  <AppBlockCard
                    block={block}
                    alreadySubscribed={subsByBlock.has(block.id)}
                    onOpen={handleOpen}
                  />
                </Grid.Col>
              ))}
            </Grid>
          )}
        </Stack>
      </Container>
    </>
  );
}
