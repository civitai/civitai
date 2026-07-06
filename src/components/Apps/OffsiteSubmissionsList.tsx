import { Anchor, Badge, Button, Card, Code, Group, Stack, Table, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import {
  isWithdrawableOffsiteStatus,
  offsiteStatusChip,
} from '~/components/Apps/offsiteSubmissionStatus';
import { ReviewerNotesButton } from '~/components/Apps/MySubmissionsList';

/**
 * /apps/my-submissions — the author's OFF-SITE (external-link) submissions, shown
 * ALONGSIDE the on-site publish-request list (W13 P3a). Kind-aware status chips
 * (pending/approved/rejected/withdrawn), the reviewer-notes modal, an external-URL
 * link, and a Withdraw action for pending rows. Data is
 * `appListings.listMySubmissions` (scoped to the caller server-side).
 */

export type OffsiteSubmission = {
  id: string;
  appListingId: string | null;
  slug: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  approvalNotes: string | null;
  changelog: string | null;
  appListing: {
    name: string | null;
    externalUrl: string | null;
    category: string | null;
    contentRating: string | null;
  } | null;
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

function StatusCell({ submission }: { submission: OffsiteSubmission }) {
  const chip = offsiteStatusChip(submission.status);
  const notes =
    submission.status === 'rejected'
      ? submission.rejectionReason
      : submission.status === 'approved'
      ? submission.approvalNotes
      : null;
  return (
    <Stack gap={6} align="flex-start">
      <Badge color={chip.color}>{chip.label}</Badge>
      {notes && (
        <ReviewerNotesButton
          notes={notes}
          variant={submission.status === 'rejected' ? 'rejected' : 'approved'}
        />
      )}
    </Stack>
  );
}

export function OffsiteSubmissionsList({
  submissions,
  onWithdraw,
  withdrawing,
}: {
  submissions: OffsiteSubmission[];
  onWithdraw: (publishRequestId: string) => void;
  withdrawing: boolean;
}) {
  return (
    <Card withBorder p={0}>
      <Table verticalSpacing="md" horizontalSpacing="md">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>App</Table.Th>
            <Table.Th>Link</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Submitted</Table.Th>
            <Table.Th>Reviewed</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {submissions.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>
                <Group gap={6}>
                  <Code>{s.slug}</Code>
                  <Badge size="xs" color="grape" variant="light">
                    external
                  </Badge>
                </Group>
                {s.appListing?.name && (
                  <Text size="xs" c="dimmed">
                    {s.appListing.name}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                {s.appListing?.externalUrl ? (
                  <Anchor
                    href={s.appListing.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="xs"
                  >
                    <Group gap={4} wrap="nowrap">
                      <Text size="xs" lineClamp={1} style={{ maxWidth: 220 }}>
                        {s.appListing.externalUrl}
                      </Text>
                      <IconExternalLink size={12} />
                    </Group>
                  </Anchor>
                ) : (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <StatusCell submission={s} />
              </Table.Td>
              <Table.Td>
                <Text size="xs">{formatDate(s.submittedAt)}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c={s.reviewedAt ? undefined : 'dimmed'}>
                  {formatDate(s.reviewedAt)}
                </Text>
              </Table.Td>
              <Table.Td>
                {isWithdrawableOffsiteStatus(s.status) ? (
                  <Button
                    size="xs"
                    variant="default"
                    color="red"
                    onClick={() => onWithdraw(s.id)}
                    disabled={withdrawing}
                    loading={withdrawing}
                  >
                    Withdraw
                  </Button>
                ) : (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}
