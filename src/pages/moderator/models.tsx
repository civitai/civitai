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
            {data?.items.map((model) => (
              <List.Item
                key={model.id}
                sx={(theme) => ({
                  padding: theme.spacing.sm,
                  border: `1px solid ${
                    theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
                  }`,
                })}
              >
                <Link href={`/models/${model.id}/${slugit(model.name)}`} passHref legacyBehavior>
                  <Anchor size="md" target="_blank" lineClamp={1}>
                    {model.name} <IconExternalLink size={16} stroke={1.5} />
                  </Anchor>
                </Link>
              </List.Item>
            ))}
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
