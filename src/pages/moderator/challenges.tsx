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
  Popover,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import {
  IconCalendarEvent,
  IconDots,
  IconFilter,
  IconPencil,
  IconPlus,
  IconRobot,
  IconSettings,
  IconTrash,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const statusOptions = [
  { value: 'all', label: 'All Statuses' },
  { value: ChallengeStatus.Scheduled, label: 'Scheduled' },
  { value: ChallengeStatus.Active, label: 'Active' },
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
  [ChallengeStatus.Scheduled]: 'blue',
  [ChallengeStatus.Active]: 'green',
  [ChallengeStatus.Completed]: 'teal',
  [ChallengeStatus.Cancelled]: 'red',
};

function SystemSettingsPopover() {
  const [opened, { close, toggle }] = useDisclosure(false);
  const queryUtils = trpc.useUtils();
  const { data: config, isLoading: configLoading } = trpc.challenge.getSystemConfig.useQuery();
  const { data: judges = [], isLoading: judgesLoading } = trpc.challenge.getJudges.useQuery();

  const updateMutation = trpc.challenge.updateSystemConfig.useMutation({
    onMutate: async (newConfig) => {
      // Cancel outgoing refetches
      await queryUtils.challenge.getSystemConfig.cancel();

      // Snapshot previous value
      const previousConfig = queryUtils.challenge.getSystemConfig.getData();

      // Optimistically update cache
      const selectedJudge = newConfig.defaultJudgeId
        ? judges.find((j) => j.id === newConfig.defaultJudgeId)
        : null;

      queryUtils.challenge.getSystemConfig.setData(undefined, {
        defaultJudgeId: newConfig.defaultJudgeId,
        defaultJudge: selectedJudge
          ? { id: selectedJudge.id, name: selectedJudge.name, bio: selectedJudge.bio }
          : null,
      });

      return { previousConfig };
    },
    onSuccess: () => {
      showSuccessNotification({ message: 'Default judge updated' });
      close();
    },
    onError: (error, _variables, context) => {
      // Rollback on error
      if (context?.previousConfig) {
        queryUtils.challenge.getSystemConfig.setData(undefined, context.previousConfig);
      }
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const isLoading = configLoading || judgesLoading;

  return (
    <Popover
      opened={opened}
      onChange={toggle}
      position="bottom-end"
      width={320}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <Tooltip label="System Settings" position="bottom">
          <ActionIcon variant="default" size="lg" onClick={toggle}>
            <IconSettings size={18} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text fw={600} size="sm">
            System Challenge Settings
          </Text>
          {isLoading ? (
            <Center py="sm">
              <Loader size="sm" />
            </Center>
          ) : (
            <Select
              label="Default Judge"
              description="For auto-generated challenges"
              placeholder="Select a judge"
              data={judges.map((j) => ({ value: String(j.id), label: j.name }))}
              defaultValue={config?.defaultJudgeId ? String(config.defaultJudgeId) : null}
              onChange={(v) => updateMutation.mutate({ defaultJudgeId: v ? Number(v) : null })}
              disabled={updateMutation.isPending}
              leftSection={<IconRobot size={16} />}
              size="sm"
              clearable={false}
              allowDeselect={false}
            />
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export default function ModeratorChallengesPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
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

  // Quick action mutations
  const endAndPickWinnersMutation = trpc.challenge.endAndPickWinners.useMutation({
    onSuccess: (data) => {
      queryUtils.challenge.getModeratorList.invalidate();
      showSuccessNotification({
        message: `Challenge ended. ${data.winnersCount} winner(s) selected.`,
      });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const voidChallengeMutation = trpc.challenge.voidChallenge.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getModeratorList.invalidate();
      showSuccessNotification({ message: 'Challenge cancelled' });
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

  const isActioning =
    endAndPickWinnersMutation.isLoading ||
    voidChallengeMutation.isLoading ||
    deleteMutation.isLoading;

  const challenges = data?.pages.flatMap((page) => page.items) ?? [];

  const handleClearFilters = () => {
    setQuery('');
    setStatus('all');
    setSource('all');
  };

  const handleEndAndPickWinners = (challengeId: number, title: string) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'End & Pick Winners',
        message: (
          <Stack gap="xs">
            <Text>
              Are you sure you want to end <strong>&ldquo;{title}&rdquo;</strong> and pick winners
              now?
            </Text>
            <Text size="sm" c="dimmed">
              This will close the collection, run the winner selection process, and award prizes.
            </Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'End & Pick Winners' },
        onConfirm: () => endAndPickWinnersMutation.mutateAsync({ id: challengeId }),
      },
    });
  };

  const handleVoidChallenge = (challengeId: number, title: string) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Void Challenge',
        message: (
          <Stack gap="xs">
            <Text>
              Are you sure you want to void <strong>&ldquo;{title}&rdquo;</strong>?
            </Text>
            <Text size="sm" c="dimmed">
              This will cancel the challenge without picking winners. Users will keep their entry
              prizes (if any were awarded).
            </Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'Void Challenge' },
        confirmProps: { color: 'red' },
        onConfirm: () => voidChallengeMutation.mutateAsync({ id: challengeId }),
      },
    });
  };

  const handleDelete = (challengeId: number) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete Challenge',
        message: <Text>Are you sure you want to delete this challenge?</Text>,
        labels: { cancel: 'Cancel', confirm: 'Delete' },
        confirmProps: { color: 'red' },
        onConfirm: () => deleteMutation.mutateAsync({ id: challengeId }),
      },
    });
  };

  if (!features.challengePlatform) {
    return <NotFound />;
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
              <Group gap="sm">
                <SystemSettingsPopover />
                <Button
                  component={Link}
                  href="/moderator/challenges/events"
                  leftSection={<IconCalendarEvent size={16} />}
                  variant="light"
                >
                  Events
                </Button>
                <Button
                  component={Link}
                  href="/moderator/challenges/create"
                  leftSection={<IconPlus size={16} />}
                >
                  Create Challenge
                </Button>
              </Group>
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

                              {/* Quick Actions based on status */}
                              {challenge.status === ChallengeStatus.Active && (
                                <>
                                  <Menu.Divider />
                                  <Menu.Label>Quick Actions</Menu.Label>
                                  <Menu.Item
                                    leftSection={<IconTrophy size={14} />}
                                    disabled={isActioning}
                                    onClick={() =>
                                      handleEndAndPickWinners(challenge.id, challenge.title)
                                    }
                                  >
                                    End & Pick Winners
                                  </Menu.Item>
                                  <Menu.Item
                                    leftSection={<IconX size={14} />}
                                    color="red"
                                    disabled={isActioning}
                                    onClick={() =>
                                      handleVoidChallenge(challenge.id, challenge.title)
                                    }
                                  >
                                    Void Challenge
                                  </Menu.Item>
                                </>
                              )}

                              {challenge.status === ChallengeStatus.Scheduled && (
                                <>
                                  <Menu.Divider />
                                  <Menu.Label>Quick Actions</Menu.Label>
                                  <Menu.Item
                                    leftSection={<IconX size={14} />}
                                    color="red"
                                    disabled={isActioning}
                                    onClick={() =>
                                      handleVoidChallenge(challenge.id, challenge.title)
                                    }
                                  >
                                    Cancel Challenge
                                  </Menu.Item>
                                </>
                              )}

                              <Menu.Divider />
                              <Menu.Item
                                leftSection={<IconTrash size={14} />}
                                color="red"
                                disabled={isActioning}
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
