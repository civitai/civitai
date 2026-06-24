import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconBrandGit,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconExternalLink,
  IconMessage,
  IconTerminal2,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { AppAnalyticsInline } from '~/components/Apps/AppAnalyticsInline';
import { AuthorViaGit } from '~/components/Apps/AuthorViaGit';
import { isStaleDeploy } from '~/components/Apps/deploy-status';

/** Civitai CLI repo — the recommended author + submit path (replaces the raw
 *  git-clone affordance as the PRIMARY way to author/update an app). */
export const CIVITAI_CLI_URL = 'https://github.com/civitai/cli';

export type FileSummary = {
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added?: string[];
  removed?: string[];
  changed?: string[];
};

export type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

export type Submission = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  /** Phase 2 build/deploy lifecycle for an approved request:
   * 'building' → 'deploying' → 'live', or 'failed'. Null on non-approved rows
   * and on approved rows from before this feature shipped. */
  deployState: 'building' | 'deploying' | 'live' | 'failed' | null;
  deployDetail: string | null;
  deployUpdatedAt: string | Date | null;
  fileSummary: unknown;
  manifestDiffSummary: unknown;
  /** Total pinned subscriptions referencing this app block. */
  modelInstallCount: number | null;
  /** Total BlockUserSubscription rows. */
  userSubscriptionCount: number | null;
};

function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

export function statusBadge(
  submission: Pick<Submission, 'status' | 'deployState' | 'deployUpdatedAt'>
) {
  const { status } = submission;
  // For an approved request, show the real build/deploy lifecycle rather than a
  // flat "approved" — the dev cares whether their code is actually live.
  if (status === 'approved') {
    if (isStaleDeploy(submission)) {
      return (
        <Badge
          color="orange"
          leftSection={<IconAlertTriangle size={12} />}
          title="No progress for a while — the deploy may be stuck. Resubmit a new version if it doesn't go live."
        >
          {submission.deployState} (stalled)
        </Badge>
      );
    }
    switch (submission.deployState) {
      case 'building':
        return (
          <Badge color="blue" leftSection={<IconClock size={12} />}>
            building
          </Badge>
        );
      case 'deploying':
        return (
          <Badge color="indigo" leftSection={<IconClock size={12} />}>
            deploying
          </Badge>
        );
      case 'failed':
        return (
          <Badge color="red" leftSection={<IconX size={12} />}>
            deploy failed
          </Badge>
        );
      case 'live':
        return (
          <Badge color="green" leftSection={<IconCheck size={12} />}>
            live
          </Badge>
        );
      default:
        return (
          <Badge color="green" leftSection={<IconCheck size={12} />}>
            approved
          </Badge>
        );
    }
  }
  switch (status) {
    case 'pending':
      return (
        <Badge color="blue" leftSection={<IconClock size={12} />}>
          pending
        </Badge>
      );
    case 'rejected':
      return (
        <Badge color="red" leftSection={<IconX size={12} />}>
          rejected
        </Badge>
      );
    case 'withdrawn':
      return <Badge color="gray">withdrawn</Badge>;
    default:
      return <Badge color="gray">{status}</Badge>;
  }
}

/**
 * Reviewer notes are no longer rendered inline in the list. Instead an approved
 * (approvalNotes) or rejected (rejectionReason) row gets a "See reviewer notes"
 * button below its status badge that opens the notes in a modal. The button only
 * renders when there are notes to show — a row with no feedback shows nothing.
 */
export function ReviewerNotesButton({
  notes,
  variant,
}: {
  notes: string;
  variant: 'approved' | 'rejected';
}) {
  const [opened, { open, close }] = useDisclosure(false);
  const isRejection = variant === 'rejected';
  return (
    <>
      <Button
        size="compact-xs"
        variant="subtle"
        color={isRejection ? 'red' : 'gray'}
        leftSection={<IconMessage size={14} />}
        onClick={open}
      >
        See reviewer notes
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title={isRejection ? 'Reviewer feedback' : 'Reviewer notes'}
        size="lg"
      >
        <Alert
          color={isRejection ? 'red' : 'green'}
          variant="light"
          icon={isRejection ? <IconX size={16} /> : <IconCheck size={16} />}
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {notes}
          </Text>
        </Alert>
      </Modal>
    </>
  );
}

/**
 * Per-approved-app analytics affordance: a compact inline runs / unique-users
 * (last 30d) stat plus an "Analytics" button that opens the existing
 * AppAnalyticsPanel scoped to this app in a modal. Lives in AppAnalyticsInline
 * so the data fetch is isolated (mockable in tests + only fires for approved
 * rows with an app block).
 */

function StatusCell({ submission }: { submission: Submission }) {
  const { status, rejectionReason, approvalNotes } = submission;
  const notes =
    status === 'rejected'
      ? rejectionReason
      : status === 'approved'
      ? approvalNotes
      : null;
  const variant = status === 'rejected' ? 'rejected' : 'approved';
  return (
    <Stack gap={6} align="flex-start">
      {statusBadge(submission)}
      {notes && <ReviewerNotesButton notes={notes} variant={variant} />}
    </Stack>
  );
}

