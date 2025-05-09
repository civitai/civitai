import React, { useState } from 'react';
import { z } from 'zod';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { InferGetServerSidePropsType } from 'next';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { Meta } from '~/components/Meta/Meta';
import {
  Accordion,
  ActionIcon,
  ActionIconProps,
  Alert,
  Anchor,
  BadgeProps,
  Box,
  Button,
  Card,
  Center,
  CloseButton,
  createStyles,
  Group,
  Loader,
  MantineProvider,
  Menu,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useDidUpdate } from '@mantine/hooks';
import {
  IconBrandWechat,
  IconLock,
  IconLockOpen,
  IconNotes,
  IconPencilMinus,
  IconProps,
  IconShare3,
  IconStar,
  IconTrash,
  IconTrophy,
} from '@tabler/icons-react';
import { BountyEntryGetById } from '~/types/router';
import { BountyEntryDiscussion } from '~/components/Bounty/BountyEntryDiscussion';
import { formatKBytes } from '~/utils/number-helpers';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useRouter } from 'next/router';
import { AwardBountyAction } from '~/components/Bounty/AwardBountyAction';
import { openConfirmModal } from '@mantine/modals';
import { showErrorNotification } from '~/utils/notifications';
import { IconDotsVertical } from '@tabler/icons-react';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ReportEntity } from '~/server/schema/report.schema';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { formatDate } from '~/utils/date-helpers';
import { TrackView } from '~/components/TrackView/TrackView';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { env } from '~/env/client';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { Availability, ReviewReactions } from '~/shared/utils/prisma/enums';
import { ConnectProps, ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { CarouselIndicators } from '~/components/Carousel/CarouselIndicators';
import { ImageGenerationData } from '~/components/Image/DetailV2/ImageGenerationData';
import { NoContent } from '~/components/NoContent/NoContent';
import { openReportModal } from '~/components/Dialog/dialog-registry';
import { Notifications } from '@mantine/notifications';

const querySchema = z.object({
  id: z.coerce.number(),
  entryId: z.coerce.number(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.bounties) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.bounty.getById.prefetch({ id: result.data.id });
      await ssg.bountyEntry.getById.prefetch({ id: result.data.entryId });
      await ssg.hiddenPreferences.getHidden.prefetch();
    }

    return { props: removeEmpty(result.data) };
  },
});

const useStyles = createStyles((theme, _props, getRef) => {
  const isMobile = containerQuery.smallerThan('md');
  const isDesktop = containerQuery.largerThan('md');
  return {
    root: {
      width: '100vw',
      height: '100vh',
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',

      [isMobile]: {
        overflow: 'scroll',
      },
    },
    carousel: {
      flex: 1,
      alignItems: 'stretch',
    },
    active: { ref: getRef('active') },
    imageLoading: {
      opacity: '50%',
    },
    sidebar: {
      width: 457,
      borderRadius: 0,
      borderLeft: `1px solid ${theme.colors.dark[4]}`,
      display: 'flex',
      flexDirection: 'column',

      [isMobile]: {
        position: 'absolute',
        overflow: 'auto',
        top: '100%',
        left: 0,
        width: '100%',
        height: '100%',
        transition: '.3s ease transform',
        // transform: 'translateY(100%)',
        zIndex: 20,

        [`&.${getRef('active')}`]: {
          transform: 'translateY(-100%)',
        },
      },
    },
    mobileOnly: { [isDesktop]: { display: 'none' } },
    desktopOnly: { [isMobile]: { display: 'none' } },
    info: {
      position: 'absolute',
      bottom: theme.spacing.md,
      right: theme.spacing.md,
    },
    // Overwrite scrollArea generated styles
    scrollViewport: {
      '& > div': {
        minHeight: '100%',
        display: 'flex !important',
      },
    },
  };
});

