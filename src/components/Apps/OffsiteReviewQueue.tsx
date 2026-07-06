import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Divider,
  Group,
  List,
  Modal,
  Stack,
  Table,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconQuestionMark,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { getOffsiteReviewChecklist } from '~/components/Apps/offsiteReviewChecklist';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — the OFF-SITE (external-link) pending review section (W13 P3a).
 * Rendered kind-aware ALONGSIDE the existing on-site App Block queue (which is
 * byte-unchanged). An off-site row gets a LIGHTER, content-only review (no code /
 * bundle / manifest) driven by `getOffsiteReviewChecklist`, and Approve/Reject call
 * the off-site procs (`appListings.approveExternalRequest` /
 * `rejectExternalRequest`). Data is `appListings.listPendingRequests`
 * (moderatorProcedure); the whole /apps/review page already requires isModerator.
 */

type OffsiteUser = { id: number; username: string | null; image: string | null };

type OffsitePendingRow = {
  id: string;
  appListingId: string | null;
  slug: string;
  status: string;
  submittedAt: string | Date;
  changelog: string | null;
  appListing: {
    name: string | null;
    externalUrl: string | null;
    category: string | null;
    contentRating: string | null;
  } | null;
  submittedBy: OffsiteUser | null;
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

export function OffsiteReviewQueue() {
  const features = useFeatureFlags();
  const [selected, setSelected] = useState<OffsitePendingRow | null>(null);

  const queue = trpc.appListings.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks, retry: false }
  );

  // Flag off / not enabled → the query errors (moderatorProcedure); render nothing
  // so the section stays unobtrusive when off-site review isn't in use.
  if (queue.error) return null;

  const items = (queue.data?.items ?? []) as OffsitePendingRow[];

  return (
    <Stack gap="sm" mt="lg">
      <Divider
        label={
          <Group gap={6}>
            <IconExternalLink size={14} />
            <Text size="sm" fw={600}>
              External-link submissions
            </Text>
            <Badge size="sm" variant="light" color={items.length > 0 ? 'grape' : 'gray'}>
              {items.length}
            </Badge>
          </Group>
        }
        labelPosition="left"
      />
      <Text size="xs" c="dimmed">
        Off-site apps — a lighter, content-only review (no code / bundle). Approving requires an
        asset-complete draft (icon + cover + ≥1 screenshot).
      </Text>

      {queue.isLoading ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : items.length === 0 ? (
        <Card withBorder p="md">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-green-6)" size={18} />
            <Text size="sm">No external-link submissions waiting for review.</Text>
          </Group>
        </Card>
      ) : (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>App</Table.Th>
                <Table.Th>Link</Table.Th>
                <Table.Th>Submitter</Table.Th>
                <Table.Th>Submitted</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((r) => (
                <Table.Tr key={r.id} style={{ cursor: 'pointer' }}>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Group gap={6}>
                      <Code>{r.slug}</Code>
                    </Group>
                    {r.appListing?.name && (
                      <Text size="xs" c="dimmed">
                        {r.appListing.name}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Text size="xs" c="dimmed" lineClamp={1} style={{ maxWidth: 240 }}>
                      {r.appListing?.externalUrl ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Text size="xs">{r.submittedBy?.username ?? `#${r.submittedBy?.id ?? '?'}`}</Text>
                  </Table.Td>
                  <Table.Td onClick={() => setSelected(r)}>
                    <Group gap={4}>
                      <IconClock size={14} />
                      <Text size="xs">{formatDate(r.submittedAt)}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => setSelected(r)}
                      rightSection={<IconExternalLink size={12} />}
                    >
                      Review
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <OffsiteReviewModal request={selected} onClose={() => setSelected(null)} />
    </Stack>
  );
}

function OffsiteReviewModal({
  request,
  onClose,
}: {
  request: OffsitePendingRow | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const features = useFeatureFlags();
  const [rejectionReason, setRejectionReason] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');

  // Asset presence for the content checklist (author/mod-gated; a mod passes the
  // author floor). Only enabled once a row with a draft listing is open.
  const assetsQuery = trpc.appListings.getAssets.useQuery(
    { listingId: request?.appListingId ?? '' },
    { enabled: !!features?.appBlocks && !!request?.appListingId, retry: false }
  );

  const approveMut = trpc.appListings.approveExternalRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Approved ${request?.slug}.` });
      await utils.appListings.listPendingRequests.invalidate();
      await utils.appListings.listApprovedRequests.invalidate();
      close();
    },
    onError: (e: { message: string }) => {
      showErrorNotification({ title: 'Approve failed', error: new Error(e.message) });
    },
  });
  const rejectMut = trpc.appListings.rejectExternalRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Rejected ${request?.slug}.` });
      await utils.appListings.listPendingRequests.invalidate();
      await utils.appListings.listRejectedRequests.invalidate();
      close();
    },
    onError: (e: { message: string }) => {
      showErrorNotification({ title: 'Reject failed', error: new Error(e.message) });
    },
  });

  const busy = approveMut.isPending || rejectMut.isPending;

  function close() {
    setRejectionReason('');
    setApprovalNotes('');
    setActionMode('view');
    onClose();
  }

  if (!request) return null;

  const screenshotCount = (assetsQuery.data?.screenshots ?? []).filter(
    (s: { imageId: number | null }) => s.imageId != null
  ).length;
  const hasIcon = assetsQuery.data?.iconId != null;
  const hasCover = assetsQuery.data?.coverId != null;

  const checklist = getOffsiteReviewChecklist({
    name: request.appListing?.name,
    externalUrl: request.appListing?.externalUrl,
    hasIcon,
    hasCover,
    screenshotCount,
    category: request.appListing?.category,
    description: null,
  });

  const assetsIncomplete = !assetsQuery.isLoading && (!hasIcon || !hasCover || screenshotCount < 1);

  return (
    <Modal
      opened={!!request}
      onClose={() => {
        if (busy) return;
        close();
      }}
      title={
        <Group gap={6}>
          <Text fw={600}>{request.slug}</Text>
          <Badge color="grape" size="sm" variant="light">
            external
          </Badge>
        </Group>
      }
      size="lg"
      centered
    >
      <Stack gap="md">
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            Submitter:
          </Text>
          <Text size="xs">{request.submittedBy?.username ?? `#${request.submittedBy?.id ?? '?'}`}</Text>
          <Text size="xs" c="dimmed">
            · {formatDate(request.submittedAt)}
          </Text>
        </Group>

        <Card withBorder p="sm">
          <Stack gap={6}>
            {request.appListing?.name && (
              <Text size="md" fw={600}>
                {request.appListing.name}
              </Text>
            )}
            {request.appListing?.externalUrl && (
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  URL
                </Text>
                <Anchor
                  href={request.appListing.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="sm"
                >
                  <Group gap={4} wrap="nowrap">
                    {request.appListing.externalUrl}
                    <IconExternalLink size={12} />
                  </Group>
                </Anchor>
              </Group>
            )}
            <Group gap={12}>
              {request.appListing?.category && (
                <Badge size="sm" variant="light">
                  {request.appListing.category}
                </Badge>
              )}
              {request.appListing?.contentRating && (
                <Badge size="sm" color="gray" variant="light">
                  {request.appListing.contentRating}
                </Badge>
              )}
            </Group>
            {request.changelog && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Submitter note
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {request.changelog}
                </Text>
              </Stack>
            )}
          </Stack>
        </Card>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Content review checklist
          </Text>
          <List spacing={4} size="sm" center>
            {checklist.map((item) => (
              <List.Item
                key={item.id}
                icon={
                  <ThemeIcon
                    size={18}
                    radius="xl"
                    color={item.status === 'ok' ? 'green' : item.status === 'warn' ? 'red' : 'gray'}
                    variant={item.status === 'todo' ? 'light' : 'filled'}
                  >
                    {item.status === 'ok' ? (
                      <IconCheck size={12} />
                    ) : item.status === 'warn' ? (
                      <IconX size={12} />
                    ) : (
                      <IconQuestionMark size={12} />
                    )}
                  </ThemeIcon>
                }
              >
                <Text size="sm">{item.label}</Text>
                <Text size="xs" c="dimmed">
                  {item.hint}
                </Text>
              </List.Item>
            ))}
          </List>
        </Stack>

        {assetsIncomplete && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
            <Text size="sm">
              Assets are incomplete — approve will be rejected by the server until an icon, a cover
              and ≥1 screenshot are attached.
            </Text>
          </Alert>
        )}

        {actionMode === 'reject' ? (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Rejection reason
            </Text>
            <Textarea
              autosize
              minRows={3}
              maxRows={10}
              placeholder="Explain what needs to change (≥10 chars, shown to the author)."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
                Cancel
              </Button>
              <Button
                color="red"
                leftSection={<IconX size={14} />}
                onClick={() =>
                  rejectMut.mutate({
                    publishRequestId: request.id,
                    rejectionReason: rejectionReason.trim(),
                  })
                }
                disabled={busy || rejectionReason.trim().length < 10}
                loading={rejectMut.isPending}
              >
                Reject
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Textarea
              label="Approval notes (optional)"
              autosize
              minRows={2}
              maxRows={6}
              placeholder="Optional notes attached to the approval record."
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button
                color="red"
                variant="default"
                leftSection={<IconX size={14} />}
                onClick={() => setActionMode('reject')}
                disabled={busy}
              >
                Reject…
              </Button>
              <Button
                color="green"
                leftSection={<IconCheck size={14} />}
                onClick={() =>
                  approveMut.mutate({
                    publishRequestId: request.id,
                    approvalNotes: approvalNotes.trim() || undefined,
                  })
                }
                disabled={busy}
                loading={approveMut.isPending}
              >
                Approve
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
