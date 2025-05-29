import {
  Anchor,
  Badge,
  Button,
  Center,
  Checkbox,
  Container,
  Group,
  LoadingOverlay,
  Menu,
  Pagination,
  ScrollArea,
  Stack,
  Table,
  Text,
  ThemeIcon,
  useComputedColorScheme,
} from '@mantine/core';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { IconChevronDown, IconExclamationMark, IconExternalLink } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCallback, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BackButton } from '~/components/BackButton/BackButton';
import { Collection } from '~/components/Collection/Collection';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TagSort } from '~/server/common/enums';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { postgresSlugify, slugit, titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { Meta } from '~/components/Meta/Meta';
import styles from './manage-categories.module.scss';
import clsx from 'clsx';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ ssg, session, ctx }) => {
    const result = userPageQuerySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    // if there's no session and is not the same user, return not found
    if (!session?.user || postgresSlugify(session.user.username) !== result.data.username)
      return { notFound: true };

    if (ssg) await ssg.model.getWithCategoriesSimple.prefetch({ userId: session.user.id, page: 1 });

    return { props: { username: result.data.username } };
  },
});

export default function ManageCategories({
  username,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);
  const [selection, setSelection] = useState<number[]>([]);
  const colorScheme = useComputedColorScheme('dark');

  const { data, isLoading: loadingCategories } = trpc.tag.getAll.useQuery({
    categories: true,
    unlisted: false,
    entityType: [TagTarget.Model],
    sort: TagSort.MostModels,
    limit: 100,
  });

  const { data: models, isLoading: loadingModels } = trpc.model.getWithCategoriesSimple.useQuery(
    {
      userId: currentUser?.id,
      page,
    },
    { enabled: !!currentUser, keepPreviousData: true }
  );
  const { items, ...pagination } = models || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const toggleRow = (id: number) =>
    setSelection((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );

  const { mutate, isLoading } = trpc.model.setCategory.useMutation();
  const handleUpdateCategories = useCallback(
    (categoryId: number) => {
      mutate(
        { categoryId, modelIds: selection },
        {
          async onSuccess() {
            setSelection([]);
            showSuccessNotification({
              title: 'Success',
              message: 'Successfully updated models category',
            });
            await queryUtils.model.getWithCategoriesSimple.invalidate();
          },
          onError(error) {
            showErrorNotification({
              title: 'Failed to update models category',
              error: new Error(error.message),
            });
          },
        }
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate, selection]
  );

  const categories = useMemo(
    () =>
      data?.items.map((tag) => (
        <Menu.Item key={tag.id} onClick={() => handleUpdateCategories(tag.id)}>
          {titleCase(tag.name)}
        </Menu.Item>
      )),
    [data?.items, handleUpdateCategories]
  );

  const rows = useMemo(
    () =>
      items.map((model) => {
        const selected = selection.includes(model.id);
        return (
          <tr key={model.id} className={clsx({ [styles.rowSelected]: selected })}>
            <td style={{ maxWidth: '2.5rem' }}>
              <Checkbox
                checked={selection.includes(model.id)}
                onChange={() => toggleRow(model.id)}
              />
            </td>
            <td>
              <Group gap={8}>
                {(!model.tags.length || model.tags.length > 1) && (
                  <ThemeIcon size="sm" color="yellow">
                    <IconExclamationMark />
                  </ThemeIcon>
                )}
                <Link legacyBehavior href={`/models/${model.id}/${slugit(model.name)}`} passHref>
                  <Anchor target="_blank" lineClamp={2}>
                    {model.name} <IconExternalLink size={16} stroke={1.5} />
                  </Anchor>
                </Link>
              </Group>
            </td>
            <td>
              <Group gap={4} justify="flex-end">
                {model.tags.length > 0 ? (
                  <Collection
                    items={model.tags}
                    limit={2}
                    renderItem={(tag) => (
                      <Badge
                        key={tag.id}
                        color="gray"
                        variant={colorScheme === 'dark' ? 'filled' : undefined}
                      >
                        {tag.name}
                      </Badge>
                    )}
                  />
                ) : (
                  <Badge color="gray" variant={colorScheme === 'dark' ? 'filled' : undefined}>
                    N/A
                  </Badge>
                )}
              </Group>
            </td>
          </tr>
        );
      }),
    [styles.rowSelected, items, selection, colorScheme]
  );

  const isSameUser = !!currentUser && postgresSlugify(currentUser?.username) === username;
  if (!currentUser || !isSameUser) return <NotFound />;

  const hasModels = items.length > 0;

  return (
    <>
      <Meta deIndex />
      <Container size="sm">
        <Stack>
          <ScrollArea
            style={{ height: 500 }}
            onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
          >
            <Table verticalSpacing="sm" fz="sm">
              <thead className={clsx(styles.header, { [styles.scrolled]: scrolled })}>
                <tr>
                  <th style={{ maxWidth: 30 }}>
                    <BackButton url={`/user/${username}`} />
                  </th>
                  <th colSpan={3}>
                    <Group justify="space-between">
                      <Group gap={4}>
                        <Text size="lg">Model Category Manager</Text>
                      </Group>
                      <Group gap={4}>
                        {selection.length > 0 && (
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() => setSelection([])}
                          >
                            Clear Selection
                          </Button>
                        )}
                        <Menu width={200} withinPortal>
                          <Menu.Target>
                            <Button
                              size="xs"
                              rightSection={<IconChevronDown size={18} />}
                              loading={isLoading}
                            >
                              Set Category {selection.length > 0 && `(${selection.length})`}
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {loadingCategories ? (
                              <Center p="xs">
                                <Text c="dimmed">Loading...</Text>
                              </Center>
                            ) : selection.length === 0 ? (
                              <Center p="xs">
                                <Text c="dimmed">You must select at least one model</Text>
                              </Center>
                            ) : (
                              categories
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      </Group>
                    </Group>
                  </th>
                </tr>
              </thead>
              <tbody style={{ position: 'relative' }}>
                {hasModels ? (
                  rows
                ) : (
                  <tr>
                    <td colSpan={3}>
                      {loadingModels && <LoadingOverlay visible />}
                      <Center py="md">
                        <NoContent message="You have no draft models" />
                      </Center>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </ScrollArea>
          {pagination.totalPages > 1 && (
            <Group justify="space-between">
              <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
              <Pagination value={page} onChange={setPage} total={pagination.totalPages} />
            </Group>
          )}
        </Stack>
      </Container>
    </>
  );
}
