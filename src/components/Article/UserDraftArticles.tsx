import {
  ActionIcon,
  Anchor,
  Badge,
  Center,
  Group,
  LoadingOverlay,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconExternalLink, IconTrash } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useState } from 'react';

import { NoContent } from '~/components/NoContent/NoContent';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import classes from './UserDraftArticles.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function UserDraftArticles() {
  const queryUtils = trpc.useUtils();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);

  const { data, isLoading } = trpc.article.getMyDraftArticles.useQuery({ page, limit: 10 });
  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const deleteMutation = trpc.article.delete.useMutation({
    onSuccess: async () => {
      await queryUtils.article.getMyDraftArticles.invalidate();
    },
  });
  const handleDeleteArticle = (article: (typeof items)[number]) => {
    openConfirmModal({
      title: 'Delete article',
      children: 'Are you sure you want to delete this article? This action is destructive.',
      centered: true,
      labels: { confirm: 'Delete Article', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteMutation.mutate({ id: article.id });
      },
    });
  };

  const hasDrafts = items.length > 0;

  return (
    <Stack>
      <ScrollArea style={{ height: 400 }} onScrollPositionChange={({ y }) => setScrolled(y !== 0)}>
        <Table verticalSpacing="md" fz="md" striped={hasDrafts}>
          <Table.Thead className={clsx(classes.header, { [classes.scrolled]: scrolled })}>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Category</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Last Updated</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <LoadingOverlay visible />
                </Table.Td>
              </Table.Tr>
            )}
            {hasDrafts ? (
              items.map((article) => (
                <Table.Tr key={article.id}>
                  <Table.Td>
                    <Link legacyBehavior href={`/articles/${article.id}/edit`} passHref>
                      <Anchor lineClamp={2}>
                        {article.title} <IconExternalLink size={16} stroke={1.5} />
                      </Anchor>
                    </Link>
                  </Table.Td>
                  <Table.Td>
                    {
                      <Badge color={article.status === 'Draft' ? 'gray' : 'yellow'}>
                        {article.status}
                      </Badge>
                    }
                  </Table.Td>
                  <Table.Td>
                    {article.category ? <Badge>{article.category.name}</Badge> : 'N/A'}
                  </Table.Td>
                  <Table.Td>{article.createdAt ? formatDate(article.createdAt) : 'N/A'}</Table.Td>
                  <Table.Td>{article.updatedAt ? formatDate(article.updatedAt) : 'N/A'}</Table.Td>
                  <Table.Td>
                    <Group justify="flex-end" pr="xs">
                      <LegacyActionIcon
                        color="red"
                        variant="subtle"
                        size="sm"
                        onClick={() => handleDeleteArticle(article)}
                      >
                        <IconTrash />
                      </LegacyActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))
            ) : (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Center py="md">
                    <NoContent message="You have no draft articles" />
                  </Center>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {pagination.totalPages > 1 && (
        <Group justify="space-between">
          <Text>Total {pagination.totalItems} items</Text>
          <Pagination value={page} onChange={setPage} total={pagination.totalPages} />
        </Group>
      )}
    </Stack>
  );
}
