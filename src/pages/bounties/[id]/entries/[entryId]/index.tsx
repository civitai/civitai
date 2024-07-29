import React, { useEffect, useState } from 'react';
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
  Divider,
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
  UnstyledButton,
} from '@mantine/core';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ImageCarousel } from '~/components/Bounty/ImageCarousel';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useDidUpdate, useHotkeys } from '@mantine/hooks';
import {
  IconChevronLeft,
  IconChevronRight,
  IconInfoCircle,
  IconLock,
  IconLockOpen,
  IconPencilMinus,
  IconProps,
  IconShare3,
  IconStar,
  IconTrash,
  IconTrophy,
} from '@tabler/icons-react';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
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
import { openContext } from '~/providers/CustomModalsProvider';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { formatDate } from '~/utils/date-helpers';
import { TrackView } from '~/components/TrackView/TrackView';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { env } from '~/env/client.mjs';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import Link from 'next/link';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { Availability } from '@prisma/client';
import { ConnectProps, ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { CarouselIndicators } from '~/components/Carousel/CarouselIndicators';
import { ImageGenerationData } from '~/components/Image/DetailV2/ImageGenerationData';

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
  const { classes, theme } = useStyles();
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
  const mobile = useContainerSmallerThan('md');
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

  const userSection = (
    <>
      {user && (
        <Card.Section px={mobile ? 'xs' : 'md'} py="sm" withBorder>
          <Stack spacing={8}>
            <Group position="apart">
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
            </Group>
            <SmartCreatorCard user={user} />
          </Stack>
        </Card.Section>
      )}
    </>
  );

  const awardSection = (
    <>
      {benefactor && benefactor.awardedToId === bountyEntry.id && (
        <Alert color="yellow" radius={0}>
          <Group spacing="xs">
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
      )}
    </>
  );

  const shareSection = (
    <Group spacing={8} px={mobile ? 'xs' : 'md'} noWrap>
      {(isModerator || (isOwner && bountyEntry.awardedUnitAmountTotal === 0)) && (
        <Link href={`/bounties/${bounty.id}/entries/${bountyEntry.id}/edit`} passHref>
          <Button
            size="md"
            radius="xl"
            color="gray"
            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            compact
            fullWidth
            component="a"
          >
            <Group spacing={4} noWrap>
              <IconPencilMinus size={14} />
              <Text size="xs">Edit</Text>
            </Group>
          </Button>
        </Link>
      )}
      {(isModerator || (isOwner && bountyEntry.awardedUnitAmountTotal === 0)) && (
        <Button
          size="md"
          radius="xl"
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          compact
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
              onConfirm: () => {
                deleteEntryMutation({ id: bountyEntry.id });
              },
            });
          }}
        >
          <Group spacing={4} noWrap>
            <IconTrash size={14} />
            <Text size="xs">Delete</Text>
          </Group>
        </Button>
      )}
      <AwardBountyAction
        bounty={bounty}
        bountyEntryId={bountyEntry.id || entryId}
        fileUnlockAmount={bountyEntry.fileUnlockAmount}
      >
        {({ onClick, isLoading }) => (
          <Button
            disabled={isLoading}
            size="md"
            radius="xl"
            color="gray"
            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
            compact
            fullWidth
            onClick={onClick}
          >
            <Group spacing={4} noWrap>
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
          size="md"
          radius="xl"
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
          compact
          fullWidth
        >
          <Group spacing={4} noWrap>
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
                openContext('report', {
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
      px={mobile ? 'xs' : 'md'}
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
          <Group position="apart">
            {filesCount ? `${filesCount === 1 ? '1 File' : `${filesCount} Files`}` : 'Files'}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack spacing={2}>
            {isLoadingFiles ? (
              <Center p="md">
                <Loader size="md" variant="bars" />
              </Center>
            ) : filesCount > 0 ? (
              <ScrollArea.Autosize maxHeight={300}>
                <SimpleGrid cols={1} spacing={2}>
                  {files.map((file) => {
                    const isLocked = !file.url;
                    return (
                      <Paper key={file.id} radius={0} p={8} w="100%" bg="dark.4">
                        <Stack>
                          <Group position="apart" noWrap>
                            <Group noWrap>
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
                              <Stack spacing={0}>
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
                            <Group spacing={0} noWrap>
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
    <>
      <Divider label="Entry Notes" labelPosition="center" />
      <Paper
        component={ScrollArea}
        radius="md"
        p="xs"
        mx={mobile ? 'xs' : 'md'}
        h={200}
        offsetScrollbars
        withBorder={mobile}
      >
        <RenderHtml html={bountyEntry.description} />
      </Paper>
    </>
  ) : null;

  if (mobile) {
    return (
      <>
        {meta}
        <TrackView
          entityId={bountyEntry.id}
          entityType="BountyEntry"
          type="BountyEntryView"
          details={{ bountyId: bountyEntry.bountyId }}
        />
        <Paper className={classes.root}>
          <Stack w="100%">
            {userSection}
            <Stack pb="lg">
              {awardSection}
              {shareSection}
              {filesSection}
              <div style={{ padding: '0 10px' }}>
                <ImageCarousel
                  images={bountyEntry.images}
                  connectId={bountyEntry.id}
                  connectType="bountyEntry"
                  mobile
                  onImageChange={(images) => {
                    const [image] = images;
                    if (image) {
                      setActiveImage(image as BountyEntryGetById['images'][number]);
                    }
                  }}
                />
              </div>
              {activeImage && (
                <VotableTags
                  entityType="image"
                  entityId={activeImage.id}
                  nsfwLevel={activeImage.nsfwLevel}
                  canAdd
                  collapsible
                  px="sm"
                />
              )}
              {notesSection}
              <Divider label="Discussion" labelPosition="center" />
              <Stack spacing={8} px="xs">
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
                {user?.id && (
                  <BountyEntryDiscussion bountyEntryId={bountyEntry.id} userId={user.id} />
                )}
              </Stack>
              {!!activeImage && <ImageGenerationData imageId={activeImage.id} />}
            </Stack>
          </Stack>
        </Paper>
      </>
    );
  }

  return (
    <>
      {meta}{' '}
      <TrackView
        entityId={bountyEntry.id}
        entityType="BountyEntry"
        type="BountyEntryView"
        details={{ bountyId: bountyEntry.bountyId }}
      />
      <Paper className="relative flex size-full max-h-full max-w-full overflow-hidden bg-gray-2 dark:bg-dark-9">
        <NavigateBack url={`/bounties/${bounty.id}`}>
          {({ onClick }) => (
            <CloseButton
              style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
              size="lg"
              variant="default"
              onClick={onClick}
              className={classes.mobileOnly}
            />
          )}
        </NavigateBack>
        <BountyEntryCarousel
          onImageChange={setActiveImage}
          bountyEntry={bountyEntry}
          className={classes.carousel}
        />

        <Card className={classes.sidebar} p={0}>
          <Stack style={{ flex: 1, overflow: 'hidden' }}>
            {userSection}
            <Card.Section style={{ overflowY: 'auto' }}>
              <Stack spacing="md">
                {activeImage && (
                  <VotableTags
                    entityType="image"
                    entityId={activeImage.id}
                    nsfwLevel={activeImage.nsfwLevel}
                    canAdd
                    collapsible
                    px="sm"
                  />
                )}
                {awardSection}
                {shareSection}
                {filesSection}
                {notesSection}
                <div style={{ paddingTop: 8 }}>
                  <Divider
                    label="Discussion"
                    labelPosition="center"
                    styles={{
                      label: {
                        marginTop: '-9px !important',
                        marginBottom: -9,
                      },
                    }}
                  />
                  <Paper p="sm" radius={0}>
                    <Stack spacing={8}>
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
                      {user?.id && (
                        <BountyEntryDiscussion bountyEntryId={bountyEntry.id} userId={user.id} />
                      )}
                    </Stack>
                  </Paper>
                </div>
                {!!activeImage && <ImageGenerationData imageId={activeImage.id} />}
              </Stack>
            </Card.Section>
          </Stack>
        </Card>
      </Paper>
    </>
  );
}

BountyEntryDetailsPage.getLayout = (page: React.ReactElement) => (
  <MantineProvider theme={{ colorScheme: 'dark' }} inherit>
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
}: {
  bountyEntry: BountyEntryGetById;
  className: string;
  onImageChange?: (image: BountyEntryGetById['images'][number]) => void;
}) {
  const { images } = bountyEntry;
  const { classes, cx } = useCarrouselStyles();
  const queryUtils = trpc.useContext();

  const carouselNavigation = useCarouselNavigation({ items: images, onChange: onImageChange });

  const isDeletingImage = !!useIsMutating(getQueryKey(trpc.image.delete));
  useDidUpdate(() => {
    if (!isDeletingImage) queryUtils.bountyEntry.getById.invalidate({ id: bountyEntry?.id });
  }, [isDeletingImage]);

  const image = images[carouselNavigation.index];

  const connect: ConnectProps = {
    connectType: 'bountyEntry',
    connectId: bountyEntry.id,
  };

  return (
    <div className="relative flex flex-1 flex-col">
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
            <div className="absolute inset-x-0 bottom-0 z-10 p-3">
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
