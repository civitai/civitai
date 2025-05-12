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

export function UserDraftArticles() {
  const queryUtils = trpc.useContext();

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
          <thead className={clsx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Category</th>
              <th>Created</th>
              <th>Last Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5}>
                  <LoadingOverlay visible />
                </td>
              </tr>
            )}
            {hasDrafts ? (
              items.map((article) => (
                <tr key={article.id}>
                  <td>
                    <Link legacyBehavior href={`/articles/${article.id}/edit`} passHref>
                      <Anchor lineClamp={2}>
                        {article.title} <IconExternalLink size={16} stroke={1.5} />
                      </Anchor>
                    </Link>
                  </td>
                  <td>
                    {
                      <Badge color={article.status === 'Draft' ? 'gray' : 'yellow'}>
                        {article.status}
                      </Badge>
                    }
                  </td>
                  <td>{article.category ? <Badge>{article.category.name}</Badge> : 'N/A'}</td>
                  <td>{article.createdAt ? formatDate(article.createdAt) : 'N/A'}</td>
                  <td>{article.updatedAt ? formatDate(article.updatedAt) : 'N/A'}</td>
                  <td>
                    <Group justify="flex-end" pr="xs">
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        size="sm"
                        onClick={() => handleDeleteArticle(article)}
                      >
                        <IconTrash />
                      </ActionIcon>
                    </Group>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <Center py="md">
                    <NoContent message="You have no draft articles" />
                  </Center>
                </td>
              </tr>
            )}
          </tbody>
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
