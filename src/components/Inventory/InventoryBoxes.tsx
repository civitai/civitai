import { Button, Center, Group, Loader, Paper, Stack, Table, Tabs, Text } from '@mantine/core';
import { useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useTeamColor } from '~/components/Events/events.utils';
import { MysteryBoxArt } from '~/components/MysteryBox/MysteryBoxArt';
import MysteryBoxModal from '~/components/MysteryBox/MysteryBoxModal';
import type { HeldMysteryBox } from '~/components/MysteryBox/mystery-box.utils';
import { boxActions, tierColor } from '~/components/MysteryBox/mystery-box.utils';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const DEFAULT_BOX_COLOR = 'var(--mantine-color-blue-5)';

export function InventoryBoxes() {
  const utils = trpc.useUtils();
  const { data: held, isLoading } = trpc.mysteryBox.getHeld.useQuery();
  const unopened = held?.reduce((total, view) => total + view.heldItems.length, 0);
  // The menu badge comes from checkNotifications, fetched once per page load; the list here is newer.
  useEffect(() => {
    if (unopened === undefined) return;
    utils.user.checkNotifications.setData(undefined, (counts) =>
      counts && counts.unopenedBoxes !== unopened ? { ...counts, unopenedBoxes: unopened } : counts
    );
  }, [unopened, utils]);

  return (
    <Tabs defaultValue="unopened" keepMounted={false}>
      <Tabs.List mb="md">
        <Tabs.Tab value="unopened">{unopened ? `Unopened (${unopened})` : 'Unopened'}</Tabs.Tab>
        <Tabs.Tab value="opened">Opened</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="unopened">
        <UnopenedBoxes held={held} isLoading={isLoading} />
      </Tabs.Panel>
      <Tabs.Panel value="opened">
        <OpenedBoxes />
      </Tabs.Panel>
    </Tabs>
  );
}

function UnopenedBoxes({ held, isLoading }: { held?: HeldMysteryBox[]; isLoading: boolean }) {
  const teamColor = useTeamColor();
  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  const rows = (held ?? []).flatMap((view) => view.heldItems.map((item) => ({ view, item })));
  if (!rows.length)
    return (
      <Text c="dimmed" py="xl" ta="center">
        Boxes you earn or buy and don&apos;t open land here.
      </Text>
    );

  return (
    <Stack gap="sm" data-testid="unopened-boxes">
      {rows.map(({ view, item }) => (
        <UnopenedBoxRow
          key={item.id}
          view={view}
          boxItemId={item.id}
          acquiredAt={item.acquiredAt}
          color={(view.team && teamColor(view.team)) || DEFAULT_BOX_COLOR}
        />
      ))}
    </Stack>
  );
}

function UnopenedBoxRow({
  view,
  boxItemId,
  acquiredAt,
  color,
}: {
  view: HeldMysteryBox;
  boxItemId: string;
  acquiredAt: Date;
  color: string;
}) {
  const { canOpen, complete } = boxActions(view);
  const open = () =>
    dialogStore.trigger({
      component: MysteryBoxModal,
      props: {
        source: { inventory: true },
        boxDefinitionId: view.boxDefinitionId,
        color,
        start: 'open',
        boxItemId,
      },
    });

  return (
    <Paper withBorder radius="md" p="sm" data-testid="unopened-box">
      <Group wrap="nowrap" gap="md">
        <MysteryBoxArt art={view.art} color={color} size={56} />
        <Stack gap={2} className="min-w-0 flex-1">
          <Text fw={600} truncate>
            {view.name}
          </Text>
          <Text size="xs" c="dimmed">
            {complete
              ? 'You have everything in it. It stays here until new contents arrive.'
              : `Got ${formatDate(acquiredAt)}`}
          </Text>
        </Stack>
        <Button onClick={open} disabled={!canOpen} data-box-item-id={boxItemId}>
          Open
        </Button>
      </Group>
    </Paper>
  );
}

function OpenedBoxes() {
  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.mysteryBox.getOpenings.useInfiniteQuery(
      { limit: 20 },
      { getNextPageParam: (page) => page.nextCursor }
    );
  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  const openings = data?.pages.flatMap((page) => page.items) ?? [];
  if (!openings.length)
    return (
      <Text c="dimmed" py="xl" ta="center">
        Nothing opened yet.
      </Text>
    );

  return (
    <Stack gap="md">
      <Table.ScrollContainer minWidth={480}>
        <Table verticalSpacing="xs" data-testid="opened-boxes">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Reward</Table.Th>
              <Table.Th>Rarity</Table.Th>
              <Table.Th>From</Table.Th>
              <Table.Th>When</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {openings.map((opening) => (
              <Table.Tr key={opening.boxItemId}>
                <Table.Td>
                  <Group gap="xs" wrap="nowrap">
                    {opening.reward?.url && (
                      <EdgeMedia
                        src={opening.reward.url}
                        width={64}
                        className="size-8 object-contain"
                        loading="lazy"
                      />
                    )}
                    <Text size="sm">{opening.reward?.name ?? 'A reward'}</Text>
                  </Group>
                </Table.Td>
                <Table.Td className="whitespace-nowrap">
                  {opening.tier && (
                    <Text size="xs" fw={700} tt="uppercase" c={tierColor(opening.tier)}>
                      {opening.tier.name}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{opening.box?.name}</Text>
                </Table.Td>
                <Table.Td className="whitespace-nowrap">
                  <Text size="sm" c="dimmed">
                    {formatDate(opening.openedAt)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {hasNextPage && (
        <Center>
          <Button variant="default" onClick={() => fetchNextPage()} loading={isFetchingNextPage}>
            Load more
          </Button>
        </Center>
      )}
    </Stack>
  );
}
