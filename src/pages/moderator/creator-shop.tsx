import {
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck, IconCircleCheck, IconCircleX, IconSearch, IconX } from '@tabler/icons-react';
import type { ComponentProps } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  useMutateCreatorShop,
  useQueryCreatorShopReviewQueue,
} from '~/components/CreatorShop/creator-shop.util';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { showErrorNotification } from '~/utils/notifications';

type StatusFilter = CosmeticShopItemStatus | 'all';

const statusFilterOptions: { label: string; value: StatusFilter }[] = [
  { label: 'Pending Review', value: CosmeticShopItemStatus.PendingReview },
  { label: 'Published', value: CosmeticShopItemStatus.Published },
  { label: 'Rejected', value: CosmeticShopItemStatus.Rejected },
  { label: 'All', value: 'all' },
];

type SampleCosmetic = ComponentProps<typeof CosmeticSample>['cosmetic'];
type PreviewCosmetic = ComponentProps<typeof CosmeticPreview>['cosmetic'];

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ features }) => {
    if (!features?.creatorShop) return { notFound: true };
  },
});

function CreatorShopReviewPage() {
  const currentUser = useCurrentUser();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    CosmeticShopItemStatus.PendingReview
  );
  const [usernameInput, setUsernameInput] = useState('');
  const [debouncedUsername] = useDebouncedValue(usernameInput, 300);

  const { data, isLoading } = useQueryCreatorShopReviewQueue({
    enabled: !!currentUser?.isModerator,
    status: statusFilter === 'all' ? undefined : statusFilter,
    username: debouncedUsername,
  });
  const { reviewItem } = useMutateCreatorShop();

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (selectedId == null && items.length) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedMeta = (selected?.meta ?? {}) as CosmeticShopItemMeta;

  if (currentUser && !currentUser.isModerator) return <NotFound />;

  const handleApprove = async () => {
    if (!selected) return;
    await reviewItem.mutateAsync({ id: selected.id, action: 'approve' });
    setSelectedId(null);
    setReason('');
  };

  const handleReject = async () => {
    if (!selected) return;
    if (!reason.trim())
      return showErrorNotification({
        title: 'Reason required',
        error: new Error('Enter a rejection reason'),
      });
    await reviewItem.mutateAsync({
      id: selected.id,
      action: 'reject',
      rejectionReason: reason.trim(),
    });
    setSelectedId(null);
    setReason('');
  };

  return (
    <Container size="xl" py="md">
      <Group gap="sm" mb="md">
        <Title order={3}>Creator Shop · Review Queue</Title>
        <Badge color="yellow" variant="light">
          {items.length} {statusFilter === 'all' ? 'items' : getDisplayName(statusFilter)}
        </Badge>
      </Group>

      <Group gap="md" mb="md" align="flex-end" wrap="wrap">
        <SegmentedControl
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value as StatusFilter);
            setSelectedId(null);
          }}
          data={statusFilterOptions}
        />
        <TextInput
          label="Filter by creator"
          placeholder="username"
          value={usernameInput}
          onChange={(e) => {
            setUsernameInput(e.currentTarget.value);
            setSelectedId(null);
          }}
          leftSection={<IconSearch size={16} />}
          w={240}
        />
      </Group>

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Paper withBorder radius="md" p="xl">
          <Text ta="center" c="dimmed">
            Nothing to review right now.
          </Text>
        </Paper>
      ) : (
        <Group align="flex-start" gap="md" grow={false} wrap="nowrap">
          {/* Queue */}
          <Paper withBorder radius="md" w={340} style={{ flex: 'none' }}>
            <ScrollArea.Autosize mah={640}>
              <Stack gap={0}>
                {items.map((item) => {
                  const active = item.id === selectedId;
                  return (
                    <UnstyledButton
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      p="sm"
                      style={{
                        borderBottom: '1px solid var(--mantine-color-dark-4)',
                        background: active ? 'var(--mantine-color-dark-6)' : undefined,
                      }}
                    >
                      <Group gap="sm" wrap="nowrap">
                        <div style={{ width: 40, height: 40 }}>
                          <CosmeticSample
                            cosmetic={item.cosmetic as unknown as SampleCosmetic}
                            size="sm"
                          />
                        </div>
                        <Stack gap={0} style={{ flex: 1 }}>
                          <Text size="sm" fw={600} lineClamp={1}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed">
                            @{item.cosmetic.creator?.username ?? 'unknown'} ·{' '}
                            {getDisplayName(item.cosmetic.type)}
                          </Text>
                        </Stack>
                        <Text size="xs" fw={600}>
                          {numberWithCommas(item.unitAmount)}
                        </Text>
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          </Paper>

          {/* Detail */}
          {selected && (
            <Paper withBorder radius="md" p="lg" style={{ flex: 1 }}>
              <Stack>
                <Group gap="sm" align="center">
                  <Title order={4}>{selected.title}</Title>
                  <Badge variant="light">{getDisplayName(selected.cosmetic.type)}</Badge>
                </Group>
                <Text size="sm" c="dimmed">
                  Submitted by @{selected.cosmetic.creator?.username ?? 'unknown'}
                </Text>

                <Group align="flex-start" gap="lg">
                  <Stack gap="md" style={{ width: 300, flexShrink: 0 }}>
                    <Center
                      style={{
                        height: 220,
                        background: 'var(--mantine-color-dark-8)',
                        borderRadius: 8,
                      }}
                    >
                      <CosmeticSample
                        cosmetic={selected.cosmetic as unknown as SampleCosmetic}
                        size="lg"
                      />
                    </Center>
                    <Stack gap={4}>
                      <Text size="xs" fw={600} c="dimmed">
                        Preview in context
                      </Text>
                      <CosmeticPreview cosmetic={selected.cosmetic as unknown as PreviewCosmetic} />
                    </Stack>
                  </Stack>
                  <Stack gap="sm" style={{ flex: 1 }}>
                    <Group gap="xl">
                      <Stack gap={0}>
                        <Text size="xs" c="dimmed">
                          List price
                        </Text>
                        <Text fw={700}>{numberWithCommas(selected.unitAmount)} Buzz</Text>
                      </Stack>
                      <Stack gap={0}>
                        <Text size="xs" c="dimmed">
                          Creator earns (70%)
                        </Text>
                        <Text fw={700} c="green">
                          {numberWithCommas(Math.floor(selected.unitAmount * 0.7))} Buzz
                        </Text>
                      </Stack>
                    </Group>
                    {!!selectedMeta.autoChecks?.length && (
                      <Stack gap={4}>
                        <Text size="xs" fw={600}>
                          Automated checks
                        </Text>
                        {selectedMeta.autoChecks.map((c) => (
                          <Group key={c.key} gap={6} wrap="nowrap">
                            {c.passed ? (
                              <IconCircleCheck size={16} color="var(--mantine-color-green-5)" />
                            ) : (
                              <IconCircleX size={16} color="var(--mantine-color-red-5)" />
                            )}
                            <Text size="xs" c={c.passed ? undefined : 'red'}>
                              {c.label}
                              {c.detail ? ` · ${c.detail}` : ''}
                            </Text>
                          </Group>
                        ))}
                      </Stack>
                    )}
                    {selected.description && <Text size="sm">{selected.description}</Text>}
                    <Textarea
                      label="Rejection reason (required to reject)"
                      value={reason}
                      onChange={(e) => setReason(e.currentTarget.value)}
                      autosize
                      minRows={2}
                    />
                  </Stack>
                </Group>

                <Group justify="flex-end">
                  <Button
                    color="red"
                    variant="light"
                    leftSection={<IconX size={16} />}
                    loading={reviewItem.isPending}
                    onClick={handleReject}
                  >
                    Reject
                  </Button>
                  <Button
                    color="green"
                    leftSection={<IconCheck size={16} />}
                    loading={reviewItem.isPending}
                    onClick={handleApprove}
                  >
                    Approve &amp; Publish
                  </Button>
                </Group>
              </Stack>
            </Paper>
          )}
        </Group>
      )}
    </Container>
  );
}

export default Page(CreatorShopReviewPage);
