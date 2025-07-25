import {
  Center,
  Container,
  Group,
  List,
  Loader,
  Pagination,
  Paper,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';

import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import FourOhFour from '~/pages/404';
import { abbreviateNumber } from '~/utils/number-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbRead } from '~/server/db/client';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

interface UserListContentProps {
  items: Array<{ id: number; username: string | null; image?: string }>;
  type: 'following' | 'followers' | 'hidden' | 'blocked';
  totalCount: number;
  page: number;
  onPageChange: (page: number) => void;
}

const LIST_LIMIT = 20;

function UserListContent({ items, type, totalCount, page, onPageChange }: UserListContentProps) {
  const totalPages = Math.ceil(totalCount / LIST_LIMIT);

  const getEmptyMessage = () => {
    switch (type) {
      case 'following':
        return 'There are no following to show';
      case 'followers':
        return 'There are no followers to show';
      case 'hidden':
        return 'There are no hidden users to show';
      case 'blocked':
        return 'There are no blocked users to show';
      default:
        return 'No users to show';
    }
  };

  return (
    <>
      {items.length > 0 ? (
        <List listStyleType="none" styles={{ itemWrapper: { width: '100%' } }}>
          {items.map((user: { id: number; username: string | null; image?: string }) => (
            <List.Item
              className="flex p-2 [&:nth-of-type(2n)]:bg-gray-0 dark:[&:nth-of-type(2n)]:bg-dark-8"
              classNames={{ itemLabel: 'w-full' }}
              key={user.id}
            >
              <Group justify="space-between">
                <UserAvatar
                  user={user}
                  includeAvatar={type !== 'blocked'}
                  withUsername
                  linkToProfile
                />
                {type === 'following' && <FollowUserButton userId={user.id} size="compact-sm" />}
                {type === 'followers' && <FollowUserButton userId={user.id} size="compact-sm" />}
                {type === 'hidden' && <HideUserButton userId={user.id} size="compact-sm" />}
                {type === 'blocked' && <BlockUserButton userId={user.id} size="compact-sm" />}
              </Group>
            </List.Item>
          ))}
        </List>
      ) : (
        <Paper p="xl" m={8} style={{ width: '100%' }} withBorder>
          <Center>
            <Text size="lg" fw="bold">
              {getEmptyMessage()}
            </Text>
          </Center>
        </Paper>
      )}

      {totalPages > 1 && (
        <Center mt="xl">
          <Pagination
            value={page}
            onChange={onPageChange}
            total={totalPages}
            siblings={1}
            boundaries={1}
          />
        </Center>
      )}
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

export default function UserLists() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const {
    list,
    username,
    page: pageQuery,
  } = router.query as {
    list: 'following' | 'followers' | 'hidden' | 'blocked';
    username: string;
    page?: string;
  };
  const page = pageQuery ? parseInt(pageQuery, 10) : 1;
  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const { data: countsData } = trpc.user.getLists.useQuery({ username });
  const { data: listData, isLoading: loadingList } = trpc.user.getList.useQuery({
    username,
    type: list,
    page,
    limit: LIST_LIMIT,
  });

  const handleTabChange = (value: string) => {
    router.push({ pathname: `/user/${username}/${value}`, query: {} });
  };

  const handlePageChange = (newPage: number) => {
    router.push(
      {
        pathname: `/user/${username}/${list}`,
        query: newPage > 1 ? { page: newPage } : {},
      },
      undefined,
      { shallow: true }
    );
  };

  if (!loadingList && !listData) return <FourOhFour />;

  return (
    <Container size="xs">
      <ContainerGrid2 gutter="xl">
        <ContainerGrid2.Col span={12}>
          <Group gap="xl">
            <Link legacyBehavior href={`/user/${username}`} passHref>
              <LegacyActionIcon component="a">
                <IconArrowLeft />
              </LegacyActionIcon>
            </Link>
            <Title order={1}>{`@${username}`}</Title>
          </Group>
        </ContainerGrid2.Col>
        <ContainerGrid2.Col span={12}>
          <Tabs value={list} onChange={(value) => value && handleTabChange(value)}>
            <Tabs.List grow>
              <Tabs.Tab value="following">{`Following (${abbreviateNumber(
                countsData?.followingCount ?? 0
              )})`}</Tabs.Tab>
              <Tabs.Tab value="followers">{`Followers (${abbreviateNumber(
                countsData?.followersCount ?? 0
              )})`}</Tabs.Tab>
              {isSameUser && (
                <>
                  <Tabs.Tab value="hidden">
                    {`Hidden (${abbreviateNumber(countsData?.hiddenCount ?? 0)})`}
                  </Tabs.Tab>
                  <Tabs.Tab value="blocked">
                    {`Blocked (${abbreviateNumber(countsData?.blockedCount ?? 0)})`}
                  </Tabs.Tab>
                </>
              )}
            </Tabs.List>

            <Tabs.Panel value={list}>
              {loadingList ? (
                <Center p="xl">
                  <Loader />
                </Center>
              ) : (
                <UserListContent
                  items={listData?.items ?? []}
                  type={list}
                  totalCount={listData?.totalItems ?? 0}
                  page={page}
                  onPageChange={handlePageChange}
                />
              )}
            </Tabs.Panel>
          </Tabs>
        </ContainerGrid2.Col>
      </ContainerGrid2>
    </Container>
  );
}
