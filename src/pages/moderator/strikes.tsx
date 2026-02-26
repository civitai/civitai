import type { ComboboxItem } from '@mantine/core';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Container,
  Divider,
  Drawer,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconAlertCircle, IconCheck, IconExternalLink } from '@tabler/icons-react';
import type {
  MRT_ColumnDef,
  MRT_ColumnFiltersState,
  MRT_PaginationState,
  MRT_SortingState,
} from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { useEffect, useMemo, useState } from 'react';
import type * as z from 'zod';
import { UserScoreDisplay } from '~/components/Account/UserScoreDisplay';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Form, InputNumber, InputSelect, InputTextArea, useForm } from '~/libs/form';
import { createStrikeSchema, strikeStatusColorScheme } from '~/server/schema/strike.schema';
import type { UserStandingRow } from '~/server/schema/strike.schema';
import { EntityType, StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

// ============================================================================
// Helpers
// ============================================================================
function getEntityLink(entityType: string | null, entityId: number | null): string | null {
  if (!entityType || !entityId) return null;
  const map: Record<string, string> = {
    Image: '/images/',
    Model: '/models/',
    Article: '/articles/',
    Post: '/posts/',
    Bounty: '/bounties/',
    BountyEntry: '/bounties/entries/',
    Collection: '/collections/',
    ModelVersion: '/models/',
    Comment: '/comments/',
    CommentV2: '/comments/v2/',
    User: '/user/',
  };
  const prefix = map[entityType];
  if (!prefix) return null;
  return `${prefix}${entityId}`;
}

type SortValue = 'points' | 'score' | 'lastStrike' | 'created';

const sortColumnMap: Record<string, SortValue> = {
  totalActivePoints: 'points',
  userScore: 'score',
  lastStrikeDate: 'lastStrike',
  createdAt: 'created',
};

// ============================================================================
// Main Page Component
// ============================================================================
export default function Strikes() {
  const features = useFeatureFlags();
  if (!features.strikes) return <NotFound />;
  return <StrikesContent />;
}

function StrikesContent() {
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [issueModalOpened, { open: openIssueModal, close: closeIssueModal }] = useDisclosure(false);
  const [issueDefaultUserId, setIssueDefaultUserId] = useState<number | undefined>();

  const [columnFilters, setColumnFilters] = useState<MRT_ColumnFiltersState>([]);
  const [sorting, setSorting] = useState<MRT_SortingState>([
    { id: 'totalActivePoints', desc: true },
  ]);
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  // Extract typed filter values from MRT column filters with runtime validation
  const usernameFilterRaw = columnFilters.find((f) => f.id === 'username')?.value;
  const usernameFilter = typeof usernameFilterRaw === 'string' ? usernameFilterRaw : undefined;
  const statusFilterRaw = columnFilters.find((f) => f.id === 'userStatus')?.value;
  const statusFilter = Array.isArray(statusFilterRaw) ? (statusFilterRaw as string[]) : undefined;

  // Map MRT sort to schema sort
  const activeSortCol = sorting[0]?.id;
  const activeSortDir = sorting[0]?.desc ? 'desc' : 'asc';
  const sort: SortValue = sortColumnMap[activeSortCol] ?? 'points';

  const {
    data,
    isLoading,
    isFetching,
    isError: isTableError,
    error: tableError,
  } = trpc.strike.getUserStandings.useQuery(
    {
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
      username: usernameFilter || undefined,
      isMuted: statusFilter?.includes('muted') || undefined,
      isFlaggedForReview: statusFilter?.includes('flagged') || undefined,
      sort,
      sortOrder: activeSortDir,
    },
    { keepPreviousData: true }
  );

  const handleOpenIssueModal = (defaultUserId?: number) => {
    setIssueDefaultUserId(defaultUserId);
    openIssueModal();
  };

  const columns = useMemo<MRT_ColumnDef<UserStandingRow>[]>(
    () => [
      {
        id: 'actions',
        header: '',
        Cell: ({ row: { original: user } }) => (
          <Button
            size="compact-xs"
            onClick={() => setSelectedUserId(user.id)}
            aria-label={`View standing for ${user.username ?? `User ${user.id}`}`}
          >
            View
          </Button>
        ),
        enableSorting: false,
        enableColumnFilter: false,
        enableColumnActions: false,
        size: 70,
      },
      {
        id: 'username',
        header: 'Username',
        accessorFn: (row) => row.username ?? `User ${row.id}`,
        filterVariant: 'text',
        enableSorting: false,
        Cell: ({ row: { original: user } }) => (
          <Link legacyBehavior href={`/user/${user.username ?? user.id}`} passHref>
            <Text component="a" c="blue.4" target="_blank" size="sm">
              {user.username ?? `User ${user.id}`}
            </Text>
          </Link>
        ),
      },
      {
        id: 'userScore',
        header: 'User Score',
        accessorFn: (row) => (row.userScore != null ? Math.round(row.userScore) : '—'),
        enableColumnFilter: false,
        size: 100,
      },
      {
        id: 'activeStrikeCount',
        header: 'Active Strikes',
        accessorFn: (row) => row.activeStrikeCount,
        enableColumnFilter: false,
        enableSorting: false,
        size: 110,
        Cell: ({ row: { original: user } }) =>
          user.activeStrikeCount > 0 ? (
            <Badge color="red" size="md" variant="light">
              {user.activeStrikeCount}
            </Badge>
          ) : (
            <Text size="sm" c="dimmed">
              0
            </Text>
          ),
      },
      {
        id: 'totalActivePoints',
        header: 'Total Points',
        accessorFn: (row) => row.totalActivePoints,
        enableColumnFilter: false,
        size: 110,
        Cell: ({ row: { original: user } }) => {
          const pts = user.totalActivePoints;
          const color = pts >= 3 ? 'red' : pts >= 2 ? 'orange' : pts >= 1 ? 'yellow' : 'gray';
          return (
            <Badge color={color} size="md" variant="light">
              {pts} {pts === 1 ? 'pt' : 'pts'}
            </Badge>
          );
        },
      },
      {
        id: 'standing',
        header: 'Standing',
        enableColumnFilter: false,
        enableSorting: false,
        size: 110,
        Cell: ({ row: { original: user } }) => {
          const pts = user.totalActivePoints;
          const label = pts === 0 ? 'Good' : pts <= 1 ? 'Warning' : 'Restricted';
          const color = pts === 0 ? 'green' : pts <= 1 ? 'yellow' : 'red';
          return (
            <Badge color={color} size="md" variant="light">
              {label}
            </Badge>
          );
        },
      },
      {
        id: 'userStatus',
        header: 'Status',
        enableSorting: false,
        filterVariant: 'multi-select',
        mantineFilterMultiSelectProps: {
          data: [
            { label: 'Muted', value: 'muted' },
            { label: 'Flagged for Review', value: 'flagged' },
          ] as ComboboxItem[],
        },
        Cell: ({ row: { original: user } }) => (
          <Group gap={4}>
            {user.muted && (
              <Badge color="orange" size="sm" variant="light">
                Muted
              </Badge>
            )}
            {user.bannedAt && (
              <Badge color="red" size="sm" variant="light">
                Banned
              </Badge>
            )}
            {user.flaggedForReview && (
              <Badge color="pink" size="sm" variant="light">
                Flagged
              </Badge>
            )}
            {!user.muted && !user.bannedAt && !user.flaggedForReview && (
              <Text size="sm" c="dimmed">
                —
              </Text>
            )}
          </Group>
        ),
      },
      {
        id: 'lastStrikeDate',
        header: 'Last Strike',
        accessorFn: (row) => (row.lastStrikeDate ? formatDate(row.lastStrikeDate) : '—'),
        enableColumnFilter: false,
        size: 120,
      },
      {
        id: 'createdAt',
        header: 'Member Since',
        accessorFn: (row) => formatDate(row.createdAt),
        enableColumnFilter: false,
        size: 120,
      },
    ],
    []
  );

  return (
    <>
      <Meta title="Strikes" deIndex />
      <Container size="xl" pb="xl">
        <Stack>
          <Group justify="space-between" align="center">
            <Title>User Standings</Title>
            <Button onClick={() => handleOpenIssueModal()}>Issue Strike</Button>
          </Group>
          {isTableError && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
              Failed to load user standings: {tableError.message}
            </Alert>
          )}
          <MantineReactTable
            columns={columns}
            data={(data?.items as UserStandingRow[]) ?? []}
            manualFiltering
            manualPagination
            manualSorting
            onColumnFiltersChange={setColumnFilters}
            onPaginationChange={setPagination}
            onSortingChange={setSorting}
            enableMultiSort={false}
            rowCount={data?.totalItems ?? 0}
            enableStickyHeader
            enableHiding={false}
            enableGlobalFilter={false}
            mantineTableContainerProps={{
              className: 'max-h-[calc(100vh-360px)]',
            }}
            initialState={{ density: 'md' }}
            state={{
              isLoading,
              pagination,
              columnFilters,
              showProgressBars: isFetching,
              sorting,
            }}
          />
        </Stack>
      </Container>
      <UserStandingDrawer
        userId={selectedUserId}
        onClose={() => setSelectedUserId(null)}
        onIssueStrike={(userId) => handleOpenIssueModal(userId)}
      />
      <IssueStrikeModal
        opened={issueModalOpened}
        onClose={closeIssueModal}
        defaultUserId={issueDefaultUserId}
      />
    </>
  );
}

