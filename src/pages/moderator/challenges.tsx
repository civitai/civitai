import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Flex,
  Group,
  Loader,
  Menu,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconCheck,
  IconDots,
  IconFilter,
  IconPencil,
  IconPlus,
  IconTrash,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const statusOptions = [
  { value: 'all', label: 'All Statuses' },
  { value: ChallengeStatus.Draft, label: 'Draft' },
  { value: ChallengeStatus.Scheduled, label: 'Scheduled' },
  { value: ChallengeStatus.Active, label: 'Active' },
  { value: ChallengeStatus.Judging, label: 'Judging' },
  { value: ChallengeStatus.Completed, label: 'Completed' },
  { value: ChallengeStatus.Cancelled, label: 'Cancelled' },
];

const sourceOptions = [
  { value: 'all', label: 'All Sources' },
  { value: ChallengeSource.System, label: 'System' },
  { value: ChallengeSource.Mod, label: 'Moderator' },
  { value: ChallengeSource.User, label: 'User' },
];

const statusColors: Record<ChallengeStatus, string> = {
  [ChallengeStatus.Draft]: 'gray',
  [ChallengeStatus.Scheduled]: 'blue',
  [ChallengeStatus.Active]: 'green',
  [ChallengeStatus.Judging]: 'yellow',
  [ChallengeStatus.Completed]: 'teal',
  [ChallengeStatus.Cancelled]: 'red',
};

