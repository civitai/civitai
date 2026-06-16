import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/my-submissions — dev's view of their publish-request history.
 *
 * Lists every request submitted by the viewer, newest first. For pending
 * requests there's a Withdraw button. For rejected requests the reason
 * is shown inline so the dev sees mod feedback without a round-trip.
 * For approved requests a link to the live URL is shown.
 *
 * v0 gate: requires `isModerator` (only mods can submit at v0; v1 opens
 * to external developers behind W11/W5).
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
    if (!isAppDeveloper(session.user)) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

type FileSummary = {
  files?: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added?: string[];
  removed?: string[];
  changed?: string[];
};

type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

type Submission = {
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
  /** Total pinned subscriptions referencing this app block. (Was the
   * ModelBlockInstall count before the 2026-05-30 kill_per_model_installs
   * migration absorbed per-model installs into block_user_subscriptions.)
   * Null when the publish request has no app block yet (pending first-
   * version, withdrawn first-version). */
  modelInstallCount: number | null;
  /** Total BlockUserSubscription rows. Same null semantics as above. */
  userSubscriptionCount: number | null;
};

function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

function statusBadge(submission: Pick<Submission, 'status' | 'deployState'>) {
  const { status } = submission;
  // For an approved request, show the real build/deploy lifecycle rather than a
  // flat "approved" — the dev cares whether their code is actually live.
  if (status === 'approved') {
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
        // Legacy/pre-Phase-2 approved rows (no deploy_state captured).
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

export default function MySubmissionsPage() {
  const features = useFeatureFlags();
  const submissionsQuery = trpc.blocks.listMyPublishRequests.useQuery(undefined, {
    enabled: !!features?.appBlocks,
    // Live-update the badge while any approved submission is mid-build/deploy;
    // stop polling once everything is terminal (live/failed/non-approved).
    refetchInterval: (query) => {
      const data = (query.state.data ?? []) as Submission[];
      const inFlight = data.some(
        (s) =>
          s.status === 'approved' &&
          (s.deployState === 'building' || s.deployState === 'deploying')
      );
      return inFlight ? 5000 : false;
    },
  });

  const withdrawMutation = trpc.blocks.withdrawPublishRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Submission withdrawn.' });
      await submissionsQuery.refetch();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Withdraw failed',
        error: new Error(e.message),
      });
    },
  });

  if (!features?.appBlocks) return <NotFound />;

  const submissions = (submissionsQuery.data ?? []) as Submission[];

  return (
    <>
      <Meta title="My app submissions — Civitai" deIndex />
      <Container size="xl" py="xl">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-end">
            <Stack gap={4}>
              <Title order={2}>My submissions</Title>
              <Text c="dimmed" size="sm">
                Status of every app submission you've made. Rejections show the
                reviewer's feedback inline; pending submissions can be withdrawn.
              </Text>
            </Stack>
            <Button
              component={Link}
              href="/apps/submit"
              rightSection={<IconArrowRight size={16} />}
            >
              Submit a new app
            </Button>
          </Group>

          {submissionsQuery.isError && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {submissionsQuery.error.message}
            </Alert>
          )}

          {!submissionsQuery.isLoading && submissions.length === 0 && (
            <Card withBorder p="lg">
              <Stack gap="xs" align="center" py="md">
                <Text>You haven't submitted any apps yet.</Text>
                <Button component={Link} href="/apps/submit">
                  Submit your first app
                </Button>
              </Stack>
            </Card>
          )}

          {submissions.length > 0 && (
            <Card withBorder p={0}>
              <Table verticalSpacing="md" horizontalSpacing="md">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>App</Table.Th>
                    <Table.Th>Version</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Submitted</Table.Th>
                    <Table.Th>Reviewed</Table.Th>
                    <Table.Th>Changes</Table.Th>
                    <Table.Th>Installs</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {submissions.map((s) => {
                    const fs = (s.fileSummary ?? {}) as FileSummary;
                    const mds = (s.manifestDiffSummary ?? {}) as ManifestDiffSummary;
                    const isFirst = mds.kind === 'first-version';
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
                          <Table.Td>{statusBadge(s)}</Table.Td>
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
                            <Group gap={6}>
                              {(fs.added?.length ?? 0) > 0 && (
                                <Badge color="green" size="xs">
                                  +{fs.added?.length}
                                </Badge>
                              )}
                              {(fs.changed?.length ?? 0) > 0 && (
                                <Badge color="yellow" size="xs">
                                  ~{fs.changed?.length}
                                </Badge>
                              )}
                              {(fs.removed?.length ?? 0) > 0 && (
                                <Badge color="red" size="xs">
                                  −{fs.removed?.length}
                                </Badge>
                              )}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <InstallCountCell
                              modelInstalls={s.modelInstallCount}
                              subscriptions={s.userSubscriptionCount}
                            />
                          </Table.Td>
                          <Table.Td>
                            <SubmissionActions
                              submission={s}
                              onWithdraw={() =>
                                withdrawMutation.mutate({ publishRequestId: s.id })
                              }
                              busy={withdrawMutation.isPending}
                            />
                          </Table.Td>
                        </Table.Tr>
                        {s.status === 'rejected' && s.rejectionReason && (
                          <Table.Tr>
                            <Table.Td colSpan={8} p={0}>
                              <Alert
                                color="red"
                                variant="light"
                                radius={0}
                                icon={<IconX size={16} />}
                                title="Reviewer feedback"
                              >
                                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                  {s.rejectionReason}
                                </Text>
                              </Alert>
                            </Table.Td>
                          </Table.Tr>
                        )}
                        {s.status === 'approved' && s.approvalNotes && (
                          <Table.Tr>
                            <Table.Td colSpan={8} p={0}>
                              <Alert
                                color="green"
                                variant="light"
                                radius={0}
                                icon={<IconCheck size={16} />}
                                title="Reviewer notes"
                              >
                                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                  {s.approvalNotes}
                                </Text>
                              </Alert>
                            </Table.Td>
                          </Table.Tr>
                        )}
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
                      </Fragment>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Card>
          )}
        </Stack>
      </Container>
    </>
  );
}

function SubmissionActions({
  submission,
  onWithdraw,
  busy,
}: {
  submission: Submission;
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
 * Install + subscription count for an approved submission. Renders two
 * compact pills: model installs (per-model placements) and user
 * subscriptions (publisher/viewer scope rows). Null means there's no
 * AppBlock row yet (pending/withdrawn first-version) so we show a dash.
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
