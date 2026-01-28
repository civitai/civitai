import {
  Anchor,
  Badge,
  Button,
  Code,
  Container,
  Divider,
  Drawer,
  Group,
  Loader,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconBan, IconCheck, IconGavel, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Meta } from '~/components/Meta/Meta';
import UserBanModal from '~/components/Profile/UserBanModal';
import { useIsMobile } from '~/hooks/useIsMobile';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type RestrictionTrigger = {
  prompt?: string;
  negativePrompt?: string;
  source?: string;
  category?: string;
  matchedWord?: string;
  imageId?: number | null;
  time?: string;
};

function StatusBadge({ status }: { status: string }) {
  if (status === UserRestrictionStatus.Pending)
    return (
      <Badge color="yellow" variant="light">
        Pending
      </Badge>
    );
  if (status === UserRestrictionStatus.Upheld)
    return (
      <Badge color="red" variant="light">
        Upheld
      </Badge>
    );
  return (
    <Badge color="green" variant="light">
      Overturned
    </Badge>
  );
}

export default function GenerationRestrictionsPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | null>('Pending');
  const [usernameSearch, setUsernameSearch] = useState('');
  const [debouncedUsername] = useDebouncedValue(usernameSearch, 300);
  const [selectedRestriction, setSelectedRestriction] = useState<any | null>(null);
  const [resolveStatus, setResolveStatus] = useState<string | null>(null);
  const [resolveMessage, setResolveMessage] = useState('');

  const mobile = useIsMobile();
  const queryUtils = trpc.useUtils();

  const handleCloseDrawer = () => {
    setSelectedRestriction(null);
    setResolveStatus(null);
    setResolveMessage('');
  };

  const parsedUserId = debouncedUsername ? Number(debouncedUsername) : NaN;
  const isUserIdSearch =
    !Number.isNaN(parsedUserId) && Number.isInteger(parsedUserId) && parsedUserId > 0;

  const { data, isLoading } = trpc.userRestriction.getAll.useQuery({
    page,
    limit: 20,
    status:
      (statusFilter as (typeof UserRestrictionStatus)[keyof typeof UserRestrictionStatus]) ||
      undefined,
    username: !isUserIdSearch && debouncedUsername ? debouncedUsername : undefined,
    userId: isUserIdSearch ? parsedUserId : undefined,
  });

  const resolveMutation = trpc.userRestriction.resolve.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Restriction resolved',
        message: 'The restriction has been resolved.',
      });
      queryUtils.userRestriction.getAll.invalidate();
      handleCloseDrawer();
    },
    onError: (err) => {
      showErrorNotification({ title: 'Error', error: new Error(err.message) });
    },
  });

  const allowlistMutation = trpc.userRestriction.addToAllowlist.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Added to allowlist',
        message: 'The trigger has been marked as benign.',
      });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Error', error: new Error(err.message) });
    },
  });

  const handleResolve = () => {
    if (!selectedRestriction || !resolveStatus) return;
    resolveMutation.mutate({
      userRestrictionId: selectedRestriction.id,
      status: resolveStatus as
        | typeof UserRestrictionStatus.Upheld
        | typeof UserRestrictionStatus.Overturned,
      resolvedMessage: resolveMessage || undefined,
    });
  };

  const handleAddToAllowlist = (trigger: RestrictionTrigger, restrictionId: number) => {
    if (!trigger.matchedWord || !trigger.category) return;
    allowlistMutation.mutate({
      trigger: trigger.matchedWord,
      category: trigger.category,
      reason: `Marked benign from restriction #${restrictionId}`,
      userRestrictionId: restrictionId,
    });
  };

  const totalPages = data ? Math.ceil(data.totalCount / 20) : 0;

  return (
    <>
      <Meta title="Generation Restrictions" deIndex />
      <Container size="xl">
        <Stack gap="lg">
          <Title order={1}>Generation Restrictions</Title>
          <Text size="sm" c="dimmed">
            Review generation restrictions triggered by the prompt auditing system. Overturn false
            positives and mark triggers as benign to reduce future false positives.
          </Text>

          {/* Filters */}
          <Group>
            <TextInput
              placeholder="Search by username or user ID..."
              leftSection={<IconSearch size={16} />}
              value={usernameSearch}
              onChange={(e) => {
                setUsernameSearch(e.currentTarget.value);
                setPage(1);
                setSelectedRestriction(null);
              }}
              w={250}
            />
            <Select
              placeholder="All statuses"
              data={[
                { value: UserRestrictionStatus.Pending, label: 'Pending' },
                { value: UserRestrictionStatus.Upheld, label: 'Upheld' },
                { value: UserRestrictionStatus.Overturned, label: 'Overturned' },
              ]}
              value={statusFilter}
              onChange={(val) => {
                setStatusFilter(val);
                setPage(1);
                setSelectedRestriction(null);
              }}
              clearable
              w={180}
            />
          </Group>

          <Divider />

          {/* Table */}
          {isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : !data?.items.length ? (
            <Text c="dimmed" ta="center" py="xl">
              No generation restrictions found.
            </Text>
          ) : (
            <>
              <Table highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>User</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Triggers</Table.Th>
                    <Table.Th>Created</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.items.map((restriction) => {
                    const triggers = (restriction.triggers as RestrictionTrigger[]) ?? [];
                    const categories = [
                      ...new Set(triggers.map((t) => t.category).filter(Boolean)),
                    ];
                    return (
                      <Table.Tr
                        key={restriction.id}
                        onClick={() => setSelectedRestriction(restriction)}
                        className={clsx(
                          'cursor-pointer',
                          selectedRestriction?.id === restriction.id &&
                            'bg-blue-1 dark:bg-dark-5'
                        )}
                      >
                        <Table.Td>
                          {restriction.user?.username ? (
                            <Text size="sm" fw={500}>
                              {restriction.user.username}
                            </Text>
                          ) : (
                            <Text size="sm" fw={500}>
                              User #{restriction.userId}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <StatusBadge status={restriction.status} />
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {triggers.length} trigger{triggers.length !== 1 ? 's' : ''}
                          </Text>
                          {categories.length > 0 && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {categories.join(', ')}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{formatDate(restriction.createdAt)}</Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>

              {totalPages > 1 && (
                <Group justify="center">
                  <Pagination
                    value={page}
                    onChange={(p) => {
                      setPage(p);
                      setSelectedRestriction(null);
                    }}
                    total={totalPages}
                  />
                </Group>
              )}
            </>
          )}
        </Stack>
      </Container>

      {/* Detail Drawer */}
      <Drawer
        withOverlay={false}
        opened={!!selectedRestriction}
        onClose={handleCloseDrawer}
        position={mobile ? 'bottom' : 'right'}
        size={mobile ? '100%' : 'xl'}
        padding="md"
        shadow="sm"
        zIndex={500}
        title={<Text fw={600}>Restriction #{selectedRestriction?.id}</Text>}
        classNames={{
          content: 'border-l border-l-gray-3 dark:border-l-dark-4',
        }}
      >
        {selectedRestriction && (
          <ScrollArea h="calc(100vh - 80px)" offsetScrollbars>
            <Stack gap="md">
              {/* User Header */}
              <Group justify="space-between">
                <Group>
                  <Text size="sm" fw={500}>
                    User:
                  </Text>
                  {selectedRestriction.user?.username ? (
                    <Anchor href={`/user/${selectedRestriction.user.username}`} size="sm">
                      {selectedRestriction.user.username}
                    </Anchor>
                  ) : (
                    <Text size="sm">User #{selectedRestriction.userId}</Text>
                  )}
                </Group>
                {selectedRestriction.user?.username && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconBan size={14} />}
                    onClick={() =>
                      dialogStore.trigger({
                        component: UserBanModal,
                        props: {
                          userId: selectedRestriction.userId,
                          username: selectedRestriction.user.username as string,
                        },
                      })
                    }
                  >
                    Ban User
                  </Button>
                )}
              </Group>

              <Group>
                <Text size="sm" fw={500}>
                  Status:
                </Text>
                <StatusBadge status={selectedRestriction.status} />
                <Text size="sm" c="dimmed" ml="md">
                  {formatDate(selectedRestriction.createdAt)}
                </Text>
              </Group>

              {/* Trigger Details */}
              <Divider label="Trigger Details" />
              {((selectedRestriction.triggers as RestrictionTrigger[]) ?? []).map(
                (trigger: RestrictionTrigger, i: number) => (
                  <Stack
                    key={i}
                    gap="xs"
                    className="rounded border border-solid border-gray-3 p-3 dark:border-dark-4"
                  >
                    {trigger.prompt && (
                      <div>
                        <Text size="xs" fw={500} c="dimmed">
                          Prompt
                        </Text>
                        <Code block>{trigger.prompt}</Code>
                      </div>
                    )}
                    {trigger.negativePrompt && (
                      <div>
                        <Text size="xs" fw={500} c="dimmed">
                          Negative Prompt
                        </Text>
                        <Code block>{trigger.negativePrompt}</Code>
                      </div>
                    )}
                    <Group>
                      {trigger.source && (
                        <div>
                          <Text size="xs" fw={500} c="dimmed">
                            Source
                          </Text>
                          <Text size="sm">{trigger.source}</Text>
                        </div>
                      )}
                      {trigger.category && (
                        <div>
                          <Text size="xs" fw={500} c="dimmed">
                            Category
                          </Text>
                          <Text size="sm">{trigger.category}</Text>
                        </div>
                      )}
                      {trigger.matchedWord && (
                        <div>
                          <Text size="xs" fw={500} c="dimmed">
                            Matched Word
                          </Text>
                          <Code>{trigger.matchedWord}</Code>
                        </div>
                      )}
                      {trigger.time && (
                        <div>
                          <Text size="xs" fw={500} c="dimmed">
                            Time
                          </Text>
                          <Text size="sm">{formatDate(new Date(trigger.time))}</Text>
                        </div>
                      )}
                    </Group>
                    {trigger.matchedWord && trigger.category && (
                      <Button
                        size="xs"
                        variant="light"
                        color="green"
                        leftSection={<IconShieldCheck size={14} />}
                        onClick={() => handleAddToAllowlist(trigger, selectedRestriction.id)}
                        loading={allowlistMutation.isLoading}
                      >
                        Mark as Benign
                      </Button>
                    )}
                  </Stack>
                )
              )}

              {/* User Context */}
              {selectedRestriction.userMessage && (
                <>
                  <Divider label="User Context" />
                  <Stack
                    gap="xs"
                    className="rounded border border-solid border-blue-3 bg-blue-0 p-3 dark:border-dark-4 dark:bg-dark-6"
                  >
                    <Text size="xs" c="dimmed">
                      Submitted{' '}
                      {selectedRestriction.userMessageAt
                        ? formatDate(selectedRestriction.userMessageAt)
                        : ''}
                    </Text>
                    <Text size="sm">{selectedRestriction.userMessage}</Text>
                  </Stack>
                </>
              )}

              {/* Resolution */}
              {selectedRestriction.resolvedAt && (
                <>
                  <Divider label="Resolution" />
                  <Stack gap="xs">
                    <Group>
                      <Text size="sm" fw={500}>
                        Resolved:
                      </Text>
                      <Text size="sm">{formatDate(selectedRestriction.resolvedAt)}</Text>
                    </Group>
                    {selectedRestriction.resolvedMessage && (
                      <Text size="sm">{selectedRestriction.resolvedMessage}</Text>
                    )}
                  </Stack>
                </>
              )}

              {/* Resolve Actions */}
              {selectedRestriction.status === UserRestrictionStatus.Pending && (
                <>
                  <Divider label="Resolve" />
                  <Select
                    label="Decision"
                    placeholder="Select decision..."
                    data={[
                      {
                        value: UserRestrictionStatus.Overturned,
                        label: 'Overturn (unmute user)',
                      },
                      { value: UserRestrictionStatus.Upheld, label: 'Uphold (keep muted)' },
                    ]}
                    value={resolveStatus}
                    onChange={setResolveStatus}
                  />
                  <Textarea
                    label="Message to user (optional)"
                    placeholder="Provide context for your decision..."
                    value={resolveMessage}
                    onChange={(e) => setResolveMessage(e.currentTarget.value)}
                    maxLength={1000}
                    minRows={2}
                    maxRows={4}
                    autosize
                  />
                  <Group justify="flex-end">
                    <Button variant="default" onClick={handleCloseDrawer}>
                      Cancel
                    </Button>
                    <Button
                      color={resolveStatus === UserRestrictionStatus.Upheld ? 'red' : 'green'}
                      leftSection={
                        resolveStatus === UserRestrictionStatus.Upheld ? (
                          <IconGavel size={16} />
                        ) : (
                          <IconCheck size={16} />
                        )
                      }
                      disabled={!resolveStatus}
                      loading={resolveMutation.isLoading}
                      onClick={handleResolve}
                    >
                      {resolveStatus === UserRestrictionStatus.Upheld
                        ? 'Uphold Restriction'
                        : 'Overturn Restriction'}
                    </Button>
                  </Group>
                </>
              )}
            </Stack>
          </ScrollArea>
        )}
      </Drawer>
    </>
  );
}
