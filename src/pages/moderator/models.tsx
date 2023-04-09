import {
  Anchor,
  Center,
  Container,
  Group,
  List,
  Loader,
  Pagination,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { IconExternalLink } from '@tabler/icons';
import Link from 'next/link';
import { useState } from 'react';
import { UnpublishReason, unpublishReasons } from '~/server/common/moderation-helpers';
import { formatDate } from '~/utils/date-helpers';

import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export default function ModeratorModels() {
  const [page, setPage] = useState(1);

  const { data, isLoading } = trpc.model.getAllPagedSimple.useQuery({
    needsReview: true,
    status: [ModelStatus.UnpublishedViolation],
    page,
    limit: 20,
  });

  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  return (
    <Container size="sm">
      <Stack spacing={0} mb="xl">
        <Title order={1}>Models Needing Review</Title>
        <Text size="sm" color="dimmed">
          Unpublished models for violating ToS which their owners have request a review
        </Text>
      </Stack>
      {isLoading ? (
        <Center p="xl">
          <Loader size="lg" />
        </Center>
      ) : !!data?.items.length ? (
        <Stack>
          <List listStyleType="none" spacing="md">
            {data?.items.map((model) => {
              const unpublishedAt =
                model.meta && model.meta.unpublishedAt ? new Date(model.meta.unpublishedAt) : null;
              return (
                <List.Item
                  key={model.id}
                  sx={(theme) => ({
                    padding: theme.spacing.sm,
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
                    }`,
                  })}
                >
                  <Stack spacing={4}>
                    {unpublishedAt && (
                      <Text size="xs" color="dimmed">
                        Unpublished at: {formatDate(unpublishedAt)}
                      </Text>
                    )}
                    <Link href={`/models/${model.id}/${slugit(model.name)}`} passHref>
                      <Anchor size="md" target="_blank" lineClamp={1}>
                        {model.name} <IconExternalLink size={16} stroke={1.5} />
                      </Anchor>
                    </Link>
                    {model.meta && model.meta.unpublishedReason && (
                      <Text size="sm">
                        <Text weight={500} size="sm" span>
                          Reason initially unpublished:
                        </Text>{' '}
                        {
                          unpublishReasons[model.meta.unpublishedReason as UnpublishReason]
                            .optionLabel
                        }
                      </Text>
                    )}
                  </Stack>
                </List.Item>
              );
            })}
          </List>
          {pagination.totalPages > 1 && (
            <Group position="apart">
              <Text>Total {pagination.totalItems} items</Text>
              <Pagination page={page} onChange={setPage} total={pagination.totalPages} />
            </Group>
          )}
        </Stack>
      ) : (
        <Paper p="xl" withBorder>
          <Center>
            <Text size="md" color="dimmed">
              There are no models that need review
            </Text>
          </Center>
        </Paper>
      )}
    </Container>
  );
}
