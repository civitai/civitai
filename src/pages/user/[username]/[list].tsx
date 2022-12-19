import {
  ActionIcon,
  Anchor,
  Center,
  Container,
  createStyles,
  Grid,
  Group,
  List,
  Loader,
  Paper,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import FourOhFour from '~/pages/404';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  striped: {
    li: {
      display: 'flex',
      padding: theme.spacing.xs * 0.8, // 8px

      '&:nth-of-type(2n)': {
        backgroundColor:
          theme.colorScheme === 'dark'
            ? theme.fn.lighten(theme.colors.dark[7], 0.05)
            : theme.fn.darken(theme.colors.gray[0], 0.01),
      },
    },
  },
}));

export default function UserLists() {
  const { classes } = useStyles();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { list, username } = router.query as {
    list: 'following' | 'followers' | 'hidden';
    username: string;
  };
  const isSameUser = currentUser?.username === username;

  const { data, isLoading: loadingLists } = trpc.user.getLists.useQuery({ username });

  if (!loadingLists && !data) return <FourOhFour />;

  return (
    <Container size="xs">
      <Grid gutter="xl">
        <Grid.Col span={12}>
          <Group spacing="xl">
            <Link href={`/user/${username}`} passHref>
              <ActionIcon component="a">
                <IconArrowLeft />
              </ActionIcon>
            </Link>
            <Title order={1}>{`@${username}`}</Title>
          </Group>
        </Grid.Col>
        <Grid.Col span={12}>
          <Tabs
            defaultValue={list}
            onTabChange={(value) => router.push(`/user/${username}/${value}`)}
          >
            <Tabs.List grow>
              <Tabs.Tab value="following">{`Following (${abbreviateNumber(
                data?.followingCount ?? 0
              )})`}</Tabs.Tab>
              <Tabs.Tab value="followers">{`Followers (${abbreviateNumber(
                data?.followersCount ?? 0
              )})`}</Tabs.Tab>
              {isSameUser && (
                <Tabs.Tab value="hidden">{`Hidden (${abbreviateNumber(
                  data?.hiddenCount ?? 0
                )})`}</Tabs.Tab>
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
                    className={classes.striped}
                  >
                    {data.following.length > 0 ? (
                      data.following.map((user) => (
                        <List.Item key={user.id} p={8}>
                          <Link href={`/user/${user.username}`} passHref>
                            <Anchor variant="text">
                              <Group position="apart">
                                <UserAvatar user={user} withUsername />
                                <FollowUserButton userId={user.id} compact />
                              </Group>
                            </Anchor>
                          </Link>
                        </List.Item>
                      ))
                    ) : (
                      <List.Item>
                        <Paper p="xl" sx={{ width: '100%' }} withBorder>
                          <Center>
                            <Text size="lg" weight="bold">
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
                    className={classes.striped}
                  >
                    {data.followers.length > 0 ? (
                      data.followers.map((user) => (
                        <List.Item key={user.id} p={8}>
                          <Link href={`/user/${user.username}`} passHref>
                            <Anchor variant="text">
                              <Group position="apart">
                                <UserAvatar user={user} withUsername />
                                <FollowUserButton userId={user.id} compact />
                              </Group>
                            </Anchor>
                          </Link>
                        </List.Item>
                      ))
                    ) : (
                      <List.Item>
                        <Paper p="xl" sx={{ width: '100%' }} withBorder>
                          <Center>
                            <Text size="lg" weight="bold">
                              There are no followers to show
                            </Text>
                          </Center>
                        </Paper>
                      </List.Item>
                    )}
                  </List>
                </Tabs.Panel>
                {isSameUser && (
                  <Tabs.Panel value="hidden">
                    <List
                      listStyleType="none"
                      styles={{ itemWrapper: { width: '100%' } }}
                      className={classes.striped}
                    >
                      {data.hidden.length > 0 ? (
                        data.hidden.map((user) => (
                          <List.Item key={user.id} p={8}>
                            <Link href={`/user/${user.username}`} passHref>
                              <Anchor variant="text">
                                <Group position="apart">
                                  <UserAvatar user={user} withUsername />
                                  <HideUserButton userId={user.id} compact />
                                </Group>
                              </Anchor>
                            </Link>
                          </List.Item>
                        ))
                      ) : (
                        <List.Item>
                          <Paper p="xl" sx={{ width: '100%' }} withBorder>
                            <Center>
                              <Text size="lg" weight="bold">
                                There are no hidden users to show
                              </Text>
                            </Center>
                          </Paper>
                        </List.Item>
                      )}
                    </List>
                  </Tabs.Panel>
                )}
              </>
            )}
          </Tabs>
        </Grid.Col>
      </Grid>
    </Container>
  );
}
