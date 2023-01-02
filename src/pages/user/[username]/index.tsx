import {
  Container,
  Title,
  Text,
  Stack,
  Group,
  Box,
  createStyles,
  ActionIcon,
  AspectRatio,
  Rating,
  useMantineTheme,
  Card,
} from '@mantine/core';
import { IconDownload, IconHeart, IconStar, IconUpload, IconUsers } from '@tabler/icons';
import { useRouter } from 'next/router';
import { GetServerSideProps } from 'next/types';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { EdgeImage, getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsSort,
  InfiniteModelsPeriod,
  InfiniteModelsFilter,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { Meta } from '~/components/Meta/Meta';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const ssg = await getServerProxySSGHelpers(ctx);
  const username = ctx.query.username as string;
  if (username) await ssg.user.getCreator.prefetch({ username });

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

export default function UserPage() {
  const router = useRouter();
  const theme = useMantineTheme();
  const username = router.query.username as string;
  const { classes } = useStyles();

  const { data: user } = trpc.user.getCreator.useQuery({ username });

  const { models: uploads } = user?._count ?? { models: 0 };
  const stats = user?.stats;

  return (
    <>
      {user && stats ? (
        <Meta
          title={`${user.username} Creator Profile | Civitai`}
          description={`Average Rating: ${stats.ratingAllTime.toFixed(1)} (${abbreviateNumber(
            stats.ratingCountAllTime
          )}), Models Uploaded: ${abbreviateNumber(uploads)}, Followers: ${abbreviateNumber(
            stats.followerCountAllTime
          )}, Total Likes Received: ${abbreviateNumber(
            stats.favoriteCountAllTime
          )}, Total Downloads Received: ${abbreviateNumber(stats.downloadCountAllTime)}. `}
          image={!user.image ? undefined : getEdgeUrl(user.image, { width: 1200 })}
        />
      ) : (
        <Meta
          title={`Creator Profile | Civitai`}
          description="Learn more about this awesome creator on Civitai."
        />
      )}
      {user && (
        <Box className={classes.banner} mb="md">
          <Container size="xl">
            <Stack className={classes.wrapper}>
              {user.image && (
                <div className={classes.outsideImage}>
                  <AspectRatio ratio={1 / 1} className={classes.image}>
                    <EdgeImage src={user.image} width={128} alt={user.username ?? ''} />
                  </AspectRatio>
                </div>
              )}
              <Card radius="sm" className={classes.card}>
                <Group noWrap>
                  {user.image && (
                    <div className={classes.insideImage}>
                      <AspectRatio ratio={1 / 1} className={classes.image}>
                        <EdgeImage src={user.image} width={128} alt={user.username ?? ''} />
                      </AspectRatio>
                    </div>
                  )}
                  <Stack spacing="xs">
                    <Group position="apart">
                      <Title order={2}>{user.username}</Title>
                      <FollowUserButton userId={user.id} size="md" compact />
                    </Group>
                    {stats && (
                      <Group spacing="xs">
                        <IconBadge
                          tooltip="Average Rating"
                          sx={{ userSelect: 'none' }}
                          size="lg"
                          icon={
                            <Rating
                              size="sm"
                              value={stats.ratingAllTime}
                              readOnly
                              emptySymbol={
                                theme.colorScheme === 'dark' ? (
                                  <IconStar
                                    size={18}
                                    fill="rgba(255,255,255,.3)"
                                    color="transparent"
                                  />
                                ) : undefined
                              }
                            />
                          }
                          variant={
                            theme.colorScheme === 'dark' && stats.ratingCountAllTime > 0
                              ? 'filled'
                              : 'light'
                          }
                        >
                          <Text
                            size="sm"
                            color={stats.ratingCountAllTime > 0 ? undefined : 'dimmed'}
                          >
                            {abbreviateNumber(stats.ratingCountAllTime)}
                          </Text>
                        </IconBadge>
                        <IconBadge
                          tooltip="Uploads"
                          icon={<IconUpload size={16} />}
                          color="gray"
                          size="lg"
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                        >
                          <Text size="sm">{abbreviateNumber(uploads)}</Text>
                        </IconBadge>
                        <IconBadge
                          tooltip="Followers"
                          icon={<IconUsers size={16} />}
                          href={`${user.username}/followers`}
                          color="gray"
                          size="lg"
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                        >
                          <Text size="sm">{abbreviateNumber(stats.followerCountAllTime)}</Text>
                        </IconBadge>
                        <IconBadge
                          tooltip="Favorites"
                          icon={<IconHeart size={16} />}
                          color="gray"
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                          size="lg"
                        >
                          <Text size="sm">{abbreviateNumber(stats.favoriteCountAllTime)}</Text>
                        </IconBadge>
                        <IconBadge
                          tooltip="Downloads"
                          icon={<IconDownload size={16} />}
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                          size="lg"
                        >
                          <Text size="sm">{abbreviateNumber(stats.downloadCountAllTime)}</Text>
                        </IconBadge>
                      </Group>
                    )}
                    {!!user.links?.length && (
                      <Group spacing={0}>
                        {sortDomainLinks(user.links)?.map((link, index) => (
                          <ActionIcon
                            key={index}
                            component="a"
                            href={link.url}
                            target="_blank"
                            size="md"
                          >
                            <DomainIcon domain={link.domain} size={22} />
                          </ActionIcon>
                        ))}
                      </Group>
                    )}
                  </Stack>
                </Group>
              </Card>
            </Stack>
          </Container>
        </Box>
      )}
      <Container size="xl">
        <Stack spacing="xs">
          <Group position="apart">
            <InfiniteModelsSort />
            <Group spacing="xs">
              <InfiniteModelsPeriod />
              <InfiniteModelsFilter />
            </Group>
          </Group>
          <InfiniteModels showHidden />
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  banner: {
    marginTop: `-${theme.spacing.md}px`,
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.xl * 2,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.md,
    },
  },
  image: {
    width: '128px',
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  wrapper: {
    alignItems: 'flex-start',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      alignItems: 'center',
    },
  },
  outsideImage: {
    display: 'none',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'block',
    },
  },
  insideImage: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'none',
    },
  },
  card: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      width: '100%',
    },
  },
}));