export default function BountyEntryDetailsPage({
  id,
  entryId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { theme } = useStyles();
  const { data: bounty, isLoading: isLoadingBounty } = trpc.bounty.getById.useQuery({ id });
  const { data: bountyEntry, isLoading: isLoadingEntry } = trpc.bountyEntry.getById.useQuery({
    id: entryId,
  });
  const { data: files = [], isLoading: isLoadingFiles } = trpc.bountyEntry.getFiles.useQuery({
    id: entryId,
  });
  const queryUtils = trpc.useUtils();
  const [activeImage, setActiveImage] = useState<BountyEntryGetById['images'][number] | null>(
    bountyEntry?.images[0] || null
  );

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === (bountyEntry?.user?.id || bounty?.user?.id));

  const { mutate: deleteEntryMutation, isLoading: isLoadingDelete } =
    trpc.bountyEntry.delete.useMutation({
      onSuccess: async () => {
        await queryUtils.bounty.getEntries.invalidate({ id: bounty?.id });
        router.replace(`/bounties/${bounty?.id}`);
      },
      onError: (error) => {
        showErrorNotification({
          title: 'Could not delete entry',
          error: new Error(error.message),
        });
      },
    });
  const user = bountyEntry?.user;
  const currentUser = useCurrentUser();
  const benefactor = (bounty?.benefactors ?? []).find((b) => b.user.id === currentUser?.id);
  const isOwner = currentUser && user?.id === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;

  if (isLoadingBounty || isLoadingEntry || isLoadingDelete) {
    return <PageLoader />;
  }

  if (!bounty || !bountyEntry || isBlocked) {
    return <NotFound />;
  }

  const meta = (
    <Meta
      title={`Civitai | ${bounty?.name} | ${user?.username}`}
      images={bountyEntry?.images}
      description={bounty?.description}
      links={[
        {
          href: `${env.NEXT_PUBLIC_BASE_URL}/bounties/${bounty.id}/entries/${bountyEntry.id}`,
          rel: 'canonical',
        },
      ]}
      deIndex={bounty?.availability === Availability.Unsearchable}
    />
  );

  const filesCount = files?.length ?? 0;
  const reactions = bountyEntry?.reactions ?? [];
  const stats: {
    likeCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    cryCountAllTime: number;
    tippedAmountCountAllTime: number;
  } | null = bountyEntry?.stats ?? null;

  const navigateBackSection = (
    <div className="flex items-center justify-between">
      <Text size="xs" color="dimmed">
        Entry added on {formatDate(bountyEntry.createdAt)} by
      </Text>
      <NavigateBack url={`/bounties/${bounty.id}`}>
        {({ onClick }) => (
          <CloseButton
            size="md"
            radius="xl"
            variant="transparent"
            iconSize={20}
            onClick={onClick}
            ml="auto"
          />
        )}
      </NavigateBack>
    </div>
  );

  const userSection = user && (
    <div className="flex flex-col gap-3">
      <div className="hidden @md:block">{navigateBackSection}</div>
      <SmartCreatorCard user={user} />
    </div>
  );

  const awardSection = benefactor && benefactor.awardedToId === bountyEntry.id && (
    <Alert color="yellow" radius={0}>
      <Group gap="xs">
        <ThemeIcon
          // @ts-ignore: transparent variant does work
          variant="transparent"
          color="yellow.6"
        >
          <IconTrophy size={20} fill="currentColor" />
        </ThemeIcon>
        <Text>You awarded this entry</Text>
      </Group>
    </Alert>
  );

  const shareSection = (
    <Group gap={8} wrap="nowrap">
      {(isModerator || (isOwner && bountyEntry.awardedUnitAmountTotal === 0)) && (
        <Link
          legacyBehavior
          href={`/bounties/${bounty.id}/entries/${bountyEntry.id}/edit`}
          passHref
        >
          <Button
            radius="xl"
            color="gray"
            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            size="compact-md"
            fullWidth
            component="a"
          >
            <Group gap={4} wrap="nowrap">
              <IconPencilMinus size={14} />
              <Text size="xs">Edit</Text>
            </Group>
          </Button>
        </Link>
      )}
      {(isModerator || (isOwner && bountyEntry.awardedUnitAmountTotal === 0)) && (
        <Button
          radius="xl"
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          size="compact-md"
          fullWidth
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();

            openConfirmModal({
              title: 'Delete this entry?',
              children: (
                <Stack>
                  <Text size="sm">Are you sure you want to delete this entry?</Text>
                  <Text color="red.4" size="sm">
                    This action is not reversible. If you still want to participate in the hunt, you
                    will have to create a new submission.
                  </Text>
                </Stack>
              ),
              centered: true,
              labels: { confirm: 'Delete', cancel: 'Cancel' },
              confirmProps: { color: 'red' },
              onConfirm: () => {
                deleteEntryMutation({ id: bountyEntry.id });
              },
            });
          }}
        >
          <Group gap={4} wrap="nowrap">
            <IconTrash size={14} />
            <Text size="xs">Delete</Text>
          </Group>
        </Button>
      )}
      <AwardBountyAction
        bounty={bounty}
        bountyEntry={bountyEntry}
        fileUnlockAmount={bountyEntry.fileUnlockAmount}
      >
        {({ onClick, isLoading }) => (
          <Button
            disabled={isLoading}
            size="compact-md"
            radius="xl"
            color="gray"
            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            fullWidth
            onClick={onClick}
          >
            <Group gap={4} wrap="nowrap">
              <ThemeIcon
                // @ts-ignore: transparent variant does work
                variant="transparent"
                // @ts-ignore: overrides size to fit content
                size="auto"
                color="yellow.6"
              >
                <IconTrophy size={14} fill="currentColor" />
              </ThemeIcon>
              <Text size="xs">Award bounty</Text>
            </Group>
          </Button>
        )}
      </AwardBountyAction>
      <ShareButton url={router.asPath} title={bounty.name}>
        <Button
          size="compact-md"
          radius="xl"
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          fullWidth
        >
          <Group gap={4} wrap="nowrap">
            <IconShare3 size={14} />
            <Text size="xs">Share</Text>
          </Group>
        </Button>
      </ShareButton>
      {!isOwner && (
        <Menu>
          <Menu.Target>
            <ActionIcon
              radius="xl"
              color="gray"
              size="md"
              variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            >
              <IconDotsVertical size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <ReportMenuItem
              label="Report entry"
              onReport={() =>
                openReportModal({
                  entityType: ReportEntity.BountyEntry,
                  entityId: bountyEntry.id,
                })
              }
            />
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );

  const filesSection = (
    <Accordion
      variant="separated"
      multiple
      defaultValue={['files']}
      my={0}
      styles={(theme) => ({
        content: { padding: 0 },
        item: {
          overflow: 'hidden',
          borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
          boxShadow: theme.shadows.sm,
        },
        control: {
          padding: theme.spacing.sm,
        },
      })}
    >
      <Accordion.Item
        value="files"
        sx={(theme) => ({
          borderColor:
            !isLoadingFiles && !filesCount ? `${theme.colors.red[4]} !important` : undefined,
        })}
      >
        <Accordion.Control>
          <Group justify="space-between">
            {filesCount ? `${filesCount === 1 ? '1 File' : `${filesCount} Files`}` : 'Files'}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap={2}>
            {isLoadingFiles ? (
              <Center p="md">
                <Loader size="md" variant="bars" />
              </Center>
            ) : filesCount > 0 ? (
              <ScrollArea.Autosize maxHeight={300}>
                <SimpleGrid cols={1} gap={2}>
                  {files.map((file) => {
                    const isLocked = !file.url;
                    return (
                      <Paper key={file.id} radius={0} p={8} w="100%" bg="dark.4">
                        <Stack>
                          <Group justify="space-between" wrap="nowrap">
                            <Group wrap="nowrap">
                              {isLocked ? (
                                <Tooltip
                                  label="This file has not been unlocked yet"
                                  maw={200}
                                  multiline
                                  withArrow
                                  withinPortal
                                >
                                  <IconLock style={{ minWidth: '24px' }} />
                                </Tooltip>
                              ) : (
                                <IconLockOpen style={{ minWidth: '24px' }} />
                              )}
                              <Stack gap={0}>
                                {file.url && !isLocked ? (
                                  <Anchor
                                    href={`/api/download/attachments/${file.id}`}
                                    lineClamp={1}
                                    download
                                    size="sm"
                                  >
                                    {file.name}
                                  </Anchor>
                                ) : (
                                  <Text size="sm" weight={500} lineClamp={1}>
                                    {file.name}
                                  </Text>
                                )}
                                <Text color="dimmed" size="xs">
                                  {formatKBytes(file.sizeKB)}
                                </Text>
                              </Stack>
                            </Group>
                            <Group gap={0} wrap="nowrap">
                              {file.metadata.benefactorsOnly && (
                                <Tooltip
                                  label="Only users who award this entry will have access to this file"
                                  maw={200}
                                  multiline
                                  withArrow
                                  withinPortal
                                >
                                  <ThemeIcon color="yellow.6" radius="xl" size="sm" variant="light">
                                    <IconStar size={12} />
                                  </ThemeIcon>
                                </Tooltip>
                              )}
                              {/* TODO.bounty: bring this back once we allowing split bounties */}
                              {/* {(file.metadata.unlockAmount ?? 0) > 0 && (
                                <CurrencyBadge
                                  currency={file.metadata.currency ?? Currency.BUZZ}
                                  unitAmount={file.metadata.unlockAmount ?? 0}
                                />
                              )} */}
                            </Group>
                          </Group>
                        </Stack>
                      </Paper>
                    );
                  })}
                </SimpleGrid>
              </ScrollArea.Autosize>
            ) : (
              <Center p="xl">
                <Text size="md" color="dimmed">
                  No files were provided for this bounty
                </Text>
              </Center>
            )}
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );

  const notesSection = bountyEntry.description ? (
    <Card className="flex flex-col gap-3 rounded-xl">
      <Text className="flex items-center gap-2 text-xl font-semibold">
        <IconNotes />
        <span>Entry notes</span>
      </Text>
      <Card.Section pl="md" pb="md">
        <ScrollArea.Autosize maxHeight={200} offsetScrollbars>
          <RenderHtml html={bountyEntry.description} />
        </ScrollArea.Autosize>
      </Card.Section>
    </Card>
  ) : null;

  return (
    <>
      {meta}
      <TrackView
        entityId={bountyEntry.id}
        entityType="BountyEntry"
        type="BountyEntryView"
        details={{ bountyId: bountyEntry.bountyId }}
      />
      <div className="flex size-full flex-col overflow-y-auto bg-gray-2 @md:flex-row @md:overflow-y-hidden dark:bg-dark-9">
        <div className="flex w-full flex-col @md:flex-1">
          <div className="p-3 @md:hidden">{navigateBackSection}</div>
          <BountyEntryCarousel
            className="w-full overflow-hidden @max-md:aspect-square"
            onImageChange={setActiveImage}
            bountyEntry={bountyEntry}
            reactions={reactions}
            stats={stats}
          />
        </div>
        <div className="h-full  @md:w-[450px] @md:min-w-[450px] @md:overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">
            {userSection}
            {awardSection}
            {shareSection}
            {filesSection}
            {activeImage && (
              <VotableTags
                entityType="image"
                entityId={activeImage.id}
                nsfwLevel={activeImage.nsfwLevel}
                canAdd
                collapsible
              />
            )}
            {notesSection}
            {user?.id && (
              <Card className="flex flex-col gap-3 rounded-xl">
                <Text className="flex items-center gap-2 text-xl font-semibold">
                  <IconBrandWechat />
                  <span>Discussion</span>
                </Text>
                <BountyEntryDiscussion bountyEntryId={bountyEntry.id} userId={user.id} />
              </Card>
            )}
            {!!activeImage && <ImageGenerationData imageId={activeImage.id} />}
          </div>
        </div>
      </div>
    </>
  );
}

