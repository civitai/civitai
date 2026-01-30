import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  Code,
  Divider,
  Loader,
  Pagination,
  Select,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconBan,
  IconCheck,
  IconGavel,
  IconPhoto,
  IconSearch,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { UserGenerationsDrawer } from '~/components/Moderation/UserGenerationsDrawer';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Meta } from '~/components/Meta/Meta';
import UserBanModal from '~/components/Profile/UserBanModal';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { createSelectStore } from '~/store/select.store';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { Page } from '~/components/AppLayout/Page';

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
  matchedRegex?: string;
  imageId?: number | null;
  time?: string;
};

const { useSelection, useIsSelected, toggle, setSelected, useIsSelecting } =
  createSelectStore<string>('generation-restriction-selection');

function HighlightedPrompt({
  text,
  highlight,
  regexPattern,
}: {
  text: string;
  highlight?: string;
  regexPattern?: string;
}) {
  const containerClass =
    'max-h-48 overflow-auto whitespace-pre-wrap rounded border border-solid border-gray-3 bg-gray-0 p-2 text-sm dark:border-dark-4 dark:bg-dark-6';

  if (!text) {
    return <div className={containerClass}>{text}</div>;
  }

  let matchedText: string | null = null;

  if (highlight && text.toLowerCase().includes(highlight.toLowerCase())) {
    matchedText = highlight;
  }

  if (!matchedText && regexPattern) {
    try {
      const patternRegex = new RegExp(regexPattern, 'gi');
      const match = patternRegex.exec(text);
      if (match) matchedText = match[0];
    } catch {
      // Invalid regex
    }
  }

  if (!matchedText) {
    return <div className={containerClass}>{text}</div>;
  }

  const escapedMatch = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escapedMatch})`, 'gi'));

  return (
    <div className={containerClass}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-yellow-3 px-0.5 text-black dark:bg-yellow-5">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </div>
  );
}

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

function TriggerCard({ trigger, triggerKey }: { trigger: RestrictionTrigger; triggerKey: string }) {
  const isSelected = useIsSelected(triggerKey);

  return (
    <div
      className={clsx(
        'rounded border border-solid p-4',
        isSelected
          ? 'border-yellow-5 bg-yellow-1 dark:border-yellow-7 dark:bg-yellow-9/20'
          : 'border-gray-3 dark:border-dark-4'
      )}
    >
      <div className="grid grid-cols-[280px_1fr] gap-4">
        <div className="flex flex-col gap-2">
          <Checkbox
            checked={isSelected}
            onChange={() => toggle(triggerKey)}
            label="Flag as suspicious"
          />
          <div className="flex items-center gap-2">
            {trigger.source && (
              <Badge size="sm" variant="light">
                {trigger.source}
              </Badge>
            )}
            {trigger.category && (
              <Badge size="sm" variant="light" color="red">
                {trigger.category}
              </Badge>
            )}
          </div>
          {trigger.matchedWord && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Matched Text
              </Text>
              <Code className="text-sm">{trigger.matchedWord}</Code>
            </div>
          )}
          {trigger.matchedRegex && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Regex Pattern
              </Text>
              <Tooltip label={trigger.matchedRegex} multiline w={500}>
                <Code className="block max-w-[250px] truncate text-xs">
                  {trigger.matchedRegex.length > 50
                    ? trigger.matchedRegex.substring(0, 50) + '...'
                    : trigger.matchedRegex}
                </Code>
              </Tooltip>
            </div>
          )}
          {trigger.time && (
            <div>
              <Text size="xs" fw={500} c="dimmed">
                Time
              </Text>
              <Text size="xs">{formatDate(new Date(trigger.time))}</Text>
            </div>
          )}
        </div>
        <div className="min-w-0">
          {trigger.prompt && (
            <div className="mb-2">
              <Text size="xs" fw={500} c="dimmed" mb={4}>
                Prompt
              </Text>
              <HighlightedPrompt
                text={trigger.prompt}
                highlight={trigger.matchedWord}
                regexPattern={trigger.matchedRegex}
              />
            </div>
          )}
          {trigger.negativePrompt && (
            <div>
              <Text size="xs" fw={500} c="dimmed" mb={4}>
                Negative Prompt
              </Text>
              <HighlightedPrompt
                text={trigger.negativePrompt}
                highlight={trigger.matchedWord}
                regexPattern={trigger.matchedRegex}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GenerationRestrictionsPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | null>('Pending');
  const [usernameSearch, setUsernameSearch] = useState('');
  const [debouncedUsername] = useDebouncedValue(usernameSearch, 300);
  const [selectedRestriction, setSelectedRestriction] = useState<any | null>(null);
  const [generationsDrawerOpened, { open: openGenerationsDrawer, close: closeGenerationsDrawer }] =
    useDisclosure(false);

  const selectedKeys = useSelection();
  const isSelecting = useIsSelecting();
  const queryUtils = trpc.useUtils();

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

  const selectNextRestriction = () => {
    if (!data?.items || !selectedRestriction) {
      setSelectedRestriction(null);
      return;
    }
    const currentIndex = data.items.findIndex((r) => r.id === selectedRestriction.id);
    const nextItem = data.items[currentIndex + 1] ?? data.items[currentIndex - 1] ?? null;
    setSelectedRestriction(nextItem);
    setSelected([]);
  };

  const handleActionComplete = () => {
    selectNextRestriction();
    queryUtils.userRestriction.getAll.invalidate();
  };

  const resolveMutation = trpc.userRestriction.resolve.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Restriction resolved',
        message: 'The restriction has been resolved.',
      });
      handleActionComplete();
    },
    onError: (err) => showErrorNotification({ title: 'Error', error: new Error(err.message) }),
  });

  const saveSuspiciousMutation = trpc.userRestriction.saveSuspiciousMatches.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'Saved',
        message: `${data.savedCount} suspicious matches saved for review.`,
      });
      setSelected([]);
    },
    onError: (err) => showErrorNotification({ title: 'Error', error: new Error(err.message) }),
  });

  const handleUphold = () => {
    if (!selectedRestriction) return;
    resolveMutation.mutate({
      userRestrictionId: selectedRestriction.id,
      status: UserRestrictionStatus.Upheld,
    });
  };

  const handleRemoveMute = () => {
    if (!selectedRestriction) return;
    resolveMutation.mutate({
      userRestrictionId: selectedRestriction.id,
      status: UserRestrictionStatus.Overturned,
    });
  };

  const handleBanUser = () => {
    if (!selectedRestriction?.user?.username) return;
    const restrictionId = selectedRestriction.id;
    dialogStore.trigger({
      component: UserBanModal,
      props: {
        userId: selectedRestriction.userId,
        username: selectedRestriction.user.username,
        onSuccess: () => {
          // Also resolve the restriction as Upheld when banning
          resolveMutation.mutate({
            userRestrictionId: restrictionId,
            status: UserRestrictionStatus.Upheld,
          });
        },
      },
    });
  };

  const triggersWithKeys = useMemo(() => {
    if (!selectedRestriction) return [];
    const triggers = (selectedRestriction.triggers as RestrictionTrigger[]) ?? [];
    return triggers.map((trigger, index) => ({
      trigger,
      key: `${selectedRestriction.id}-${index}`,
    }));
  }, [selectedRestriction]);

  const handleSaveSuspicious = () => {
    if (!selectedRestriction) return;
    const matches = selectedKeys
      .map((key) => {
        const item = triggersWithKeys.find((t) => t.key === key);
        if (!item) return null;
        return {
          odometer: selectedRestriction.id,
          userId: selectedRestriction.userId,
          prompt: item.trigger.prompt ?? '',
          negativePrompt: item.trigger.negativePrompt,
          check: item.trigger.category ?? 'unknown',
          matchedText: item.trigger.matchedWord ?? '',
          regex: item.trigger.matchedRegex,
          context: undefined,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (matches.length > 0) saveSuspiciousMutation.mutate({ matches });
  };

  const totalPages = data ? Math.ceil(data.totalCount / 20) : 0;

  return (
    <>
      <Meta title="Generation Restrictions" deIndex />
      <div className="flex flex-1 gap-6 overflow-hidden p-4">
        {/* Left Side */}
        <div className="flex w-[500px] flex-col">
          {/* Fixed Header */}
          <div className="flex flex-col gap-4 pb-4">
            <Title order={1}>Generation Restrictions</Title>
            <Text size="sm" c="dimmed">
              Review generation restrictions triggered by the prompt auditing system.
            </Text>
            <div className="flex items-center gap-2">
              <TextInput
                placeholder="Search by username or user ID..."
                leftSection={<IconSearch size={16} />}
                value={usernameSearch}
                onChange={(e) => {
                  setUsernameSearch(e.currentTarget.value);
                  setPage(1);
                  setSelectedRestriction(null);
                  setSelected([]);
                }}
                className="flex-1"
              />
              <Select
                placeholder="Status"
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
                  setSelected([]);
                }}
                clearable
                w={120}
              />
            </div>
            <Divider />
          </div>

          {/* Scrollable Table */}
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader />
            </div>
          ) : !data?.items.length ? (
            <Text c="dimmed" ta="center" py="xl">
              No generation restrictions found.
            </Text>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                <Table highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>User</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Created</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.items.map((restriction) => (
                      <Table.Tr
                        key={restriction.id}
                        onClick={() => {
                          setSelectedRestriction(restriction);
                          setSelected([]);
                        }}
                        className={clsx(
                          'cursor-pointer',
                          selectedRestriction?.id === restriction.id && 'bg-blue-1 dark:bg-dark-5'
                        )}
                      >
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {restriction.user?.username ?? `User #${restriction.userId}`}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <StatusBadge status={restriction.status} />
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{formatDate(restriction.createdAt)}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
              {totalPages > 1 && (
                <div className="flex justify-center pt-4">
                  <Pagination
                    value={page}
                    onChange={(p) => {
                      setPage(p);
                      setSelectedRestriction(null);
                      setSelected([]);
                    }}
                    total={totalPages}
                    size="sm"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right Side */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedRestriction ? (
            <>
              {/* Fixed Header */}
              <div className="flex flex-col gap-4 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Text size="sm" fw={500}>
                      User:
                    </Text>
                    {selectedRestriction.user?.username ? (
                      <Anchor
                        href={`/user/${selectedRestriction.user.username}`}
                        size="sm"
                        target="_blank"
                      >
                        {selectedRestriction.user.username}
                      </Anchor>
                    ) : (
                      <Text size="sm">User #{selectedRestriction.userId}</Text>
                    )}
                    <StatusBadge status={selectedRestriction.status} />
                    <Text size="sm" c="dimmed">
                      {formatDate(selectedRestriction.createdAt)}
                    </Text>
                  </div>
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPhoto size={14} />}
                    onClick={openGenerationsDrawer}
                  >
                    View Generations
                  </Button>
                </div>

                {selectedRestriction.status === UserRestrictionStatus.Pending && (
                  <div className="flex items-center gap-2">
                    <Button
                      color="red"
                      leftSection={<IconGavel size={16} />}
                      loading={resolveMutation.isPending}
                      onClick={handleUphold}
                    >
                      Uphold Mute
                    </Button>
                    <Button
                      color="green"
                      leftSection={<IconCheck size={16} />}
                      loading={resolveMutation.isPending}
                      onClick={handleRemoveMute}
                    >
                      Remove Mute
                    </Button>
                    {selectedRestriction.user?.username && (
                      <Button
                        color="red"
                        variant="light"
                        leftSection={<IconBan size={16} />}
                        onClick={handleBanUser}
                      >
                        Ban User
                      </Button>
                    )}
                    {isSelecting && (
                      <Button
                        color="yellow"
                        leftSection={<IconAlertTriangle size={16} />}
                        loading={saveSuspiciousMutation.isPending}
                        onClick={handleSaveSuspicious}
                      >
                        Flag {selectedKeys.length} Suspicious
                      </Button>
                    )}
                  </div>
                )}

                <Divider label={`${triggersWithKeys.length} Triggers`} />
              </div>

              {/* Scrollable Content */}
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex flex-col gap-4">
                  {triggersWithKeys.map(({ trigger, key }) => (
                    <TriggerCard key={key} trigger={trigger} triggerKey={key} />
                  ))}

                  {selectedRestriction.userMessage && (
                    <>
                      <Divider label="User Context" />
                      <div className="rounded border border-solid border-blue-3 bg-blue-0 p-3 dark:border-dark-4 dark:bg-dark-6">
                        <Text size="xs" c="dimmed">
                          Submitted{' '}
                          {selectedRestriction.userMessageAt
                            ? formatDate(selectedRestriction.userMessageAt)
                            : ''}
                        </Text>
                        <Text size="sm">{selectedRestriction.userMessage}</Text>
                      </div>
                    </>
                  )}

                  {selectedRestriction.resolvedAt && (
                    <>
                      <Divider label="Resolution" />
                      <div className="flex items-center gap-2">
                        <Text size="sm" fw={500}>
                          Resolved:
                        </Text>
                        <Text size="sm">{formatDate(selectedRestriction.resolvedAt)}</Text>
                      </div>
                      {selectedRestriction.resolvedMessage && (
                        <Text size="sm">{selectedRestriction.resolvedMessage}</Text>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Text c="dimmed">Select a restriction to view details</Text>
            </div>
          )}
        </div>
      </div>

      {selectedRestriction && (
        <UserGenerationsDrawer
          opened={generationsDrawerOpened}
          onClose={closeGenerationsDrawer}
          userId={selectedRestriction.userId}
          username={selectedRestriction.user?.username}
        />
      )}
    </>
  );
}

export default Page(GenerationRestrictionsPage, { scrollable: false });
