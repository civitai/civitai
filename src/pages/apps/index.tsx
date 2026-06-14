import {
  Button,
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
import { IconPlugConnected, IconPlus, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { trpc } from '~/utils/trpc';

type SlotFilter = 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  // GATING INVARIANT (F-E E1): the flag gate is the ONLY access control; no
  // session→login redirect, so the marketplace renders for a session-less
  // request BEHIND the flag (dark today; lit when the segment widens). See
  // resolveAppsPageAccess for the full invariant + `deIndex` note.
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppsPage() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [slotFilter, setSlotFilter] = useState<SlotFilter | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

  // The marketplace listing is anon-CAPABLE (publicProcedure) — it fires for
  // any viewer who has the appBlocks flag, including a session-less one once
  // the segment widens (dark today). It returns only approved apps + a public
  // field allowlist.
  const { data: availableData, isLoading } = trpc.blocks.listAvailable.useQuery(
    {
      slotId: slotFilter ?? undefined,
      query: debouncedSearch || undefined,
      limit: 50,
    },
    { enabled: !!features.appBlocks }
  );
  // The per-user queries below are protectedProcedure — they 401 for an anon
  // viewer. Guard on a logged-in user so the dark anon read path doesn't fire
  // them. (`features.appBlocks` alone isn't enough: behind a widened segment an
  // anon viewer would still hit these.)
  const { data: mySubs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
  });
  // Lifetime earnings per owned app — feeds the "Earning $X" chip on
  // marketplace cards owned by the viewer. Visible only to the owner;
  // the trPC procedure is guarded so other users get nothing back.
  const { data: myAppsRaw } = trpc.blocks.getMyApps.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
  });
  const earningsByAppBlockId = useMemo(() => {
    type AppRow = { id: string; lifetimeShareCents: number };
    const map = new Map<string, number>();
    for (const a of (myAppsRaw ?? []) as AppRow[]) {
      map.set(a.id, a.lifetimeShareCents ?? 0);
    }
    return map;
  }, [myAppsRaw]);

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
      <Meta title="Apps — Civitai" description="Civitai App Blocks marketplace" deIndex />
      <Container size="xl" py="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Title order={2}>Civitai App Blocks</Title>
              <Text c="dimmed" size="sm">
                Add interactive blocks to your models, or subscribe to ones you want to see
                everywhere.
              </Text>
            </Stack>
            <Group gap="xs">
              {/* Bridge back to /apps/installed so users who subscribe from
                  the marketplace can find where to manage what they have.
                  Always rendered — /apps/installed handles the anon →
                  /login redirect itself. */}
              <Button
                component={Link}
                href="/apps/installed"
                leftSection={<IconPlugConnected size={16} />}
                variant="default"
              >
                My installed apps
              </Button>
              {/* Submit-new link — only rendered for the civitai-team (mod-gated
                  tRPC mutation would already reject anyone else). v1 replaces
                  the gate with the W1 review queue. */}
              <SubmitAppLink />
            </Group>
          </Group>

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
                    ownedEarningCents={earningsByAppBlockId.get(block.id)}
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

function SubmitAppLink() {
  // v0 gate: civitai-team only. The mutation already returns UNAUTHORIZED
  // to non-mods, so the worst case if the gate slips is a clear server-
  // side rejection rather than a silent leak.
  const user = useCurrentUser();
  if (!user?.isModerator) return null;
  return (
    <Button
      component={Link}
      href="/apps/submit"
      leftSection={<IconPlus size={16} />}
      variant="light"
    >
      Submit App
    </Button>
  );
}
