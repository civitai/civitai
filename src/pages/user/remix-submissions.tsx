import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * What you have submitted to other people's remix galleries.
 *
 * Withdrawing is the reason this page exists: the pending cap is per creator, so
 * someone who has hit it needs somewhere to find and clear a submission, and
 * nothing else in the app points at one.
 */
export default function RemixSubmissions() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.placement.getMyRemixGallerySubmissions.useQuery();

  const retract = trpc.placement.retractRemixGallerySubmission.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Withdrawn',
        message: 'Your Buzz has been returned in full.',
      });
      utils.placement.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't withdraw that", error: new Error(error.message) }),
  });

  const rows = data ?? [];

  return (
    <>
      <Meta title="Your remix gallery submissions" deIndex />
      <Container size="md" my="md">
        <Stack gap="md">
          <div>
            <Title order={2}>Your remix gallery submissions</Title>
            <Text size="sm" c="dimmed">
              You can withdraw a submission any time before the creator reviews it and get your Buzz
              back in full. Once it has been accepted there is nothing to withdraw.
            </Text>
          </div>

          {isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : !rows.length ? (
            <Alert color="gray">You haven&apos;t submitted any remixes yet.</Alert>
          ) : (
            rows.map((row) => (
              <Card key={row.id} withBorder>
                <Group justify="space-between" wrap="nowrap">
                  <Stack gap={4}>
                    <Group gap="xs">
                      <Badge
                        size="sm"
                        variant="light"
                        color={row.status === 'approved' ? 'green' : 'yellow'}
                      >
                        {row.status === 'approved' ? 'Live' : 'Awaiting review'}
                      </Badge>
                      <Group gap={4}>
                        <CurrencyIcon currency={Currency.BUZZ} size={12} />
                        <Text size="xs" c="dimmed">
                          {row.amount}
                        </Text>
                      </Group>
                    </Group>
                    <Text size="sm">On {row.owner?.username ?? 'a creator'}&apos;s image</Text>
                    <Text size="xs" c="dimmed">
                      Submitted {formatDate(row.createdAt)}
                      {row.status === 'pending' && row.expiresAt
                        ? ` — expires ${formatDate(row.expiresAt)}`
                        : ''}
                    </Text>
                    <Anchor component={Link} href={`/images/${row.targetId}`} size="xs">
                      <Group gap={4} wrap="nowrap">
                        <IconExternalLink size={12} />
                        See the gallery
                      </Group>
                    </Anchor>
                  </Stack>

                  {row.status === 'pending' && (
                    <Button
                      variant="default"
                      size="compact-sm"
                      loading={retract.isLoading}
                      onClick={() => retract.mutate({ placementId: row.id })}
                    >
                      Withdraw
                    </Button>
                  )}
                </Group>
              </Card>
            ))
          )}
        </Stack>
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user || session.user.bannedAt)
      return { redirect: { destination: '/', permanent: false } };
  },
});
