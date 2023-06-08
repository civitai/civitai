import {
  ActionIcon,
  AspectRatio,
  Box,
  Card,
  Center,
  Chip,
  Container,
  Group,
  Loader,
  Menu,
  Rating,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Stack,
  Tabs,
  Text,
  Title,
  createStyles,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { MetricTimeframe, ReviewReactions } from '@prisma/client';
import {
  IconAlbum,
  IconArrowBackUp,
  IconBan,
  IconBox,
  IconDotsVertical,
  IconDownload,
  IconHeart,
  IconMicrophone,
  IconMicrophoneOff,
  IconNotebook,
  IconPhoto,
  IconStar,
  IconTrash,
  IconUpload,
  IconUsers,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CivitaiTabs } from '~/components/CivitaiWrapped/CivitaiTabs';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber, formatToLeastDecimals, numberWithCommas } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { StatTooltip } from '~/components/Tooltips/StatTooltip';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const { username, id } = userPageQuerySchema.parse(ctx.params);
    if (id || username) await ssg?.user.getCreator.prefetch({ username });

    return {
      props: removeEmpty({
        id,
        username,
      }),
    };
  },
});

const segments = [
  { label: 'My Images', value: 'images' },
  { label: 'My Reactions', value: 'reactions' },
] as const;
type Segment = (typeof segments)[number]['value'];

const availableReactions = Object.keys(constants.availableReactions) as ReviewReactions[];

const useChipStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 500,
    padding: `0 ${theme.spacing.xs * 0.75}px`,

    '&[data-variant="filled"]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

      '&[data-checked]': {
        backgroundColor:
          theme.colorScheme === 'dark'
            ? theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.5)
            : theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.2),
      },
    },

    [theme.fn.smallerThan('xs')]: {
      padding: `4px ${theme.spacing.sm}px !important`,
      fontSize: 18,
      height: 'auto',

      '&[data-checked]': {
        padding: `4px ${theme.spacing.sm}px`,
      },
    },
  },

  iconWrapper: {
    display: 'none',
  },

  chipGroup: {
    [theme.fn.smallerThan('xs')]: {
      width: '100%',
    },
  },
}));

export function UserImagesPage() {
  const currentUser = useCurrentUser();
  const { classes } = useChipStyles();

  const {
    replace,
    query: {
      period = MetricTimeframe.AllTime,
      sort = ImageSort.Newest,
      username = '',
      reactions,
      ...query
    },
  } = useImageQueryParams();

  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const section = isSameUser ? query.section ?? 'images' : 'images';

  const viewingReactions = section === 'reactions';

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Tabs.Panel value="/images">
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Group spacing={8}>
              {isSameUser && (
                <ContentToggle
                  size="xs"
                  value={section}
                  onChange={(section) => replace({ section })}
                />
              )}
              {viewingReactions && (
                <Chip.Group
                  spacing={4}
                  value={reactions ?? []}
                  onChange={(reactions: ReviewReactions[]) => replace({ reactions })}
                  className={classes.chipGroup}
                  multiple
                  noWrap
                >
                  {availableReactions.map((reaction, index) => (
                    <Chip
                      key={index}
                      value={reaction}
                      classNames={classes}
                      variant="filled"
                      radius="sm"
                      size="xs"
                    >
                      {constants.availableReactions[reaction as ReviewReactions]}
                    </Chip>
                  ))}
                </Chip.Group>
              )}
              <SortFilter
                type="images"
                value={sort}
                onChange={(x) => replace({ sort: x as ImageSort })}
              />
              <Box ml="auto">
                <PeriodFilter
                  type="images"
                  value={period}
                  onChange={(x) => replace({ period: x })}
                />
              </Box>
            </Group>
            <ImagesInfinite
              filters={{
                ...query,
                period,
                sort,
                reactions: viewingReactions ? reactions ?? availableReactions : undefined,
                username: viewingReactions ? undefined : username,
              }}
              withTags={!viewingReactions && (currentUser?.isModerator || isSameUser)}
            />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Tabs.Panel>
  );
}

