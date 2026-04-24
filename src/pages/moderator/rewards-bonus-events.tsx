import { Badge, Button, Center, Container, Group, Pagination, Stack, Table, Text, Title } from '@mantine/core';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { Meta } from '~/components/Meta/Meta';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { RewardsBonusEventEditModal } from '~/components/RewardsBonusEvent/RewardsBonusEventEditModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ page: z.coerce.number().default(1) });

function formatMultiplier(stored: number): string {
  const value = stored / 10;
  if (value < 2) return `${Math.round((value - 1) * 100)}% more (${value}x)`;
  return `${value}x`;
}

function isActive(event: {
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}): boolean {
  if (!event.enabled) return false;
  const now = Date.now();
  const starts = event.startsAt ? new Date(event.startsAt).getTime() : -Infinity;
  const ends = event.endsAt ? new Date(event.endsAt).getTime() : Infinity;
  return starts <= now && now <= ends;
}

export default function RewardsBonusEventsPage() {
  const router = useRouter();
  const { page } = querySchema.parse(router.query);
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const { data, isLoading } = trpc.rewardsBonusEvent.getPaged.useQuery(
    { page },
    { enabled: !!currentUser?.isModerator }
  );

  const deleteMutation = trpc.rewardsBonusEvent.delete.useMutation({
    onSuccess: () => {
      queryUtils.rewardsBonusEvent.getPaged.invalidate();
      queryUtils.buzz.getUserMultipliers.invalidate();
    },
  });

  function openEdit(event?: Parameters<typeof RewardsBonusEventEditModal>[0]['event']) {
    dialogStore.trigger({
      component: RewardsBonusEventEditModal,
      props: { event },
    });
  }

  function handlePage(value: number) {
    router.replace({ query: { ...router.query, page: value } }, undefined, { shallow: true });
  }

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Rewards Bonus Events - Moderator" deIndex />
      <Container size="lg" py="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Stack gap={0}>
              <Title order={2}>Rewards Bonus Events</Title>
              <Text size="sm" c="dimmed">
                Site-wide multipliers on Blue Buzz rewards. Highest-multiplier active event wins.
              </Text>
            </Stack>
            <Button leftSection={<IconPlus size={16} />} onClick={() => openEdit()}>
              New Event
            </Button>
          </Group>

          {isLoading ? (
            <PageLoader />
          ) : !data || data.items.length === 0 ? (
            <Center py="xl">
              <Text c="dimmed">No rewards bonus events yet.</Text>
            </Center>
          ) : (
            <Table striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Multiplier</Table.Th>
                  <Table.Th>Window</Table.Th>
                  <Table.Th>Article</Table.Th>
                  <Table.Th style={{ width: 100 }}>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.items.map((event) => {
                  const active = isActive(event);
                  return (
                    <Table.Tr key={event.id}>
                      <Table.Td>
                        {active ? (
                          <Badge color="green">Active</Badge>
                        ) : event.enabled ? (
                          <Badge color="yellow">Scheduled</Badge>
                        ) : (
                          <Badge color="gray">Disabled</Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={0}>
                          <Text size="sm" fw={600}>
                            {event.name}
                          </Text>
                          {event.bannerLabel ? (
                            <Text size="xs" c="dimmed">
                              Banner: {event.bannerLabel}
                            </Text>
                          ) : null}
                        </Stack>
                      </Table.Td>
                      <Table.Td>{formatMultiplier(event.multiplier)}</Table.Td>
                      <Table.Td>
                        <Text size="xs">
                          {event.startsAt ? formatDate(event.startsAt) : 'now'}
                          {' → '}
                          {event.endsAt ? formatDate(event.endsAt) : 'no end'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {event.articleId ? (
                          <Text size="xs">
                            <a href={`/articles/${event.articleId}`} target="_blank" rel="noreferrer">
                              #{event.articleId}
                            </a>
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <LegacyActionIcon onClick={() => openEdit(event)}>
                            <IconPencil size={16} />
                          </LegacyActionIcon>
                          <PopConfirm
                            onConfirm={() => deleteMutation.mutate({ id: event.id })}
                            withinPortal
                          >
                            <LegacyActionIcon loading={deleteMutation.isLoading} color="red">
                              <IconTrash size={16} />
                            </LegacyActionIcon>
                          </PopConfirm>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}

          {data && data.totalPages > 1 && (
            <Group justify="end">
              <Pagination value={page} total={data.totalPages} onChange={handlePage} />
            </Group>
          )}
        </Stack>
      </Container>
    </>
  );
}
