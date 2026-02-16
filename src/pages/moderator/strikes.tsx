import type { ComboboxItem } from '@mantine/core';
import {
  Anchor,
  Badge,
  Button,
  Container,
  Drawer,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconExternalLink } from '@tabler/icons-react';
import type {
  MRT_ColumnDef,
  MRT_ColumnFiltersState,
  MRT_PaginationState,
  MRT_SortingState,
} from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { useMemo, useState } from 'react';
import type * as z from 'zod';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Form, InputNumber, InputSelect, InputTextArea, useForm } from '~/libs/form';
import { createStrikeSchema } from '~/server/schema/strike.schema';
import { strikeStatusColorScheme } from '~/server/schema/strike.schema';
import { EntityType, StrikeReason, StrikeStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

// ============================================================================
// Types
// ============================================================================
type StrikeItem = {
  id: number;
  userId: number;
  reason: string;
  status: string;
  points: number;
  description: string;
  internalNotes: string | null;
  entityType: string | null;
  entityId: number | null;
  reportId: number | null;
  createdAt: Date;
  expiresAt: Date;
  voidedAt: Date | null;
  voidedBy: number | null;
  voidReason: string | null;
  issuedBy: number | null;
  user: { id: number; username: string | null };
  issuedByUser: { id: number; username: string | null } | null;
};

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

// ============================================================================
// Main Page Component
// ============================================================================
export default function Strikes() {
  const [selected, setSelected] = useState<StrikeItem | null>(null);
  const [issueModalOpened, { open: openIssueModal, close: closeIssueModal }] = useDisclosure(false);
  const [issueDefaultUserId, setIssueDefaultUserId] = useState<number | undefined>();

  const [columnFilters, setColumnFilters] = useState<MRT_ColumnFiltersState>([
    { id: 'status', value: [StrikeStatus.Active] },
  ]);
  const [sorting, setSorting] = useState<MRT_SortingState>([{ id: 'createdAt', desc: true }]);
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  // Extract typed filter values from MRT column filters
  const statusFilter = columnFilters.find((f) => f.id === 'status')?.value as string[] | undefined;
  const reasonFilter = columnFilters.find((f) => f.id === 'reason')?.value as string[] | undefined;
  const usernameFilter = columnFilters.find((f) => f.id === 'username')?.value as
    | string
    | undefined;

  const { data, isLoading, isFetching } = trpc.strike.getAll.useQuery(
    {
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
      status: statusFilter?.length ? (statusFilter as StrikeStatus[]) : undefined,
      reason: reasonFilter?.length ? (reasonFilter as StrikeReason[]) : undefined,
      username: usernameFilter || undefined,
    },
    { keepPreviousData: true }
  );

  const handleOpenIssueModal = (defaultUserId?: number) => {
    setIssueDefaultUserId(defaultUserId);
    openIssueModal();
  };

  const columns = useMemo<MRT_ColumnDef<StrikeItem>[]>(
    () => [
      {
        id: 'actions',
        header: '',
        Cell: ({ row: { original: strike } }) => (
          <Button size="compact-xs" onClick={() => setSelected(strike)}>
            Details
          </Button>
        ),
        enableSorting: false,
        enableColumnFilter: false,
        enableColumnActions: false,
        size: 80,
      },
      {
        id: 'username',
        header: 'User',
        accessorFn: (row) => row.user.username ?? `User ${row.userId}`,
        filterVariant: 'text',
        enableSorting: false,
        Cell: ({ row: { original: strike } }) => (
          <Link legacyBehavior href={`/user/${strike.user.username ?? strike.userId}`} passHref>
            <Text component="a" c="blue.4" target="_blank" size="sm">
              {strike.user.username ?? `User ${strike.userId}`}
            </Text>
          </Link>
        ),
      },
      {
        id: 'reason',
        header: 'Reason',
        accessorFn: (row) => getDisplayName(row.reason),
        filterVariant: 'multi-select',
        enableSorting: false,
        mantineFilterMultiSelectProps: {
          data: Object.values(StrikeReason).map(
            (x) => ({ label: getDisplayName(x), value: x }) as ComboboxItem
          ),
        },
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (row) => row.status,
        filterVariant: 'multi-select',
        enableSorting: false,
        mantineFilterMultiSelectProps: {
          data: Object.values(StrikeStatus).map(
            (x) => ({ label: getDisplayName(x), value: x }) as ComboboxItem
          ),
        },
        Cell: ({ row: { original: strike } }) => (
          <Badge color={strikeStatusColorScheme[strike.status] ?? 'gray'} size="md">
            {strike.status}
          </Badge>
        ),
      },
      {
        accessorKey: 'points',
        header: 'Points',
        enableColumnFilter: false,
        enableSorting: false,
        size: 80,
      },
      {
        id: 'description',
        header: 'Description',
        accessorFn: (row) =>
          row.description.length > 60 ? `${row.description.slice(0, 60)}...` : row.description,
        enableColumnFilter: false,
        enableSorting: false,
      },
      {
        id: 'issuedBy',
        header: 'Issued By',
        accessorFn: (row) => row.issuedByUser?.username ?? (row.issuedBy ? 'System' : 'System'),
        enableColumnFilter: false,
        enableSorting: false,
      },
      {
        id: 'createdAt',
        header: 'Created',
        accessorFn: (row) => formatDate(row.createdAt),
        enableColumnFilter: false,
      },
      {
        id: 'expiresAt',
        header: 'Expires',
        accessorFn: (row) => formatDate(row.expiresAt),
        enableColumnFilter: false,
        enableSorting: false,
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
            <Title>Strikes</Title>
            <Button onClick={() => handleOpenIssueModal()}>Issue Strike</Button>
          </Group>
          <MantineReactTable
            columns={columns}
            data={(data?.items as StrikeItem[]) ?? []}
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
      <StrikeDetailDrawer
        strike={selected}
        onClose={() => setSelected(null)}
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
// Strike Detail Drawer
// ============================================================================
function StrikeDetailDrawer({
  strike,
  onClose,
  onIssueStrike,
}: {
  strike: StrikeItem | null;
  onClose: () => void;
  onIssueStrike: (userId: number) => void;
}) {
  const mobile = useIsMobile();
  const [voidModalOpened, { open: openVoidModal, close: closeVoidModal }] = useDisclosure(false);

  if (!strike) {
    return (
      <Drawer opened={false} onClose={onClose} position="right" size="xl">
        {null}
      </Drawer>
    );
  }

  const entityLink = getEntityLink(strike.entityType, strike.entityId);
  const isActive = strike.status === StrikeStatus.Active;

  const detailItems = [
    {
      label: 'Status',
      value: (
        <Badge color={strikeStatusColorScheme[strike.status] ?? 'gray'}>{strike.status}</Badge>
      ),
    },
    { label: 'Reason', value: getDisplayName(strike.reason) },
    { label: 'Points', value: strike.points },
    { label: 'Description', value: strike.description },
    {
      label: 'Internal Notes',
      value: strike.internalNotes ?? 'None',
    },
    {
      label: 'Issued By',
      value: strike.issuedByUser ? (
        <Link legacyBehavior href={`/user/${strike.issuedByUser.username ?? strike.issuedByUser.id}`} passHref>
          <Text component="a" c="blue.4" target="_blank" size="sm">
            {strike.issuedByUser.username}
          </Text>
        </Link>
      ) : (
        'System'
      ),
    },
    { label: 'Created', value: formatDate(strike.createdAt) },
    { label: 'Expires', value: formatDate(strike.expiresAt) },
    {
      label: 'Voided At',
      value: strike.voidedAt ? formatDate(strike.voidedAt) : undefined,
      visible: !!strike.voidedAt,
    },
    {
      label: 'Void Reason',
      value: strike.voidReason,
      visible: !!strike.voidReason,
    },
    {
      label: 'Report ID',
      value: strike.reportId,
      visible: !!strike.reportId,
    },
    {
      label: 'Entity',
      value: entityLink ? (
        <Anchor href={entityLink} target="_blank" size="sm">
          <Group gap={4}>
            <Text inherit>
              {strike.entityType} #{strike.entityId}
            </Text>
            <IconExternalLink size={14} stroke={1.5} />
          </Group>
        </Anchor>
      ) : undefined,
      visible: !!entityLink,
    },
  ];

  return (
    <>
      <Drawer
        withOverlay={false}
        opened
        onClose={onClose}
        position={mobile ? 'bottom' : 'right'}
        title="Strike Details"
        size={mobile ? '100%' : 'xl'}
        padding="md"
        shadow="sm"
        zIndex={500}
        classNames={{
          content: 'border-l border-l-gray-3 dark:border-l-dark-4',
        }}
      >
        <Stack>
          <Link legacyBehavior href={`/user/${strike.user.username ?? strike.userId}`} passHref>
            <Anchor size="sm" target="_blank">
              <Group gap={4}>
                <Text inherit>View User: {strike.user.username ?? strike.userId}</Text>
                <IconExternalLink size={14} stroke={1.5} />
              </Group>
            </Anchor>
          </Link>
          <DescriptionTable items={detailItems} labelWidth="30%" />
          <Group>
            {isActive && (
              <Button color="yellow" variant="outline" onClick={openVoidModal}>
                Void Strike
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                onClose();
                onIssueStrike(strike.userId);
              }}
            >
              Issue Another Strike
            </Button>
          </Group>
        </Stack>
      </Drawer>
      <VoidStrikeModal
        strikeId={strike.id}
        opened={voidModalOpened}
        onClose={closeVoidModal}
        onSuccess={onClose}
      />
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
      await queryUtils.strike.getAll.invalidate();
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

  // Reset form when modal opens with new defaultUserId
  const prevDefaultUserId = useState(defaultUserId)[0];
  if (opened && defaultUserId !== prevDefaultUserId) {
    form.reset({
      userId: defaultUserId ?? ('' as unknown as number),
      reason: StrikeReason.ManualModAction,
      points: 1,
      description: '',
      internalNotes: '',
      expiresInDays: 30,
    });
  }

  const createMutation = trpc.strike.create.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Strike has been issued' });
      await queryUtils.strike.getAll.invalidate();
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
