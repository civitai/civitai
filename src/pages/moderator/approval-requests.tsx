import {
  Anchor,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  Modal,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ApprovalRequestStatus } from '~/shared/utils/prisma/enums';
import { createSelectStore } from '~/store/select.store';
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

// Selection store for this page
const { useSelection, setSelected } = createSelectStore<number>('approval-request-selection');

// Status badge colors
function StatusBadge({ status }: { status: string }) {
  if (status === ApprovalRequestStatus.Pending)
    return (
      <Badge color="yellow" variant="light" size="sm">
        Pending
      </Badge>
    );
  if (status === ApprovalRequestStatus.Approved)
    return (
      <Badge color="green" variant="light" size="sm">
        Approved
      </Badge>
    );
  if (status === ApprovalRequestStatus.Rejected)
    return (
      <Badge color="red" variant="light" size="sm">
        Rejected
      </Badge>
    );
  if (status === ApprovalRequestStatus.Expired)
    return (
      <Badge color="gray" variant="light" size="sm">
        Expired
      </Badge>
    );
  return (
    <Badge color="gray" variant="light" size="sm">
      {status}
    </Badge>
  );
}

// Action badge with special highlight for NCMEC
function ActionBadge({ action }: { action: string }) {
  const isNcmec = action === 'report-ncmec';
  return (
    <Badge
      color={isNcmec ? 'red' : 'blue'}
      variant={isNcmec ? 'filled' : 'light'}
      size="sm"
    >
      {isNcmec ? 'NCMEC Report' : action}
    </Badge>
  );
}

// Format JSON for display
function JsonDisplay({ data, label }: { data: unknown; label: string }) {
  if (!data || (typeof data === 'object' && Object.keys(data as object).length === 0)) {
    return null;
  }

  return (
    <div>
      <Text size="xs" fw={500} c="dimmed" mb={4}>
        {label}
      </Text>
      <Code
        block
        className="max-h-48 overflow-auto whitespace-pre-wrap text-xs"
      >
        {JSON.stringify(data, null, 2)}
      </Code>
    </div>
  );
}

function ApprovalRequestsPage() {
  const features = useFeatureFlags();

  // Gate behind feature flag
  if (!features.moderationAgents) {
    return <NotFound />;
  }

  return <ApprovalRequestsContent />;
}

