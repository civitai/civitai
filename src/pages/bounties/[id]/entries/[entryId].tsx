import { useState } from 'react';
import { z } from 'zod';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { InferGetServerSidePropsType } from 'next';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { Meta } from '~/components/Meta/Meta';
import { isNsfwImage } from '~/server/common/model-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
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
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useHotkeys } from '@mantine/hooks';
import {
  IconChevronLeft,
  IconChevronRight,
  IconLock,
  IconLockOpen,
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
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { Reactions } from '~/components/Reaction/Reactions';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useRouter } from 'next/router';
import { AwardBountyAction } from '~/components/Bounty/AwardBountyAction';
import { openConfirmModal } from '@mantine/modals';
import { showErrorNotification } from '~/utils/notifications';
import { IconDotsVertical } from '@tabler/icons-react';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ReportEntity } from '~/server/schema/report.schema';
import { openContext } from '~/providers/CustomModalsProvider';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { formatDate } from '~/utils/date-helpers';

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
    }

    return { props: removeEmpty(result.data) };
  },
});

const useStyles = createStyles((theme, _props, getRef) => {
  const isMobile = `@media (max-width: ${theme.breakpoints.md - 1}px)`;
  const isDesktop = `@media (min-width: ${theme.breakpoints.md}px)`;
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
    sidebar: {
      width: 457,
      borderRadius: 0,
      borderLeft: `1px solid ${theme.colors.dark[4]}`,
      display: 'flex',
      flexDirection: 'column',

      [isMobile]: {
        position: 'absolute',
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
  const queryUtils = trpc.useContext();

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
  const [mainImage] = bountyEntry?.images ?? [];
  const user = bountyEntry?.user;
  const mobile = useIsMobile({ breakpoint: 'md' });
  const currentUser = useCurrentUser();
  const benefactor = (bounty?.benefactors ?? []).find((b) => b.user.id === currentUser?.id);
  const isOwner = currentUser && user?.id === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;

  const meta = (
    <Meta
      title={`Civitai | ${bounty?.name} | ${user?.username}`}
      image={
        !mainImage || isNsfwImage(mainImage) || bounty?.nsfw
          ? undefined
          : getEdgeUrl(mainImage.url, { width: 1200 })
      }
      description={bounty?.description}
    />
  );

  if (isLoadingBounty || isLoadingEntry || isLoadingDelete) {
    return <PageLoader />;
  }

  if (!bounty || !bountyEntry) {
    return <NotFound />;
  }

  const filesCount = files?.length ?? 0;
  const reactions = bountyEntry?.reactions ?? [];
  const stats: {
    likeCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    cryCountAllTime: number;
  } | null = bountyEntry?.stats ?? null;

  const userSection = (
    <>
      {user && (
        <Card.Section py="xs" withBorder inheritPadding>
          <Stack spacing={0}>
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
            <CreatorCard user={user} />
          </Stack>
        </Card.Section>
      )}
    </>
  );

  const awardSection = (
    <>
      {benefactor && benefactor.awardedToId === bountyEntry.id && (
        <Alert color="yellow">
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
    <Group spacing={8} noWrap>
      {(isOwner || isModerator) && bountyEntry.awardedUnitAmountTotal === 0 && (
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
          <Group spacing={4}>
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
            <Group spacing={4}>
              <ThemeIcon
                // @ts-ignore: transparent variant does work
                variant="transparent"
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
          <Group spacing={4}>
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
              <SimpleGrid cols={1} spacing={2}>
                {files.map((file) => {
                  const isLocked = !file.url;

                  return (
                    <Paper key={file.id} radius={0} p={8} w="100%" bg="dark.4">
                      <Stack>
                        <Group position="apart" noWrap>
                          <Group>
                            {isLocked ? (
                              <Tooltip
                                label="This file has not been unlocked yet"
                                maw={200}
                                multiline
                                withArrow
                                withinPortal
                              >
                                <IconLock />
                              </Tooltip>
                            ) : (
                              <IconLockOpen />
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

                          <Group spacing={0}>
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
                            {(file.metadata.unlockAmount ?? 0) > 0 && (
                              <CurrencyBadge
                                currency={file.metadata.currency ?? Currency.BUZZ}
                                unitAmount={file.metadata.unlockAmount ?? 0}
                              />
                            )}
                          </Group>
                        </Group>
                      </Stack>
                    </Paper>
                  );
                })}
              </SimpleGrid>
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

  if (mobile) {
    return (
      <>
        {meta}
        <Paper className={classes.root}>
          <Stack w="100%">
            {userSection}
            <Stack px="sm" pb="lg">
              {awardSection}
              {shareSection}
              {filesSection}
              <ImageCarousel
                images={bountyEntry.images}
                nsfw={bounty.nsfw}
                entityId={bountyEntry.id}
                entityType="bountyEntry"
                mobile={true}
              />
              <Divider label="Discussion" labelPosition="center" />
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
                }}
              />
              {user?.id && (
                <BountyEntryDiscussion bountyEntryId={bountyEntry.id} userId={user.id} />
              )}
            </Stack>
          </Stack>
        </Paper>
      </>
    );
  }

  return (
    <>
      {meta}{' '}
      <Paper className={classes.root}>
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
        <BountyEntryCarousel bountyEntry={bountyEntry} className={classes.carousel} />

        <Card className={classes.sidebar} pt={0}>
          <Stack>
            {userSection}
            {awardSection}
            {shareSection}
            {filesSection}
            <Card.Section
              component={ScrollArea}
              style={{ flex: 1, position: 'relative' }}
              classNames={{ viewport: classes.scrollViewport }}
            >
              <Stack spacing="md" pt="md" pb="md" style={{ flex: 1 }}>
                <div>
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
                        }}
                      />
                      {user?.id && (
                        <BountyEntryDiscussion bountyEntryId={bountyEntry.id} userId={user.id} />
                      )}
                    </Stack>
                  </Paper>
                </div>
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

export function BountyEntryCarousel({
  bountyEntry,
  className,
}: {
  bountyEntry: BountyEntryGetById;
  className: string;
}) {
  // const router = useRouter();
  const { images } = bountyEntry;
  const [currentIdx, setCurrentIdx] = useState(0);
  const current = images[currentIdx];
  const { classes, cx } = useCarrouselStyles();

  const { setRef, height, width } = useAspectRatioFit({
    height: current?.height ?? 1200,
    width: current?.width ?? 1200,
  });

  const hasNextImage = !!images[currentIdx + 1]?.id;
  const hasPrevImage = !!images[currentIdx - 1]?.id;

  const onPrevImage = () => {
    setCurrentIdx(Math.max(currentIdx - 1, 0));
  };
  const onNextImage = () => {
    setCurrentIdx(Math.min(currentIdx + 1, images.length - 1));
  };

  // #region [navigation]
  useHotkeys([
    ['ArrowLeft', onPrevImage],
    ['ArrowRight', onNextImage],
  ]);
  // #endregion

  if (!current) {
    return (
      <Center>
        <Alert>Due to your filter settings, we could not display any images from this entry</Alert>
      </Center>
    );
  }

  const canNavigate = hasNextImage || hasPrevImage;

  return (
    <div ref={setRef} className={cx(classes.root, className)}>
      {canNavigate && (
        <>
          {!!hasPrevImage && (
            <UnstyledButton className={cx(classes.control, classes.prev)} onClick={onPrevImage}>
              <IconChevronLeft />
            </UnstyledButton>
          )}
          {!!hasNextImage && (
            <UnstyledButton className={cx(classes.control, classes.next)} onClick={onNextImage}>
              <IconChevronRight />
            </UnstyledButton>
          )}
        </>
      )}
      <ImageGuard
        images={[current]}
        connect={{ entityId: bountyEntry.id, entityType: 'bountyEntry' }}
        render={(image) => {
          return (
            <Center
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }}
            >
              <Center
                style={{
                  position: 'relative',
                  height: height,
                  width: width,
                }}
              >
                <ImageGuard.ToggleConnect
                  position="top-left"
                  sx={(theme) => ({ borderRadius: theme.radius.sm })}
                />
                <ImageGuard.ToggleImage
                  position="top-left"
                  sx={(theme) => ({ borderRadius: theme.radius.sm })}
                />
                <ImageGuard.Report />
                <ImageGuard.Unsafe>
                  <MediaHash {...image} />
                </ImageGuard.Unsafe>
                <ImageGuard.Safe>
                  <EdgeMedia
                    src={image.url}
                    name={image.name ?? image.id.toString()}
                    alt={image.name ?? undefined}
                    type={image.type}
                    style={{ maxHeight: '100%', maxWidth: '100%' }}
                    width={image.width ?? 1200}
                    anim
                  />
                </ImageGuard.Safe>
              </Center>
            </Center>
          );
        }}
      />
    </div>
  );
}

const useCarrouselStyles = createStyles((theme, _props, getRef) => {
  return {
    root: {
      position: 'relative',
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
