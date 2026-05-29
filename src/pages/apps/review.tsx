import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconCode,
  IconExternalLink,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/review — Moderator review queue for App Blocks publish requests.
 *
 * Lists pending requests oldest-first; click into a row to see the new
 * manifest, the diff summary against the previous approved version, and
 * approve / reject buttons. On approve the platform commits the bundle
 * to Forgejo server-side and the existing Tekton build chain takes over.
 *
 * v0 gate: requires `isModerator`. v1 (W11 audit) opens to reviewers
 * outside the civitai team behind RBAC.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!session.user.isModerator) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

type FileSummary = {
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added: string[];
  removed: string[];
  changed: string[];
};

type PendingRequest = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  submittedAt: string | Date;
  bundleSizeBytes: string;
  bundleSha256: string;
  manifest: unknown;
  fileSummary: unknown;
  manifestDiffSummary: unknown;
  reviewRepoUrl: string;
  submittedBy: { id: number; username: string | null; image: string | null };
};

function formatBytes(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

export default function ReviewQueuePage() {
  const features = useFeatureFlags();
  const queue = trpc.blocks.listPendingRequests.useQuery(
    { limit: 50 },
    { enabled: !!features?.appBlocks }
  );

  const [selected, setSelected] = useState<PendingRequest | null>(null);

  if (!features?.appBlocks) return <NotFound />;

  const items = (queue.data?.items ?? []) as PendingRequest[];

  return (
    <>
      <Meta title="App publish-request queue — Civitai" deIndex />
      <Container size="xl" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>App publish-request queue</Title>
            <Text c="dimmed" size="sm">
              Moderator review for App Blocks. Oldest-first.{' '}
              {queue.isLoading ? 'Loading…' : `${items.length} pending.`}
            </Text>
          </Stack>

          {queue.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {queue.error.message}
            </Alert>
          )}

          {!queue.isLoading && items.length === 0 && (
            <Card withBorder p="lg">
              <Group gap="xs">
                <IconCheck color="var(--mantine-color-green-6)" size={20} />
                <Text>Queue is empty. Nothing waiting for review.</Text>
              </Group>
            </Card>
          )}

          {items.length > 0 && (
            <Card withBorder p={0}>
              <Table verticalSpacing="md" horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>App</Table.Th>
                    <Table.Th>Version</Table.Th>
                    <Table.Th>Submitter</Table.Th>
                    <Table.Th>Submitted</Table.Th>
                    <Table.Th>Bundle</Table.Th>
                    <Table.Th>Changes</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {items.map((r) => {
                    const fs = (r.fileSummary ?? {}) as FileSummary;
                    const mds = (r.manifestDiffSummary ?? {}) as ManifestDiffSummary;
                    const isFirst = mds.kind === 'first-version';
                    return (
                      <Table.Tr key={r.id} style={{ cursor: 'pointer' }}>
                        <Table.Td onClick={() => setSelected(r)}>
                          <Group gap={6}>
                            <Code>{r.slug}</Code>
                            {isFirst && (
                              <Badge color="violet" size="xs">
                                first version
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                        <Table.Td onClick={() => setSelected(r)}>
                          <Code>{r.version}</Code>
                        </Table.Td>
                        <Table.Td onClick={() => setSelected(r)}>
                          {r.submittedBy.username ?? `#${r.submittedBy.id}`}
                        </Table.Td>
                        <Table.Td onClick={() => setSelected(r)}>
                          <Group gap={4}>
                            <IconClock size={14} />
                            <Text size="xs">{formatDate(r.submittedAt)}</Text>
                          </Group>
                        </Table.Td>
                        <Table.Td onClick={() => setSelected(r)}>
                          <Text size="xs" c="dimmed">
                            {formatBytes(r.bundleSizeBytes)} ·{' '}
                            {fs.files?.length ?? 0} files
                          </Text>
                        </Table.Td>
                        <Table.Td onClick={() => setSelected(r)}>
                          <Group gap={6}>
                            {(fs.added?.length ?? 0) > 0 && (
                              <Badge color="green" size="xs">
                                +{fs.added.length}
                              </Badge>
                            )}
                            {(fs.changed?.length ?? 0) > 0 && (
                              <Badge color="yellow" size="xs">
                                ~{fs.changed.length}
                              </Badge>
                            )}
                            {(fs.removed?.length ?? 0) > 0 && (
                              <Badge color="red" size="xs">
                                −{fs.removed.length}
                              </Badge>
                            )}
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
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Card>
          )}
        </Stack>
      </Container>

      <ReviewModal
        request={selected}
        onClose={() => setSelected(null)}
        onActioned={async () => {
          setSelected(null);
          await queue.refetch();
        }}
      />
    </>
  );
}

function ReviewModal({
  request,
  onClose,
  onActioned,
}: {
  request: PendingRequest | null;
  onClose: () => void;
  onActioned: () => void | Promise<void>;
}) {
  const [approvalNotes, setApprovalNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [mode, setMode] = useState<'view' | 'reject'>('view');

  const approveMut = trpc.blocks.approveRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Approved ${request?.slug} v${request?.version}. Build started.`,
      });
      await onActioned();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Approve failed',
        error: new Error(e.message),
      });
    },
  });
  const rejectMut = trpc.blocks.rejectRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Rejected ${request?.slug} v${request?.version}.`,
      });
      await onActioned();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Reject failed',
        error: new Error(e.message),
      });
    },
  });

  if (!request) return null;

  const manifest = request.manifest as Record<string, unknown>;
  const fs = (request.fileSummary ?? {}) as FileSummary;
  const mds = (request.manifestDiffSummary ?? {}) as ManifestDiffSummary;
  const busy = approveMut.isLoading || rejectMut.isLoading;

  return (
    <Modal
      opened={!!request}
      onClose={() => {
        if (busy) return;
        setApprovalNotes('');
        setRejectionReason('');
        setMode('view');
        onClose();
      }}
      title={
        <Group gap={6}>
          <Text fw={600}>{request.slug}</Text>
          <Code>{request.version}</Code>
          {mds.kind === 'first-version' && (
            <Badge color="violet" size="sm">
              first version
            </Badge>
          )}
        </Group>
      }
      size="xl"
      centered
    >
      <Stack gap="md">
        <Group gap="xs" align="flex-start">
          <Text size="xs" c="dimmed">
            Submitter:
          </Text>
          <Text size="xs">
            {request.submittedBy.username ?? `#${request.submittedBy.id}`}
          </Text>
          <Text size="xs" c="dimmed">
            ·
          </Text>
          <Text size="xs" c="dimmed">
            {formatDate(request.submittedAt)}
          </Text>
          <Text size="xs" c="dimmed">
            · {formatBytes(request.bundleSizeBytes)} · sha256:
          </Text>
          <Code style={{ fontSize: 10 }}>{request.bundleSha256.slice(0, 12)}…</Code>
        </Group>

        <Button
          component="a"
          href={request.reviewRepoUrl}
          target="_blank"
          rel="noopener"
          variant="default"
          leftSection={<IconCode size={14} />}
          rightSection={<IconExternalLink size={12} />}
        >
          View code in Forgejo
        </Button>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Files
          </Text>
          <Group gap={6}>
            <Text size="sm">{fs.files?.length ?? 0} total</Text>
            {(fs.added?.length ?? 0) > 0 && (
              <Badge color="green" variant="light">
                +{fs.added.length} added
              </Badge>
            )}
            {(fs.changed?.length ?? 0) > 0 && (
              <Badge color="yellow" variant="light">
                ~{fs.changed.length} changed
              </Badge>
            )}
            {(fs.removed?.length ?? 0) > 0 && (
              <Badge color="red" variant="light">
                −{fs.removed.length} removed
              </Badge>
            )}
          </Group>
          {mds.kind === 'update' && (
            <FileListPreview added={fs.added} removed={fs.removed} changed={fs.changed} />
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Manifest diff
          </Text>
          {mds.kind === 'first-version' ? (
            <Text size="xs" c="dimmed">
              First version — full manifest below.
            </Text>
          ) : (
            <ManifestDiffPreview diff={mds} />
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            New manifest
          </Text>
          <ScrollArea h={300} style={{ background: 'var(--mantine-color-gray-0)' }}>
            <Code block style={{ fontSize: 11, padding: 8 }}>
              {JSON.stringify(manifest, null, 2)}
            </Code>
          </ScrollArea>
        </Stack>

        {mode === 'reject' ? (
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              Rejection reason
            </Text>
            <Textarea
              autosize
              minRows={3}
              maxRows={10}
              placeholder="Explain what needs to change before this can be approved (≥10 chars, shown to the dev)."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setMode('view')} disabled={busy}>
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
                loading={rejectMut.isLoading}
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
                onClick={() => setMode('reject')}
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
                loading={approveMut.isLoading}
              >
                Approve + build
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

function FileListPreview({
  added,
  removed,
  changed,
}: {
  added?: string[];
  removed?: string[];
  changed?: string[];
}) {
  const lines: Array<{ sigil: '+' | '~' | '-'; path: string; color: string }> = [];
  for (const p of added ?? []) lines.push({ sigil: '+', path: p, color: 'green' });
  for (const p of changed ?? []) lines.push({ sigil: '~', path: p, color: 'yellow' });
  for (const p of removed ?? []) lines.push({ sigil: '-', path: p, color: 'red' });
  if (lines.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No file-level changes.
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={180} style={{ background: 'var(--mantine-color-gray-0)' }}>
      <Stack gap={2} p={6}>
        {lines.map((l) => (
          <Group key={`${l.sigil}-${l.path}`} gap={6} wrap="nowrap">
            <Text size="xs" c={l.color} fw={700} style={{ width: 12 }}>
              {l.sigil}
            </Text>
            <Code style={{ fontSize: 11 }}>{l.path}</Code>
          </Group>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

function ManifestDiffPreview({
  diff,
}: {
  diff: { added: string[]; removed: string[]; changed: Array<{ field: string; from: unknown; to: unknown }> };
}) {
  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    return (
      <Text size="xs" c="dimmed">
        No manifest changes (bundle resubmit with code-only diff).
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={260} style={{ background: 'var(--mantine-color-gray-0)' }}>
      <Stack gap={6} p={8}>
        {diff.added.map((field) => (
          <Group key={`+${field}`} gap={6}>
            <Text size="xs" c="green" fw={700}>
              +
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              added
            </Text>
          </Group>
        ))}
        {diff.removed.map((field) => (
          <Group key={`-${field}`} gap={6}>
            <Text size="xs" c="red" fw={700}>
              −
            </Text>
            <Code style={{ fontSize: 11 }}>{field}</Code>
            <Text size="xs" c="dimmed">
              removed
            </Text>
          </Group>
        ))}
        {diff.changed.map((change) => (
          <Stack key={`~${change.field}`} gap={2}>
            <Group gap={6}>
              <Text size="xs" c="yellow" fw={700}>
                ~
              </Text>
              <Code style={{ fontSize: 11 }}>{change.field}</Code>
              <Text size="xs" c="dimmed">
                changed
              </Text>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                from
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.from)}
              </Code>
            </Group>
            <Group gap={8} pl={18} align="flex-start">
              <Text size="xs" c="dimmed" style={{ minWidth: 32 }}>
                to
              </Text>
              <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(change.to)}
              </Code>
            </Group>
          </Stack>
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}
