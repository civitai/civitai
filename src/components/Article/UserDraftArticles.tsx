import {
  ActionIcon,
  Anchor,
  Badge,
  Center,
  createStyles,
  Group,
  LoadingOverlay,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconExternalLink, IconTrash } from '@tabler/icons';
import Link from 'next/link';
import { useState } from 'react';

import { NoContent } from '~/components/NoContent/NoContent';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  header: {
    position: 'sticky',
    top: 0,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
    transition: 'box-shadow 150ms ease',
    zIndex: 10,

    '&::after': {
      content: '""',
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderBottom: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2]
      }`,
    },
  },

  scrolled: {
    boxShadow: theme.shadows.sm,
  },
}));

export function UserDraftArticles() {
  const { classes, cx } = useStyles();
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
        <Table verticalSpacing="md" fontSize="md" striped={hasDrafts}>
          <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
            <tr>
              <th>Title</th>
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
                    <Link href={`/articles/${article.id}/edit`} passHref>
                      <Anchor lineClamp={2}>
                        {article.title} <IconExternalLink size={16} stroke={1.5} />
                      </Anchor>
                    </Link>
                  </td>
                  <td>{article.category ? <Badge>{article.category.name}</Badge> : 'N/A'}</td>
                  <td>{article.createdAt ? formatDate(article.createdAt) : 'N/A'}</td>
                  <td>{article.updatedAt ? formatDate(article.updatedAt) : 'N/A'}</td>
                  <td>
                    <Group position="right" pr="xs">
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
        <Group position="apart">
          <Text>Total {pagination.totalItems} items</Text>
          <Pagination page={page} onChange={setPage} total={pagination.totalPages} />
        </Group>
      )}
    </Stack>
  );
}