export default function ModeratorChallengesPage() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 500);
  const [status, setStatus] = useState<string>('all');
  const [source, setSource] = useState<string>('all');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.challenge.getModeratorList.useInfiniteQuery(
      {
        query: debouncedQuery || undefined,
        status: status !== 'all' ? [status as ChallengeStatus] : undefined,
        source: source !== 'all' ? [source as ChallengeSource] : undefined,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!currentUser?.isModerator,
      }
    );

  const updateStatusMutation = trpc.challenge.updateStatus.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getModeratorList.invalidate();
      showSuccessNotification({ message: 'Challenge status updated' });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const deleteMutation = trpc.challenge.delete.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getModeratorList.invalidate();
      showSuccessNotification({ message: 'Challenge deleted' });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const challenges = data?.pages.flatMap((page) => page.items) ?? [];

  const handleClearFilters = () => {
    setQuery('');
    setStatus('all');
    setSource('all');
  };

  const handleStatusChange = (challengeId: number, newStatus: ChallengeStatus) => {
    updateStatusMutation.mutate({ id: challengeId, status: newStatus });
  };

  const handleDelete = (challengeId: number) => {
    if (confirm('Are you sure you want to delete this challenge?')) {
      deleteMutation.mutate({ id: challengeId });
    }
  };

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Challenge Management - Moderator" deIndex />
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: 'var(--mantine-spacing-md)' }}>
        <Stack gap="md">
          {/* Header */}
          <Card withBorder>
            <Group justify="space-between">
              <Group align="center">
                <IconTrophy size={32} />
                <div>
                  <Title order={2}>Challenge Management</Title>
                  <Text size="sm" c="dimmed">
                    Create, edit, and manage challenges
                  </Text>
                </div>
              </Group>
              <Button
                component={Link}
                href="/moderator/challenges/create"
                leftSection={<IconPlus size={16} />}
              >
                Create Challenge
              </Button>
            </Group>
          </Card>

          {/* Filters */}
          <Card withBorder>
            <Stack gap="md">
              <Group align="center">
                <IconFilter size={20} />
                <Text fw={600}>Filters</Text>
              </Group>
              <Group align="end">
                <TextInput
                  label="Search"
                  placeholder="Search by title or theme..."
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Select
                  label="Status"
                  data={statusOptions}
                  value={status}
                  onChange={(value) => setStatus(value ?? 'all')}
                  style={{ minWidth: 150 }}
                />
                <Select
                  label="Source"
                  data={sourceOptions}
                  value={source}
                  onChange={(value) => setSource(value ?? 'all')}
                  style={{ minWidth: 150 }}
                />
                <Button
                  variant="subtle"
                  leftSection={<IconX size={16} />}
                  onClick={handleClearFilters}
                >
                  Clear
                </Button>
              </Group>
            </Stack>
          </Card>

          {/* Challenge List */}
          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : challenges.length === 0 ? (
            <NoContent message="No challenges found" />
          ) : (
            <Stack gap="md">
              {challenges.map((challenge) => {
                const isVisible = new Date() >= challenge.visibleAt;

                return (
                  <Card key={challenge.id} withBorder>
                    <Flex gap="md" align="flex-start" justify="space-between">
                      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                        <Group justify="space-between" wrap="nowrap">
                          <Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
                            <Link href={`/challenges/${challenge.id}`} passHref legacyBehavior>
                              <Text
                                fw={600}
                                size="md"
                                style={{ cursor: 'pointer' }}
                                lineClamp={1}
                                component="a"
                              >
                                {challenge.title}
                              </Text>
                            </Link>
                            <Badge size="sm" color={isVisible ? 'green' : 'gray'} variant="light">
                              {isVisible ? 'Visible' : 'Hidden'}
                            </Badge>
                            <Badge
                              color={statusColors[challenge.status]}
                              variant="filled"
                              size="sm"
                            >
                              {challenge.status}
                            </Badge>
                            <Badge
                              color={
                                challenge.source === ChallengeSource.System
                                  ? 'gray'
                                  : challenge.source === ChallengeSource.Mod
                                  ? 'cyan'
                                  : 'grape'
                              }
                              variant="light"
                              size="sm"
                            >
                              {challenge.source}
                            </Badge>
                          </Group>

                          {/* Actions Menu */}
                          <Menu position="bottom-end" withinPortal>
                            <Menu.Target>
                              <ActionIcon variant="subtle">
                                <IconDots size={16} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Label>Actions</Menu.Label>
                              <Menu.Item
                                leftSection={<IconPencil size={14} />}
                                component={Link}
                                href={`/moderator/challenges/${challenge.id}/edit`}
                              >
                                Edit
                              </Menu.Item>
                              <Menu.Divider />
                              <Menu.Label>Change Status</Menu.Label>
                              {Object.values(ChallengeStatus).map((s) => (
                                <Menu.Item
                                  key={s}
                                  leftSection={
                                    challenge.status === s ? <IconCheck size={14} /> : null
                                  }
                                  onClick={() => handleStatusChange(challenge.id, s)}
                                  disabled={challenge.status === s}
                                >
                                  {s}
                                </Menu.Item>
                              ))}
                              <Menu.Divider />
                              <Menu.Item
                                leftSection={<IconTrash size={14} />}
                                color="red"
                                onClick={() => handleDelete(challenge.id)}
                              >
                                Delete
                              </Menu.Item>
                            </Menu.Dropdown>
                          </Menu>
                        </Group>
                        <Group gap="md" wrap="wrap">
                          <Text size="xs" c="dimmed">
                            Starts: {formatDate(challenge.startsAt)}
                          </Text>
                          <Text size="xs" c="dimmed">
                            Ends: {formatDate(challenge.endsAt)}
                          </Text>
                        </Group>

                        {challenge.theme && (
                          <Text size="sm" c="dimmed">
                            Theme: {challenge.theme}
                          </Text>
                        )}

                        <Group gap="md">
                          <CurrencyBadge
                            currency={Currency.BUZZ}
                            unitAmount={challenge.prizePool}
                            size="sm"
                          />
                          <Text size="sm" c="dimmed">
                            {challenge.entryCount}{' '}
                            {challenge.entryCount === 1 ? 'entry' : 'entries'}
                          </Text>
                          <Text size="sm" c="dimmed">
                            by {challenge.creatorUsername}
                          </Text>
                        </Group>
                      </Stack>
                    </Flex>
                  </Card>
                );
              })}

              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
                  <Center py="xl">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </Stack>
          )}
        </Stack>
      </div>
    </>
  );
}