// ============================================================================
// User Standing Drawer
// ============================================================================
function UserStandingDrawer({
  userId,
  onClose,
  onIssueStrike,
}: {
  userId: number | null;
  onClose: () => void;
  onIssueStrike: (userId: number) => void;
}) {
  const mobile = useIsMobile();
  const [voidStrikeId, setVoidStrikeId] = useState<number | null>(null);

  const {
    data,
    isLoading,
    isError: isDrawerError,
    error: drawerError,
  } = trpc.strike.getUserHistory.useQuery({ userId: userId ?? 0 }, { enabled: userId != null });

  const user = data?.user;
  const strikes = data?.strikes ?? [];
  const totalActivePoints = data?.totalActivePoints ?? 0;
  const activeStrikeCount = strikes.filter(
    (s) => s.status === StrikeStatus.Active && new Date(s.expiresAt) > new Date()
  ).length;

  const standingColor =
    totalActivePoints === 0 ? 'green' : totalActivePoints <= 1 ? 'yellow' : 'red';
  const standingLabel =
    totalActivePoints === 0 ? 'Good Standing' : totalActivePoints <= 1 ? 'Warning' : 'Restricted';

  const scores = user?.scores;

  return (
    <>
      <Drawer
        withOverlay={false}
        opened={userId != null}
        onClose={onClose}
        position={mobile ? 'bottom' : 'right'}
        title="User Standing"
        size={mobile ? '100%' : 'xl'}
        padding="md"
        shadow="sm"
        zIndex={500}
        classNames={{
          content: 'border-l border-l-gray-3 dark:border-l-dark-4',
        }}
      >
        {isLoading ? (
          <Stack align="center" py="xl" role="status" aria-label="Loading user standing">
            <Loader size="sm" />
          </Stack>
        ) : isDrawerError ? (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
            Failed to load user data: {drawerError.message}
          </Alert>
        ) : !user ? (
          <Text c="dimmed">User not found.</Text>
        ) : (
          <Stack gap="lg">
            {/* Section 1: User Header */}
            <Stack gap="xs">
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  <Link legacyBehavior href={`/user/${user.username ?? user.id}`} passHref>
                    <Anchor size="lg" fw={700} target="_blank">
                      <Group gap={4}>
                        <Text inherit>{user.username ?? `User ${user.id}`}</Text>
                        <IconExternalLink size={14} stroke={1.5} />
                      </Group>
                    </Anchor>
                  </Link>
                  <Text size="sm" c="dimmed">
                    #{user.id}
                  </Text>
                </Group>
                <Badge
                  color={standingColor}
                  size="lg"
                  variant="light"
                  leftSection={totalActivePoints === 0 ? <IconCheck size={14} /> : undefined}
                >
                  {standingLabel}
                </Badge>
              </Group>
              <Group gap="xs">
                {user.muted && (
                  <Badge color="orange" size="sm" variant="light">
                    Muted
                  </Badge>
                )}
                {user.bannedAt && (
                  <Badge color="red" size="sm" variant="light">
                    Banned
                  </Badge>
                )}
                {user.flaggedForReview && (
                  <Badge color="pink" size="sm" variant="light">
                    Flagged for Review
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed">
                Member since {formatDate(user.createdAt)}
              </Text>
            </Stack>

            <Divider />

            {/* Section 2: User Score */}
            <UserScoreDisplay scores={scores} showReports />

            <Divider />

            {/* Section 3: Strike History */}
            <Group justify="space-between" align="center">
              <Text size="lg" fw={700}>
                Strikes
              </Text>
              {totalActivePoints > 0 && (
                <Badge color={standingColor} size="md" variant="light">
                  {activeStrikeCount} active &middot; {totalActivePoints}{' '}
                  {totalActivePoints === 1 ? 'pt' : 'pts'}
                </Badge>
              )}
            </Group>

            {strikes.length === 0 ? (
              <Text size="sm" c="dimmed">
                No strikes on record.
              </Text>
            ) : (
              <Stack gap="sm">
                {strikes.map((strike) => {
                  const entityLink = getEntityLink(strike.entityType, strike.entityId);
                  const isActive =
                    strike.status === StrikeStatus.Active &&
                    new Date(strike.expiresAt) > new Date();

                  return (
                    <Paper key={strike.id} withBorder p="md" radius="md">
                      <Stack gap="xs">
                        <Group justify="space-between" wrap="nowrap">
                          <Group gap="xs" wrap="nowrap">
                            <Badge
                              color={strikeStatusColorScheme[strike.status] ?? 'gray'}
                              size="sm"
                              variant="light"
                            >
                              {strike.status}
                            </Badge>
                            <Text size="sm" fw={600}>
                              {getDisplayName(strike.reason)}
                            </Text>
                          </Group>
                          <Badge
                            color={
                              strike.points >= 3 ? 'red' : strike.points >= 2 ? 'orange' : 'yellow'
                            }
                            size="sm"
                            variant="light"
                          >
                            {strike.points} {strike.points === 1 ? 'pt' : 'pts'}
                          </Badge>
                        </Group>

                        <Text size="sm">{strike.description}</Text>

                        {strike.internalNotes && (
                          <Text size="sm" c="dimmed" fs="italic">
                            Internal: {strike.internalNotes}
                          </Text>
                        )}

                        {entityLink && (
                          <Anchor href={entityLink} target="_blank" size="sm">
                            <Group gap={4}>
                              <Text inherit>
                                {strike.entityType} #{strike.entityId}
                              </Text>
                              <IconExternalLink size={14} stroke={1.5} />
                            </Group>
                          </Anchor>
                        )}

                        <Group justify="space-between">
                          <Text size="xs" c="dimmed">
                            Issued by {strike.issuedByUser?.username ?? 'System'} on{' '}
                            {formatDate(strike.createdAt)}
                          </Text>
                          <Text size="xs" c="dimmed">
                            Expires: {formatDate(strike.expiresAt)}
                          </Text>
                        </Group>

                        {strike.voidedAt && (
                          <Text size="xs" c="dimmed">
                            Voided on {formatDate(strike.voidedAt)}
                            {strike.voidReason ? ` — ${strike.voidReason}` : ''}
                          </Text>
                        )}

                        {isActive && (
                          <Button
                            size="compact-xs"
                            color="yellow"
                            variant="outline"
                            onClick={() => setVoidStrikeId(strike.id)}
                            style={{ alignSelf: 'flex-start' }}
                          >
                            Void
                          </Button>
                        )}
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            )}

            <Divider />

            {/* Section 4: Actions */}
            <Button
              onClick={() => {
                if (!userId) return;
                onClose();
                onIssueStrike(userId);
              }}
            >
              Issue Strike for this User
            </Button>
          </Stack>
        )}
      </Drawer>
      {voidStrikeId != null && (
        <VoidStrikeModal
          strikeId={voidStrikeId}
          opened
          onClose={() => setVoidStrikeId(null)}
          onSuccess={() => setVoidStrikeId(null)}
        />
      )}
    </>
  );
}

// ============================================================================
// Void Strike Modal
// ============================================================================
function VoidStrikeModal({
  strikeId,
  opened,
  onClose,
  onSuccess,
}: {
  strikeId: number;
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [voidReason, setVoidReason] = useState('');
  const queryUtils = trpc.useUtils();

  const voidMutation = trpc.strike.void.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Strike has been voided' });
      await Promise.all([
        queryUtils.strike.getUserStandings.invalidate(),
        queryUtils.strike.getUserHistory.invalidate(),
      ]);
      setVoidReason('');
      onClose();
      onSuccess();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleVoid = () => {
    if (!voidReason.trim()) return;
    voidMutation.mutate({ strikeId, voidReason: voidReason.trim() });
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Void Strike" centered>
      <Stack>
        <Text size="sm">
          Voiding a strike will remove its points from the user&apos;s total and may de-escalate any
          active mutes.
        </Text>
        <Textarea
          label="Void Reason"
          description="Required — explain why this strike is being voided"
          placeholder="Enter reason..."
          value={voidReason}
          onChange={(e) => setVoidReason(e.currentTarget.value)}
          minRows={3}
          autosize
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="yellow"
            onClick={handleVoid}
            loading={voidMutation.isPending}
            disabled={!voidReason.trim() || voidReason.trim().length > 1000}
          >
            Void Strike
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ============================================================================
// Issue Strike Modal
// ============================================================================
const issueStrikeFormSchema = createStrikeSchema;

function IssueStrikeModal({
  opened,
  onClose,
  defaultUserId,
}: {
  opened: boolean;
  onClose: () => void;
  defaultUserId?: number;
}) {
  const queryUtils = trpc.useUtils();

  const form = useForm({
    schema: issueStrikeFormSchema,
    defaultValues: {
      userId: defaultUserId ?? ('' as unknown as number),
      reason: StrikeReason.ManualModAction,
      points: 1,
      description: '',
      internalNotes: '',
      expiresInDays: 30,
    },
  });

  // Reset form when modal opens with a new defaultUserId
  useEffect(() => {
    if (opened) {
      form.reset({
        userId: defaultUserId ?? ('' as unknown as number),
        reason: StrikeReason.ManualModAction,
        points: 1,
        description: '',
        internalNotes: '',
        expiresInDays: 30,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, defaultUserId]);

  const createMutation = trpc.strike.create.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Strike has been issued' });
      await Promise.all([
        queryUtils.strike.getUserStandings.invalidate(),
        queryUtils.strike.getUserHistory.invalidate(),
      ]);
      form.reset();
      onClose();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleSubmit = (data: z.infer<typeof issueStrikeFormSchema>) => {
    createMutation.mutate({
      ...data,
      internalNotes: data.internalNotes || undefined,
      entityType: data.entityType || undefined,
      entityId: data.entityId || undefined,
    });
  };

  const reasonOptions = Object.values(StrikeReason).map((r) => ({
    label: getDisplayName(r),
    value: r,
  }));

  const entityTypeOptions = Object.values(EntityType).map((t) => ({
    label: getDisplayName(t),
    value: t,
  }));

  return (
    <Modal opened={opened} onClose={onClose} title="Issue Strike" centered size="lg">
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputNumber name="userId" label="User ID" placeholder="Enter user ID" required />
          <InputSelect name="reason" label="Reason" data={reasonOptions} required />
          <InputNumber
            name="points"
            label="Points"
            description="1 = warning, 2 = moderate, 3 = severe"
            min={1}
            max={3}
            required
          />
          <InputTextArea
            name="description"
            label="Description"
            description="User-facing — will be shown to the user in notifications"
            placeholder="Describe the violation..."
            minRows={3}
            autosize
            required
          />
          <InputTextArea
            name="internalNotes"
            label="Internal Notes"
            description="Mod-only — not visible to the user"
            placeholder="Optional internal notes..."
            minRows={2}
            autosize
          />
          <InputSelect
            name="entityType"
            label="Entity Type"
            description="Optional — link this strike to a specific entity"
            data={entityTypeOptions}
            clearable
          />
          <InputNumber name="entityId" label="Entity ID" placeholder="Optional" />
          <InputNumber
            name="expiresInDays"
            label="Expires In (days)"
            description="Default: 30 days"
            min={1}
            max={365}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createMutation.isPending}>
              Issue Strike
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