export function MySubmissionsList({
  submissions,
  onWithdraw,
  withdrawing,
}: {
  submissions: Submission[];
  onWithdraw: (id: string) => void;
  withdrawing: boolean;
}) {
  return (
    <Card withBorder p={0}>
      <Table verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Submitted</Table.Th>
            <Table.Th>Reviewed</Table.Th>
            <Table.Th>Installs</Table.Th>
            <Table.Th>Usage (30d)</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {submissions.map((s) => {
            const mds = (s.manifestDiffSummary ?? {}) as ManifestDiffSummary;
            const isFirst = mds.kind === 'first-version';
            const isApproved = s.status === 'approved';
            return (
              <Fragment key={s.id}>
                <Table.Tr>
                  <Table.Td>
                    <Group gap={6}>
                      <Code>{s.slug}</Code>
                      {isFirst && (
                        <Badge color="violet" size="xs">
                          first version
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Code>{s.version}</Code>
                  </Table.Td>
                  <Table.Td>
                    <StatusCell submission={s} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{formatDate(s.submittedAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {s.reviewedAt ? (
                      <Text size="xs">{formatDate(s.reviewedAt)}</Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <InstallCountCell
                      modelInstalls={s.modelInstallCount}
                      subscriptions={s.userSubscriptionCount}
                    />
                  </Table.Td>
                  <Table.Td>
                    {isApproved && s.appBlockId ? (
                      <AppAnalyticsInline appBlockId={s.appBlockId} appLabel={s.slug} />
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <SubmissionActions
                      submission={s}
                      isFirstVersion={isFirst}
                      onWithdraw={() => onWithdraw(s.id)}
                      busy={withdrawing}
                    />
                  </Table.Td>
                </Table.Tr>
                {s.status === 'approved' && s.deployState === 'failed' && (
                  <Table.Tr>
                    <Table.Td colSpan={8} p={0}>
                      <Alert
                        color="red"
                        variant="light"
                        radius={0}
                        icon={<IconAlertTriangle size={16} />}
                        title="Build / deploy failed"
                      >
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {s.deployDetail ??
                            'The build or deploy failed. Fix the issue and resubmit a new version.'}
                        </Text>
                      </Alert>
                    </Table.Td>
                  </Table.Tr>
                )}
                {/* Authoring updates: the CLI is the recommended path; git is a
                    collapsed advanced footnote. Only approved rows with an app
                    block (FK set on approve) can author updates. */}
                {s.status === 'approved' && s.appBlockId && (
                  <Table.Tr>
                    <Table.Td colSpan={8}>
                      <AuthorAffordance appBlockId={s.appBlockId} />
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

/**
 * Authoring guidance for an approved app. Leads with the Civitai CLI (the
 * recommended `author + submit` path); the raw git clone-URL flow is demoted to
 * a collapsed "Advanced: author via git" footnote so it isn't a confusing
 * primary option. The git provisioning side-effect (getMyAppRepo) still only
 * fires when the footnote is expanded AND the user clicks within AuthorViaGit.
 */
export function AuthorAffordance({ appBlockId }: { appBlockId: string }) {
  const [showGit, setShowGit] = useState(false);
  return (
    <Stack gap="xs">
      <Group gap={6}>
        <IconTerminal2 size={16} />
        <Text size="sm">
          Author and submit updates with the{' '}
          <Anchor href={CIVITAI_CLI_URL} target="_blank" rel="noopener noreferrer">
            <Code>civitai</Code> CLI
          </Anchor>
          . Install it, then run <Code>civitai app submit</Code> to publish a new
          version for review.
        </Text>
      </Group>
      <Group>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={
            showGit ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />
          }
          onClick={() => setShowGit((v) => !v)}
        >
          <Group gap={4}>
            <IconBrandGit size={14} />
            <Text size="xs">Advanced: author via git</Text>
          </Group>
        </Button>
      </Group>
      {showGit && <AuthorViaGit appBlockId={appBlockId} />}
    </Stack>
  );
}

function SubmissionActions({
  submission,
  isFirstVersion,
  onWithdraw,
  busy,
}: {
  submission: Submission;
  isFirstVersion: boolean;
  onWithdraw: () => void;
  busy: boolean;
}) {
  if (submission.status === 'pending') {
    return (
      <Button
        size="xs"
        variant="default"
        color="red"
        onClick={onWithdraw}
        disabled={busy}
        loading={busy}
      >
        Withdraw
      </Button>
    );
  }
  if (submission.status === 'approved') {
    const live = submission.deployState === 'live' || submission.deployState == null;
    if (!live && isFirstVersion) {
      return (
        <Text size="xs" c="dimmed">
          —
        </Text>
      );
    }
    return (
      <Button
        size="xs"
        variant="default"
        component="a"
        href={`https://${submission.slug}.civit.ai/`}
        target="_blank"
        rel="noopener"
        rightSection={<IconExternalLink size={12} />}
      >
        Open live
      </Button>
    );
  }
  if (submission.status === 'rejected') {
    return (
      <Button
        size="xs"
        component={Link}
        href="/apps/submit"
        rightSection={<IconArrowRight size={12} />}
      >
        Resubmit
      </Button>
    );
  }
  return null;
}

/**
 * Install + subscription count for an approved submission.
 */
function InstallCountCell({
  modelInstalls,
  subscriptions,
}: {
  modelInstalls: number | null;
  subscriptions: number | null;
}) {
  if (modelInstalls == null && subscriptions == null) {
    return (
      <Text size="xs" c="dimmed">
        —
      </Text>
    );
  }
  return (
    <Group gap={6}>
      <Badge
        variant="light"
        color="blue"
        size="sm"
        leftSection={<IconBox size={12} />}
        title="Pinned subscriptions — per-model placements"
      >
        {modelInstalls ?? 0}
      </Badge>
      <Badge
        variant="light"
        color="grape"
        size="sm"
        leftSection={<IconUsers size={12} />}
        title="BlockUserSubscription rows — publisher + viewer scopes"
      >
        {subscriptions ?? 0}
      </Badge>
    </Group>
  );
}