BountyEntryDetailsPage.getLayout = (page: React.ReactElement) => (
  <MantineProvider theme={{ colorScheme: 'dark' }} inherit>
    <Notifications />
    {page}
  </MantineProvider>
);

const sharedBadgeProps: Partial<Omit<BadgeProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 min-w-9 rounded-full normal-case',
  classNames: { inner: 'flex gap-1 items-center' },
};

const sharedActionIconProps: Partial<Omit<ActionIconProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 w-9 rounded-full',
};

const sharedIconProps: IconProps = {
  size: 18,
  stroke: 2,
  color: 'white',
};

export function BountyEntryCarousel({
  bountyEntry,
  className,
  onImageChange,
  reactions,
  stats,
}: {
  bountyEntry: BountyEntryGetById;
  className: string;
  onImageChange?: (image: BountyEntryGetById['images'][number]) => void;
  reactions: {
    userId: number;
    reaction: ReviewReactions;
  }[];
  stats: {
    likeCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    cryCountAllTime: number;
    tippedAmountCountAllTime: number;
  } | null;
}) {
  const { images } = bountyEntry;
  const { classes } = useCarrouselStyles();
  const queryUtils = trpc.useUtils();

  const carouselNavigation = useCarouselNavigation({ items: images, onChange: onImageChange });

  const isDeletingImage = !!useIsMutating(getQueryKey(trpc.image.delete));
  useDidUpdate(() => {
    if (!isDeletingImage) queryUtils.bountyEntry.getById.invalidate({ id: bountyEntry?.id });
  }, [isDeletingImage]);

  if (images.length === 0) {
    return (
      <Center h="100%">
        <NoContent message="This entry has no images" />
      </Center>
    );
  }

  const image = images[carouselNavigation.index];

  const connect: ConnectProps = {
    connectType: 'bountyEntry',
    connectId: bountyEntry.id,
  };

  return (
    <div className={`relative flex flex-1 flex-col ${className ? className : ''}`}>
      <ImageGuard2 image={image} {...connect} explain={false}>
        {() => (
          <>
            <div className="absolute inset-x-0 top-0 z-10 flex justify-between p-3">
              <ImageGuard2.BlurToggle {...sharedBadgeProps} />
              <ImageContextMenu image={image}>
                <ActionIcon {...sharedActionIconProps}>
                  <IconDotsVertical {...sharedIconProps} />
                </ActionIcon>
              </ImageContextMenu>
            </div>
            <ImageDetailCarousel images={images} connect={connect} {...carouselNavigation} />
            <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 p-3">
              <div className="flex justify-center">
                <Reactions
                  entityId={bountyEntry.id}
                  entityType="bountyEntry"
                  reactions={reactions}
                  metrics={{
                    likeCount: stats?.likeCountAllTime,
                    dislikeCount: stats?.dislikeCountAllTime,
                    heartCount: stats?.heartCountAllTime,
                    laughCount: stats?.laughCountAllTime,
                    cryCount: stats?.cryCountAllTime,
                    tippedAmountCount: stats?.tippedAmountCountAllTime,
                  }}
                  targetUserId={bountyEntry.user?.id}
                />
              </div>
              <CarouselIndicators {...carouselNavigation} />
            </div>
          </>
        )}
      </ImageGuard2>
      {isDeletingImage && (
        <Box className={classes.loader}>
          <Center>
            <Loader />
          </Center>
        </Box>
      )}
    </div>
  );
}

