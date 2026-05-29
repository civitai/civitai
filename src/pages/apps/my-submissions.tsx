import {
  Alert,
  Anchor,
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
  IconCheck,
  IconClock,
  IconExternalLink,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
    if (!session.user.isModerator) {
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
  fileSummary: unknown;
  manifestDiffSummary: unknown;
};

function formatDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return (
        <Badge color="blue" leftSection={<IconClock size={12} />}>
          pending
        </Badge>
      );
    case 'approved':
      return (
        <Badge color="green" leftSection={<IconCheck size={12} />}>
          approved
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
                          <Table.Td>{statusBadge(s.status)}</Table.Td>
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
                            <SubmissionActions
                              submission={s}
                              onWithdraw={() =>
                                withdrawMutation.mutate({ publishRequestId: s.id })
                              }
                              busy={withdrawMutation.isLoading}
                            />
                          </Table.Td>
                        </Table.Tr>
                        {s.status === 'rejected' && s.rejectionReason && (
                          <Table.Tr
                            style={{ background: 'var(--mantine-color-red-0)' }}
                          >
                            <Table.Td colSpan={7}>
                              <Stack gap={4} px="xs">
                                <Group gap={6}>
                                  <IconX size={14} color="var(--mantine-color-red-6)" />
                                  <Text size="xs" fw={600} c="red">
                                    Reviewer feedback
                                  </Text>
                                </Group>
                                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                  {s.rejectionReason}
                                </Text>
                              </Stack>
                            </Table.Td>
                          </Table.Tr>
                        )}
                        {s.status === 'approved' && s.approvalNotes && (
                          <Table.Tr
                            style={{ background: 'var(--mantine-color-green-0)' }}
                          >
                            <Table.Td colSpan={7}>
                              <Stack gap={4} px="xs">
                                <Group gap={6}>
                                  <IconCheck
                                    size={14}
                                    color="var(--mantine-color-green-6)"
                                  />
                                  <Text size="xs" fw={600} c="green">
                                    Reviewer notes
                                  </Text>
                                </Group>
                                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                  {s.approvalNotes}
                                </Text>
                              </Stack>
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