function ContentToggle({
  value,
  onChange,
  ...props
}: Omit<SegmentedControlProps, 'value' | 'onChange' | 'data'> & {
  value: Segment;
  onChange: (value: Segment) => void;
}) {
  return (
    <SegmentedControl
      {...props}
      value={value}
      onChange={onChange}
      data={segments as unknown as SegmentedControlItem[]}
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

function NestedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { username } = router.query as { username: string };
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const queryUtils = trpc.useContext();
  const features = useFeatureFlags();

  const { data: user, isLoading: userLoading } = trpc.user.getCreator.useQuery({ username });

  const { models: uploads } = user?._count ?? { models: 0 };
  const stats = user?.stats;
  const isMod = currentUser && currentUser.isModerator;
  const isSameUser =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const removeContentMutation = trpc.user.removeAllContent.useMutation({
    onSuccess() {
      invalidateModeratedContent(queryUtils);
    },
  });
  const toggleMuteMutation = trpc.user.toggleMute.useMutation({
    async onMutate() {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser
          ? {
              ...prevUser,
              muted: !prevUser.muted,
            }
          : undefined
      );

      return { prevUser };
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to mute user, please try again.'),
      });
    },
  });
  const handleToggleMute = () => {
    if (user) toggleMuteMutation.mutate({ id: user.id });
  };
  const toggleBanMutation = trpc.user.toggleBan.useMutation({
    async onMutate() {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser
          ? {
              ...prevUser,
              bannedAt: prevUser.bannedAt ? null : new Date(),
            }
          : undefined
      );

      return { prevUser };
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to ban user, please try again.'),
      });
    },
  });
  const handleToggleBan = () => {
    if (user) {
      if (user.bannedAt) toggleBanMutation.mutate({ id: user.id });
      else
        openConfirmModal({
          title: 'Ban User',
          children: `Are you sure you want to ban this user? Once a user is banned, they won't be able to access the app again.`,
          labels: { confirm: 'Yes, ban the user', cancel: 'Cancel' },
          confirmProps: { color: 'red' },
          onConfirm: () => toggleBanMutation.mutate({ id: user.id }),
        });
    }
  };
  const handleRemoveContent = () => {
    if (!user) return;
    openConfirmModal({
      title: 'Remove All Content',
      children: `Are you sure you want to remove all content (models, reviews, comments, posts, and images) by this user? This action cannot be undone.`,
      labels: { confirm: 'Yes, remove all content', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => removeContentMutation.mutate({ id: user.id }),
    });
  };

  // Redirect all users to the creator's models tab if they have uploaded models
  useEffect(() => {
    if (router.pathname !== '/user/[username]') return;
    if (uploads > 0) router.replace(`/user/${username}/models`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads, username]);

  if (userLoading && !user)
    return (
      <Container>
        <Center p="xl">
          <Loader size="lg" />
        </Center>
      </Container>
    );
  if (!userLoading && !user) return <NotFound />;

  const activeTab = router.pathname.split('/[username]').pop()?.split('?').at(0) || '/images';

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
      {user && <TrackView entityId={user.id} entityType="User" type="ProfileView" />}
      <CivitaiTabs
        value={activeTab}
        onTabChange={(value) => router.push(`/user/${username}${value}`)}
      >
        {user && (
          <>
            <Box className={classes.banner} mb="md">
              <Container size="xl">
                <Stack className={classes.wrapper} spacing="md" align="center">
                  {user.image && (
                    <div className={classes.outsideImage}>
                      <AspectRatio ratio={1 / 1} className={classes.image}>
                        <EdgeImage
                          src={user.image}
                          name={user.username}
                          width={128}
                          alt={user.username ?? ''}
                        />
                      </AspectRatio>
                    </div>
                  )}
                  <Card radius="sm" className={classes.card} withBorder shadow="sm">
                    <Group noWrap>
                      {user.image && (
                        <div className={classes.insideImage}>
                          <AspectRatio ratio={1 / 1} className={classes.image}>
                            <EdgeImage
                              src={user.image}
                              name={user.username}
                              width={128}
                              alt={user.username ?? ''}
                            />
                          </AspectRatio>
                        </div>
                      )}
                      <Stack spacing="xs">
                        <Group position="apart">
                          <Title order={2}>
                            <Username {...user} inherit />
                          </Title>
                          <Group spacing={4} noWrap>
                            <FollowUserButton userId={user.id} size="md" compact />

                            {(isMod || isSameUser) && (
                              <Menu position="left" withinPortal>
                                <Menu.Target>
                                  <ActionIcon loading={removeContentMutation.isLoading}>
                                    <IconDotsVertical />
                                  </ActionIcon>
                                </Menu.Target>
                                <Menu.Dropdown>
                                  <>
                                    {isMod && (
                                      <>
                                        <Menu.Item
                                          color={user.bannedAt ? 'green' : 'red'}
                                          icon={
                                            !user.bannedAt ? (
                                              <IconBan size={14} stroke={1.5} />
                                            ) : (
                                              <IconArrowBackUp size={14} stroke={1.5} />
                                            )
                                          }
                                          onClick={handleToggleBan}
                                        >
                                          {user.bannedAt ? 'Restore user' : 'Ban user'}
                                        </Menu.Item>
                                        <Menu.Item
                                          color="red"
                                          icon={<IconTrash size={14} stroke={1.5} />}
                                          onClick={handleRemoveContent}
                                        >
                                          Remove all content
                                        </Menu.Item>
                                        <Menu.Item
                                          icon={
                                            user.muted ? (
                                              <IconMicrophone size={14} stroke={1.5} />
                                            ) : (
                                              <IconMicrophoneOff size={14} stroke={1.5} />
                                            )
                                          }
                                          onClick={handleToggleMute}
                                        >
                                          {user.muted ? 'Unmute user' : 'Mute user'}
                                        </Menu.Item>
                                      </>
                                    )}
                                    {isSameUser && (
                                      <Menu.Item
                                        component={NextLink}
                                        href={`/user/${user.username}/manage-categories`}
                                      >
                                        Manage model categories
                                      </Menu.Item>
                                    )}
                                  </>
                                </Menu.Dropdown>
                              </Menu>
                            )}
                          </Group>
                        </Group>
                        <Group spacing="xs">
                          <RankBadge rank={user.rank} size="lg" />
                          {stats && (
                            <>
                              <IconBadge
                                tooltip={
                                  <StatTooltip
                                    label="Average Rating"
                                    value={`${formatToLeastDecimals(stats.ratingAllTime)} (${
                                      stats.ratingCountAllTime
                                    })`}
                                  />
                                }
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
                              {uploads === 0 ? null : (
                                <IconBadge
                                  icon={<IconUpload size={16} />}
                                  color="gray"
                                  size="lg"
                                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                                  tooltip={<StatTooltip label="Uploads" value={uploads} />}
                                >
                                  <Text size="sm">{abbreviateNumber(uploads)}</Text>
                                </IconBadge>
                              )}
                              <IconBadge
                                icon={<IconUsers size={16} />}
                                href={`/user/${user.username}/followers`}
                                color="gray"
                                size="lg"
                                variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                                tooltip={
                                  <StatTooltip
                                    label="Followers"
                                    value={stats.followerCountAllTime}
                                  />
                                }
                              >
                                <Text size="sm">
                                  {abbreviateNumber(stats.followerCountAllTime)}
                                </Text>
                              </IconBadge>
                              <IconBadge
                                tooltip={
                                  <StatTooltip
                                    label="Favorites"
                                    value={stats.favoriteCountAllTime}
                                  />
                                }
                                icon={<IconHeart size={16} />}
                                color="gray"
                                variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                                size="lg"
                              >
                                <Text size="sm">
                                  {abbreviateNumber(stats.favoriteCountAllTime)}
                                </Text>
                              </IconBadge>
                              <IconBadge
                                tooltip={
                                  <StatTooltip
                                    label="Downloads"
                                    value={stats.downloadCountAllTime}
                                  />
                                }
                                icon={<IconDownload size={16} />}
                                variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                                size="lg"
                              >
                                <Text size="sm">
                                  {abbreviateNumber(stats.downloadCountAllTime)}
                                </Text>
                              </IconBadge>
                            </>
                          )}
                        </Group>
                        {!!user.links?.length && (
                          <Group spacing={0}>
                            {sortDomainLinks(user.links).map((link, index) => (
                              <ActionIcon
                                key={index}
                                component="a"
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
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
                  <Tabs.List position="center">
                    <Tabs.Tab value="/images" icon={<IconPhoto size="1rem" />}>
                      Images
                    </Tabs.Tab>
                    <Tabs.Tab value="/posts" icon={<IconAlbum size="1rem" />}>
                      Posts
                    </Tabs.Tab>
                    <Tabs.Tab value="/models" icon={<IconBox size="1rem" />}>
                      Models
                    </Tabs.Tab>
                    {features.articles && (
                      <Tabs.Tab value="/articles" icon={<IconNotebook size="1rem" />}>
                        Articles
                      </Tabs.Tab>
                    )}
                  </Tabs.List>
                </Stack>
              </Container>
            </Box>
            {children}
          </>
        )}
      </CivitaiTabs>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  banner: {
    position: 'relative',
    marginTop: `-${theme.spacing.md}px`,
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.md,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      paddingTop: theme.spacing.md,
    },
  },
  image: {
    width: '128px',
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  wrapper: {
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

export const UserProfileLayout = (page: React.ReactElement) => (
  <AppLayout>
    <NestedLayout>{page}</NestedLayout>
  </AppLayout>
);

UserImagesPage.getLayout = UserProfileLayout;

export default UserImagesPage;