function ApprovalRequestsContent() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | null>('Pending');
  const [agentTypeFilter, setAgentTypeFilter] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<any | null>(null);
  const [rejectModalOpened, { open: openRejectModal, close: closeRejectModal }] =
    useDisclosure(false);
  const [rejectionReason, setRejectionReason] = useState('');

  const queryUtils = trpc.useUtils();

  // Build status filter array
  const statusFilterArray = statusFilter
    ? [statusFilter as (typeof ApprovalRequestStatus)[keyof typeof ApprovalRequestStatus]]
    : undefined;

  const { data, isLoading } = trpc.approvalRequest.getAll.useQuery({
    page,
    limit: 20,
    status: statusFilterArray,
    agentType: agentTypeFilter || undefined,
    action: actionFilter || undefined,
  });

  const decideMutation = trpc.approvalRequest.decide.useMutation({
    onSuccess: (_, variables) => {
      const action = variables.decision === 'Approved' ? 'approved' : 'rejected';
      showSuccessNotification({
        title: 'Decision recorded',
        message: `Request has been ${action}.`,
      });
      // Invalidate queries
      queryUtils.approvalRequest.getAll.invalidate();
      // Select next request or clear selection
      selectNextRequest();
    },
    onError: (err) => {
      showErrorNotification({ title: 'Error', error: new Error(err.message) });
    },
  });

  const selectNextRequest = () => {
    if (!data?.items || !selectedRequest) {
      setSelectedRequest(null);
      return;
    }
    const currentIndex = data.items.findIndex((r) => r.id === selectedRequest.id);
    const nextItem = data.items[currentIndex + 1] ?? data.items[currentIndex - 1] ?? null;
    setSelectedRequest(nextItem);
    setSelected([]);
  };

  const handleApprove = () => {
    if (!selectedRequest) return;
    decideMutation.mutate({
      id: selectedRequest.id,
      decision: 'Approved',
    });
  };

  const handleReject = () => {
    if (!selectedRequest || !rejectionReason.trim()) return;
    decideMutation.mutate({
      id: selectedRequest.id,
      decision: 'Rejected',
      rejectionReason: rejectionReason.trim(),
    });
    closeRejectModal();
    setRejectionReason('');
  };

  const openRejectWithReset = () => {
    setRejectionReason('');
    openRejectModal();
  };

  const totalPages = data ? Math.ceil(data.totalItems / 20) : 0;

  return (
    <>
      <Meta title="Approval Requests" deIndex />
      <div className="flex flex-1 gap-6 overflow-hidden p-4">
        {/* Left Panel - List */}
        <div className="flex w-[500px] flex-col">
          {/* Fixed Header */}
          <div className="flex flex-col gap-4 pb-4">
            <Title order={1}>Approval Requests</Title>
            <Text size="sm" c="dimmed">
              Review and approve or reject agent-submitted moderation actions.
            </Text>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                placeholder="Status"
                data={[
                  { value: ApprovalRequestStatus.Pending, label: 'Pending' },
                  { value: ApprovalRequestStatus.Approved, label: 'Approved' },
                  { value: ApprovalRequestStatus.Rejected, label: 'Rejected' },
                  { value: ApprovalRequestStatus.Expired, label: 'Expired' },
                ]}
                value={statusFilter}
                onChange={(val) => {
                  setStatusFilter(val);
                  setPage(1);
                  setSelectedRequest(null);
                }}
                clearable
                w={130}
              />
              <Select
                placeholder="Agent Type"
                data={[
                  { value: 'content-moderator', label: 'Content Moderator' },
                  { value: 'report-handler', label: 'Report Handler' },
                ]}
                value={agentTypeFilter}
                onChange={(val) => {
                  setAgentTypeFilter(val);
                  setPage(1);
                  setSelectedRequest(null);
                }}
                clearable
                w={160}
              />
              <Select
                placeholder="Action"
                data={[
                  { value: 'block-content', label: 'Block Content' },
                  { value: 'report-ncmec', label: 'NCMEC Report' },
                  { value: 'issue-strike', label: 'Issue Strike' },
                  { value: 'ban-user', label: 'Ban User' },
                ]}
                value={actionFilter}
                onChange={(val) => {
                  setActionFilter(val);
                  setPage(1);
                  setSelectedRequest(null);
                }}
                clearable
                w={140}
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
              No approval requests found.
            </Text>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-auto">
                <Table highlightOnHover withTableBorder>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Action</Table.Th>
                      <Table.Th>Entity</Table.Th>
                      <Table.Th>Agent</Table.Th>
                      <Table.Th>Time</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.items.map((request) => (
                      <Table.Tr
                        key={request.id}
                        onClick={() => {
                          setSelectedRequest(request);
                          setSelected([]);
                        }}
                        className={clsx(
                          'cursor-pointer',
                          selectedRequest?.id === request.id && 'bg-blue-1 dark:bg-dark-5',
                          request.action === 'report-ncmec' &&
                            'bg-red-0 dark:bg-red-9/10'
                        )}
                      >
                        <Table.Td>
                          <ActionBadge action={request.action} />
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" lineClamp={1}>
                            {request.entityType
                              ? `${request.entityType} #${request.entityId}`
                              : request.targetUserId
                              ? `User #${request.targetUserId}`
                              : '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {request.agentType}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            <DaysFromNow date={request.createdAt} />
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <StatusBadge status={request.status} />
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
                      setSelectedRequest(null);
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

        {/* Right Panel - Detail */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedRequest ? (
            <>
              {/* Fixed Header */}
              <div className="flex flex-col gap-4 pb-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ActionBadge action={selectedRequest.action} />
                    <StatusBadge status={selectedRequest.status} />
                    <Text size="sm" c="dimmed">
                      {formatDate(selectedRequest.createdAt, 'MMM D, YYYY h:mm A')}
                    </Text>
                  </div>
                  {selectedRequest.reviewUrl && (
                    <Anchor href={selectedRequest.reviewUrl} target="_blank" size="sm">
                      <Group gap={4}>
                        <Text inherit>View Entity</Text>
                        <IconExternalLink size={14} stroke={1.5} />
                      </Group>
                    </Anchor>
                  )}
                </div>

                {selectedRequest.status === ApprovalRequestStatus.Pending && (
                  <div className="flex items-center gap-2">
                    <Button
                      color="green"
                      leftSection={<IconCheck size={16} />}
                      loading={decideMutation.isPending}
                      onClick={handleApprove}
                    >
                      Approve
                    </Button>
                    <Button
                      color="red"
                      leftSection={<IconX size={16} />}
                      onClick={openRejectWithReset}
                    >
                      Reject
                    </Button>
                    {selectedRequest.action === 'report-ncmec' && (
                      <Badge
                        color="red"
                        variant="filled"
                        size="lg"
                        leftSection={<IconAlertTriangle size={14} />}
                      >
                        NCMEC - Handle with care
                      </Badge>
                    )}
                  </div>
                )}

                {selectedRequest.status === ApprovalRequestStatus.Rejected &&
                  selectedRequest.rejectionReason && (
                    <div className="rounded border border-solid border-red-3 bg-red-0 p-3 dark:border-red-9 dark:bg-red-9/20">
                      <Text size="xs" fw={500} c="red">
                        Rejection Reason
                      </Text>
                      <Text size="sm">{selectedRequest.rejectionReason}</Text>
                    </div>
                  )}

                {selectedRequest.decidedByUser && selectedRequest.decidedAt && (
                  <Text size="xs" c="dimmed">
                    Decided by {selectedRequest.decidedByUser.username ?? 'Unknown'} on{' '}
                    {formatDate(selectedRequest.decidedAt, 'MMM D, YYYY h:mm A')}
                  </Text>
                )}

                <Divider label="Request Details" />
              </div>

              {/* Scrollable Content */}
              <div className="min-h-0 flex-1 overflow-auto">
                <Stack gap="md">
                  {/* Summary */}
                  <div>
                    <Text size="xs" fw={500} c="dimmed" mb={4}>
                      Summary
                    </Text>
                    <Text size="sm">{selectedRequest.summary}</Text>
                  </div>

                  {/* Target Info */}
                  <div className="flex gap-8">
                    {selectedRequest.entityType && (
                      <div>
                        <Text size="xs" fw={500} c="dimmed">
                          Entity Type
                        </Text>
                        <Text size="sm">{selectedRequest.entityType}</Text>
                      </div>
                    )}
                    {selectedRequest.entityId && (
                      <div>
                        <Text size="xs" fw={500} c="dimmed">
                          Entity ID
                        </Text>
                        <Text size="sm">{selectedRequest.entityId}</Text>
                      </div>
                    )}
                    {selectedRequest.targetUserId && (
                      <div>
                        <Text size="xs" fw={500} c="dimmed">
                          Target User
                        </Text>
                        <Anchor
                          href={`/user/${selectedRequest.targetUserId}`}
                          target="_blank"
                          size="sm"
                        >
                          User #{selectedRequest.targetUserId}
                        </Anchor>
                      </div>
                    )}
                  </div>

                  {/* Agent Info */}
                  <div className="flex gap-8">
                    <div>
                      <Text size="xs" fw={500} c="dimmed">
                        Agent Type
                      </Text>
                      <Text size="sm">{selectedRequest.agentType}</Text>
                    </div>
                    <div>
                      <Text size="xs" fw={500} c="dimmed">
                        Session ID
                      </Text>
                      <Code className="text-xs">{selectedRequest.agentSessionId}</Code>
                    </div>
                  </div>

                  <Divider label="Reasoning" />

                  {/* Reasoning */}
                  <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-solid border-gray-3 bg-gray-0 p-3 text-sm dark:border-dark-4 dark:bg-dark-6">
                    {selectedRequest.reasoning}
                  </div>

                  {/* Evidence */}
                  <JsonDisplay data={selectedRequest.evidence} label="Evidence" />

                  {/* Action Params */}
                  <JsonDisplay data={selectedRequest.actionParams} label="Action Parameters" />

                  {/* Safe Preview Image */}
                  {selectedRequest.safePreviewUrl && (
                    <div>
                      <Text size="xs" fw={500} c="dimmed" mb={4}>
                        Safe Preview
                      </Text>
                      <div className="max-w-md overflow-hidden rounded border border-solid border-gray-3 dark:border-dark-4">
                        <EdgeMedia
                          src={selectedRequest.safePreviewUrl}
                          width={400}
                          className="max-w-full"
                        />
                      </div>
                    </div>
                  )}
                </Stack>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Text c="dimmed">Select a request to view details</Text>
            </div>
          )}
        </div>
      </div>

      {/* Reject Modal */}
      <Modal
        opened={rejectModalOpened}
        onClose={closeRejectModal}
        title="Reject Request"
        centered
      >
        <Stack>
          <Text size="sm">
            Please provide a reason for rejecting this approval request. This will be logged
            and may be visible to the agent system.
          </Text>
          <Textarea
            label="Rejection Reason"
            description="Required — explain why this request is being rejected"
            placeholder="Enter reason..."
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.currentTarget.value)}
            minRows={3}
            autosize
            required
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={closeRejectModal}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={handleReject}
              loading={decideMutation.isPending}
              disabled={!rejectionReason.trim()}
            >
              Reject
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

export default Page(ApprovalRequestsPage, { scrollable: false });
