import {
  Anchor,
  Badge,
  Button,
  Center,
  Container,
  Group,
  List,
  Loader,
  Modal,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { IconExternalLink } from '@tabler/icons-react';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import Link from 'next/link';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { usePaddleAdjustmentsInfinite } from '~/components/Paddle/util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

import { unpublishReasons } from '~/server/common/moderation-helpers';
import { ModelGetAllPagedSimple } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';

type State = {
  declineReason: string;
  page: number;
  opened: boolean;
  selectedModel: ModelGetAllPagedSimple['items'][number] | null;
};

export default function ModeratorPaddleAdjustments() {
  const { adjustments, isLoading, isFetching, fetchNextPage, hasNextPage } =
    usePaddleAdjustmentsInfinite({ limit: 50 });
  const featureFlags = useFeatureFlags();

  if (!featureFlags.paddleAdjustments) {
    return <NotFound />;
  }

  return (
    <Container size="sm">
      <Stack spacing={0} mb="xl">
        <Title order={1}>Paddle Adjustments</Title>
        <Text size="sm" color="dimmed">
          Includes refunds and Cashbacks we&rsquo;ve seen on Paddle. This mainly because Paddle has
          no way to check this on their platform.
        </Text>
      </Stack>
      {isLoading ? (
        <Center p="xl">
          <Loader size="lg" />
        </Center>
      ) : !!adjustments.length ? (
        <Stack>
          <Table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Created at</th>
                <th>Currency</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Customer</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((adjustment) => {
                return (
                  <tr key={adjustment.id}>
                    <td>{getDisplayName(adjustment.action.replace('_', ' '))}</td>
                    <td>{formatDate(adjustment.createdAt)}</td>
                    <td>{adjustment.currencyCode ?? 'N/A'}</td>
                    <td>
                      {adjustment.payoutTotals?.total
                        ? formatPriceForDisplay(parseInt(adjustment.payoutTotals?.total, 10))
                        : 'N/A'}
                    </td>
                    <td>
                      <Badge>{getDisplayName(adjustment.status.replace('_', ' '))}</Badge>
                    </td>
                    <td>
                      <Stack spacing={0}>
                        <Anchor
                          size="xs"
                          href={`/moderator/paddle/customer/${adjustment.customerId}`}
                        >
                          Paddle
                        </Anchor>
                        <Anchor
                          size="xs"
                          href={`/moderator/paddle/customer/${adjustment.customerId}`}
                        >
                          Civitai
                        </Anchor>
                      </Stack>
                    </td>
                    <td>{adjustment.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          {isFetching && !isLoading && (
            <Center>
              <Loader size="md" />
            </Center>
          )}
          <Center>
            <Stack>
              {!hasNextPage && (
                <Text size="sm" color="dimmed">
                  No more adjustments
                </Text>
              )}
              <Button
                loading={isFetching || isLoading}
                variant="light"
                onClick={fetchNextPage}
                disabled={!hasNextPage}
              >
                Load more
              </Button>
            </Stack>
          </Center>
        </Stack>
      ) : (
        <Paper p="xl" withBorder>
          <Center>
            <Text size="md" color="dimmed">
              No adjustments found
            </Text>
          </Center>
        </Paper>
      )}
    </Container>
  );
}