const useCarrouselStyles = createStyles((theme, _props, getRef) => {
  return {
    root: {
      position: 'relative',
    },
    loader: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%,-50%)',
      zIndex: 1,
    },
    imageLoading: {
      pointerEvents: 'none',
      opacity: 0.5,
    },
    center: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    },

    prev: { ref: getRef('prev') },
    next: { ref: getRef('next') },
    control: {
      position: 'absolute',
      // top: 0,
      // bottom: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 10,

      svg: {
        height: 50,
        width: 50,
      },

      [`&.${getRef('prev')}`]: {
        left: 0,
      },
      [`&.${getRef('next')}`]: {
        right: 0,
      },

      '&:hover': {
        color: theme.colors.blue[3],
      },
    },
    indicators: {
      position: 'absolute',
      bottom: theme.spacing.md,
      top: undefined,
      left: 0,
      right: 0,
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
      pointerEvents: 'none',
    },

    indicator: {
      pointerEvents: 'all',
      width: 25,
      height: 5,
      borderRadius: 10000,
      backgroundColor: theme.white,
      boxShadow: theme.shadows.sm,
      opacity: 0.6,
      transition: `opacity 150ms ${theme.transitionTimingFunction}`,

      '&[data-active]': {
        opacity: 1,
      },
    },
  };
});
