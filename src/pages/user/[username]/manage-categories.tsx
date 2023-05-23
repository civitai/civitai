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
  createStyles,
} from '@mantine/core';
import { TagTarget } from '@prisma/client';
import { IconChevronDown, IconExclamationMark, IconExternalLink } from '@tabler/icons-react';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
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
  rowSelected: {
    backgroundColor:
      theme.colorScheme === 'dark'
        ? theme.fn.rgba(theme.colors[theme.primaryColor][7], 0.2)
        : theme.colors[theme.primaryColor][0],
  },
}));

export default function ManageCategories({
  username,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { classes, cx, theme } = useStyles();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const [page, setPage] = useState(1);
  const [scrolled, setScrolled] = useState(false);
  const [selection, setSelection] = useState<number[]>([]);

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
          <tr key={model.id} className={cx({ [classes.rowSelected]: selected })}>
            <td style={{ maxWidth: '2.5rem' }}>
              <Checkbox
                checked={selection.includes(model.id)}
                onChange={() => toggleRow(model.id)}
                transitionDuration={0}
              />
            </td>
            <td>
              <Group spacing={8}>
                {(!model.tags.length || model.tags.length > 1) && (
                  <ThemeIcon size="sm" color="yellow">
                    <IconExclamationMark />
                  </ThemeIcon>
                )}
                <Link href={`/models/${model.id}/${slugit(model.name)}`} passHref>
                  <Anchor target="_blank" lineClamp={2}>
                    {model.name} <IconExternalLink size={16} stroke={1.5} />
                  </Anchor>
                </Link>
              </Group>
            </td>
            <td>
              <Group spacing={4} position="right">
                {model.tags.length > 0 ? (
                  <Collection
                    items={model.tags}
                    limit={2}
                    renderItem={(tag) => (
                      <Badge
                        key={tag.id}
                        color="gray"
                        variant={theme.colorScheme === 'dark' ? 'filled' : undefined}
                      >
                        {tag.name}
                      </Badge>
                    )}
                  />
                ) : (
                  <Badge color="gray" variant={theme.colorScheme === 'dark' ? 'filled' : undefined}>
                    N/A
                  </Badge>
                )}
              </Group>
            </td>
          </tr>
        );
      }),
    [classes.rowSelected, cx, items, selection, theme.colorScheme]
  );

  const isSameUser = !!currentUser && postgresSlugify(currentUser?.username) === username;
  if (!currentUser || !isSameUser) return <NotFound />;

  const hasModels = items.length > 0;

  return (
    <Container size="sm">
      <Stack>
        <ScrollArea
          style={{ height: 500 }}
          onScrollPositionChange={({ y }) => setScrolled(y !== 0)}
        >
          <Table verticalSpacing="sm" fontSize="sm">
            <thead className={cx(classes.header, { [classes.scrolled]: scrolled })}>
              <tr>
                <th style={{ maxWidth: 30 }}>
                  <BackButton url={`/user/${username}`} />
                </th>
                <th colSpan={3}>
                  <Group position="apart">
                    <Group spacing={4}>
                      <Text size="lg">Model Category Manager</Text>
                    </Group>
                    <Group spacing={4}>
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
                            rightIcon={<IconChevronDown size={18} />}
                            loading={isLoading}
                          >
                            Set Category {selection.length > 0 && `(${selection.length})`}
                          </Button>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {loadingCategories ? (
                            <Center p="xs">
                              <Text color="dimmed">Loading...</Text>
                            </Center>
                          ) : selection.length === 0 ? (
                            <Center p="xs">
                              <Text color="dimmed">You must select at least one model</Text>
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
          <Group position="apart">
            <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
            <Pagination page={page} onChange={setPage} total={pagination.totalPages} />
          </Group>
        )}
      </Stack>
    </Container>
  );
}
