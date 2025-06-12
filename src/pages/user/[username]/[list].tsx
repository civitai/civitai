import {
  ActionIcon,
  Anchor,
  Center,
  Container,
  Group,
  List,
  Loader,
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
import styles from './[list].module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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
  const { list, username } = router.query as {
    list: 'following' | 'followers' | 'hidden';
    username: string;
  };
  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const { data, isLoading: loadingLists } = trpc.user.getLists.useQuery({ username });

  if (!loadingLists && !data) return <FourOhFour />;

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
          <Tabs value={list} onChange={(value) => router.push(`/user/${username}/${value}`)}>
            <Tabs.List grow>
              <Tabs.Tab value="following">{`Following (${abbreviateNumber(
                data?.followingCount ?? 0
              )})`}</Tabs.Tab>
              <Tabs.Tab value="followers">{`Followers (${abbreviateNumber(
                data?.followersCount ?? 0
              )})`}</Tabs.Tab>
              {isSameUser && (
                <>
                  <Tabs.Tab value="hidden">
                    {`Hidden (${abbreviateNumber(data?.hiddenCount ?? 0)})`}
                  </Tabs.Tab>
                  <Tabs.Tab value="blocked">
                    {`Blocked (${abbreviateNumber(data?.blockedCount ?? 0)})`}
                  </Tabs.Tab>
                </>
              )}
            </Tabs.List>
            {loadingLists && !data ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : (
              <>
                <Tabs.Panel value="following">
                  <List
                    listStyleType="none"
                    styles={{ itemWrapper: { width: '100%' } }}
                    className={styles.striped}
                  >
                    {data.following.length > 0 ? (
                      data.following.map((user) => (
                        <List.Item key={user.id} p={8}>
                          <Link legacyBehavior href={`/user/${user.username}`} passHref>
                            <Anchor variant="text">
                              <Group justify="space-between">
                                <UserAvatar user={user} withUsername />
                                <FollowUserButton userId={user.id} size="compact-sm" />
                              </Group>
                            </Anchor>
                          </Link>
                        </List.Item>
                      ))
                    ) : (
                      <List.Item>
                        <Paper p="xl" style={{ width: '100%' }} withBorder>
                          <Center>
                            <Text size="lg" fw="bold">
                              There are no following to show
                            </Text>
                          </Center>
                        </Paper>
                      </List.Item>
                    )}
                  </List>
                </Tabs.Panel>
                <Tabs.Panel value="followers">
                  <List
                    listStyleType="none"
                    styles={{ itemWrapper: { width: '100%' } }}
                    className={styles.striped}
                  >
                    {data.followers.length > 0 ? (
                      data.followers.map((user) => (
                        <List.Item key={user.id} p={8}>
                          <Link legacyBehavior href={`/user/${user.username}`} passHref>
                            <Anchor variant="text">
                              <Group justify="space-between">
                                <UserAvatar user={user} withUsername />
                                <FollowUserButton userId={user.id} size="compact-sm" />
                              </Group>
                            </Anchor>
                          </Link>
                        </List.Item>
                      ))
                    ) : (
                      <List.Item>
                        <Paper p="xl" style={{ width: '100%' }} withBorder>
                          <Center>
                            <Text size="lg" fw="bold">
                              There are no followers to show
                            </Text>
                          </Center>
                        </Paper>
                      </List.Item>
                    )}
                  </List>
                </Tabs.Panel>
                {isSameUser && (
                  <>
                    <Tabs.Panel value="hidden">
                      <List
                        listStyleType="none"
                        styles={{ itemWrapper: { width: '100%' } }}
                        className={styles.striped}
                      >
                        {data.hidden.length > 0 ? (
                          data.hidden.map((user) => (
                            <List.Item key={user.id} p={8}>
                              <Link legacyBehavior href={`/user/${user.username}`} passHref>
                                <Anchor variant="text">
                                  <Group justify="space-between">
                                    <UserAvatar user={user} withUsername />
                                    <HideUserButton userId={user.id} size="compact-sm" />
                                  </Group>
                                </Anchor>
                              </Link>
                            </List.Item>
                          ))
                        ) : (
                          <List.Item>
                            <Paper p="xl" style={{ width: '100%' }} withBorder>
                              <Center>
                                <Text size="lg" fw="bold">
                                  There are no hidden users to show
                                </Text>
                              </Center>
                            </Paper>
                          </List.Item>
                        )}
                      </List>
                    </Tabs.Panel>
                    <Tabs.Panel value="blocked">
                      <List
                        listStyleType="none"
                        styles={{ itemWrapper: { width: '100%' } }}
                        className={styles.striped}
                      >
                        {data.blocked.length > 0 ? (
                          data.blocked.map((user) => (
                            <List.Item key={user.id} p={8}>
                              <Link legacyBehavior href={`/user/${user.username}`} passHref>
                                <Anchor variant="text">
                                  <Group justify="space-between">
                                    <Text>{user.username}</Text>
                                    <BlockUserButton userId={user.id} size="compact-sm" />
                                  </Group>
                                </Anchor>
                              </Link>
                            </List.Item>
                          ))
                        ) : (
                          <List.Item>
                            <Paper p="xl" style={{ width: '100%' }} withBorder>
                              <Center>
                                <Text size="lg" fw="bold">
                                  There are no blocked users to show
                                </Text>
                              </Center>
                            </Paper>
                          </List.Item>
                        )}
                      </List>
                    </Tabs.Panel>
                  </>
                )}
              </>
            )}
          </Tabs>
        </ContainerGrid2.Col>
      </ContainerGrid2>
    </Container>
  );
}
