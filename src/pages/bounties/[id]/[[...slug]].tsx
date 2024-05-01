import {
  Badge,
  Button,
  Container,
  Divider,
  Group,
  Stack,
  Text,
  Title,
  createStyles,
  BadgeProps,
  Tooltip,
  Accordion,
  Center,
  SimpleGrid,
  Loader,
  ThemeIcon,
  Alert,
  ScrollArea,
  Modal,
  NumberInput,
} from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { ImageCarousel } from '~/components/Bounty/ImageCarousel';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Availability, BountyEngagementType, BountyMode } from '@prisma/client';
import { BountyGetById } from '~/types/router';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import {
  IconAward,
  IconClockHour4,
  IconHeart,
  IconInfoCircle,
  IconMessageCircle2,
  IconShare3,
  IconStar,
  IconSwords,
  IconTournament,
  IconTrophy,
  IconViewfinder,
} from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useRouter } from 'next/router';
import { abbreviateNumber, formatCurrencyForDisplay } from '~/utils/number-helpers';
import {
  getBountyCurrency,
  isMainBenefactor,
  useBountyEngagement,
  useQueryBounty,
} from '~/components/Bounty/bounty.utils';
import { CurrencyConfig, constants } from '~/server/common/constants';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { AttachmentCard } from '~/components/Article/Detail/AttachmentCard';
import produce from 'immer';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { ImageViewer, useImageViewerCtx } from '~/components/ImageViewer/ImageViewer';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { BountyDiscussion } from '~/components/Bounty/BountyDiscussion';
import { NextLink } from '@mantine/next';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { BountyEntryCard } from '~/components/Cards/BountyEntryCard';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { AwardBountyAction } from '~/components/Bounty/AwardBountyAction';
import { BountyContextMenu } from '~/components/Bounty/BountyContextMenu';
import { Collection } from '~/components/Collection/Collection';
import Link from 'next/link';
import { TrackView } from '~/components/TrackView/TrackView';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { env } from '~/env/client.mjs';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { PoiAlert } from '~/components/PoiAlert/PoiAlert';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useDidUpdate } from '@mantine/hooks';
import { hasPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.bounties) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) await ssg.bounty.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

export default function BountyDetailsPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const mobile = useContainerSmallerThan('sm');
  const queryUtils = trpc.useUtils();
  const { bounty, loading } = useQueryBounty({ id });
  // Set no images initially, as this might be used by the entries and bounty page too.
  const { setImages, onSetImage } = useImageViewerCtx();
  const { toggle, engagements, toggling } = useBountyEngagement();
  const isDeletingImage = !!useIsMutating(getQueryKey(trpc.image.delete));

  useDidUpdate(() => {
    if (bounty?.id && !isDeletingImage) queryUtils.bounty.getById.invalidate({ id: bounty.id });
  }, [isDeletingImage]);

  const discussionSectionRef = useRef<HTMLDivElement>(null);

  const isFavorite = !bounty ? false : !!engagements?.Favorite?.find((id) => id === bounty.id);
  const isTracked = !bounty ? false : !!engagements?.Track?.find((id) => id === bounty.id);

  const handleEngagementClick = async (type: BountyEngagementType) => {
    if (toggling || !bounty) return;
    await toggle({ type, bountyId: bounty.id });
  };

  const totalUnitAmount = useMemo(() => {
    if (!bounty) {
      return 0;
    }

    return bounty.benefactors.reduce((acc, benefactor) => {
      return acc + (benefactor.unitAmount || 0);
    }, 0);
  }, [bounty]);

  const currency = getBountyCurrency(bounty);

  const meta = bounty ? (
    <Meta
      title={`Civitai | ${bounty?.name}`}
      images={bounty?.images}
      description={bounty?.description}
      links={[
        {
          href: `${env.NEXT_PUBLIC_BASE_URL}/bounties/${bounty.id}/${slugit(bounty.name)}`,
          rel: 'canonical',
        },
      ]}
      deIndex={bounty?.availability === Availability.Unsearchable}
    />
  ) : undefined;

  useEffect(() => {
    if (bounty?.id) {
      setImages(bounty.images);
    }
  }, [bounty?.id, bounty?.images, setImages]);

  if (loading) return <PageLoader />;
  if (!bounty) return <NotFound />;

  if (!currentUser && !hasPublicBrowsingLevel(bounty.nsfwLevel)) {
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );
  }

  const defaultBadgeProps: BadgeProps = {
    radius: 'sm',
    size: 'lg',
    color: 'gray',
    sx: { cursor: 'pointer' },
  };

  const expired = bounty.expiresAt < new Date();

  return (
    <>
      {meta}
      <TrackView entityId={bounty.id} entityType="Bounty" type="BountyView" />
      <Container size="xl" mb={32}>
        <Stack spacing="xs" mb="xl">
          <Group position="apart" className={classes.titleWrapper} noWrap>
            <Group spacing="xs">
              <Title weight="bold" className={classes.title} lineClamp={2} order={1}>
                {bounty.name}
              </Title>
              <Group spacing={8}>
                <CurrencyBadge
                  size="lg"
                  radius="sm"
                  currency={currency}
                  unitAmount={totalUnitAmount}
                  variant="light"
                />
                {bounty.complete && !!bounty.stats?.entryCountAllTime ? (
                  <IconBadge
                    size="lg"
                    radius="sm"
                    color="yellow.7"
                    icon={<IconTrophy size={16} fill="currentColor" />}
                    style={{ color: theme.colors.yellow[7] }}
                  >
                    Awarded
                  </IconBadge>
                ) : expired ? (
                  <Badge size="lg" radius="sm" color="red" variant="filled">
                    Expired
                  </Badge>
                ) : (
                  <IconBadge
                    size="lg"
                    radius="sm"
                    icon={<IconClockHour4 size={18} />}
                    style={{ color: theme.colors.success[5] }}
                  >
                    <DaysFromNow date={bounty.expiresAt} withoutSuffix />
                  </IconBadge>
                )}
                <LoginRedirect reason="perform-action">
                  <IconBadge
                    {...defaultBadgeProps}
                    icon={
                      <IconViewfinder
                        size={18}
                        color={isTracked ? theme.colors.green[6] : undefined}
                      />
                    }
                    onClick={() => handleEngagementClick('Track')}
                  >
                    {abbreviateNumber(bounty.stats?.trackCountAllTime ?? 0)}
                  </IconBadge>
                </LoginRedirect>
                <LoginRedirect reason="perform-action">
                  <IconBadge
                    {...defaultBadgeProps}
                    icon={
                      <IconHeart
                        size={18}
                        color={isFavorite ? theme.colors.red[6] : undefined}
                        style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
                      />
                    }
                    onClick={() => handleEngagementClick('Favorite')}
                  >
                    {abbreviateNumber(bounty.stats?.favoriteCountAllTime ?? 0)}
                  </IconBadge>
                </LoginRedirect>
                <IconBadge
                  {...defaultBadgeProps}
                  icon={<IconMessageCircle2 size={18} />}
                  onClick={() => {
                    discussionSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  {abbreviateNumber(bounty.stats?.commentCountAllTime ?? 0)}
                </IconBadge>
                <IconBadge {...defaultBadgeProps} icon={<IconSwords size={18} />} sx={undefined}>
                  {abbreviateNumber(bounty.stats?.entryCountAllTime ?? 0)}
                </IconBadge>
              </Group>
            </Group>
            <BountyContextMenu bounty={bounty} position="bottom-end" />
          </Group>
          <Group spacing={8}>
            <Text color="dimmed" size="xs">
              {isFutureDate(bounty.startsAt) ? 'Starts at' : 'Started'}:{' '}
              {formatDate(bounty.startsAt, undefined, true)}
            </Text>
            {bounty.tags.length > 0 && (
              <>
                <Divider orientation="vertical" />
                <Collection
                  items={bounty.tags}
                  renderItem={(tag) => (
                    <Link href={`/tag/${encodeURIComponent(tag.name.toLowerCase())}`} passHref>
                      <Badge
                        component="a"
                        size="sm"
                        color="gray"
                        variant={theme.colorScheme === 'dark' ? 'filled' : undefined}
                        sx={{ cursor: 'pointer' }}
                      >
                        {tag.name}
                      </Badge>
                    </Link>
                  )}
                />
              </>
            )}
          </Group>
        </Stack>
        <ContainerGrid gutterMd={32} gutterLg={64}>
          <ContainerGrid.Col xs={12} md={4} orderMd={2}>
            <BountySidebar bounty={bounty} />
          </ContainerGrid.Col>
          <ContainerGrid.Col xs={12} md={8} orderMd={1}>
            <Stack spacing="xs">
              <ImageCarousel
                images={bounty.images}
                connectId={bounty.id}
                connectType="bounty"
                mobile={mobile}
                onClick={(image) => {
                  onSetImage(image.id);
                }}
                isLoading={isDeletingImage}
              />
              <Title order={2} mt="sm">
                About this bounty
              </Title>
              <article>
                <Stack spacing={4}>
                  {bounty.description && (
                    <ContentClamp maxHeight={200}>
                      <RenderHtml html={bounty.description} />
                    </ContentClamp>
                  )}
                </Stack>
              </article>
            </Stack>
          </ContainerGrid.Col>
        </ContainerGrid>
      </Container>
      <BountyEntries bounty={bounty} />
      <Container ref={discussionSectionRef} size="xl" mt={32}>
        <Stack spacing="xl">
          <Group position="apart">
            <Title id="comments" order={2} size={28} weight={600}>
              Discussion
            </Title>
          </Group>
          <BountyDiscussion bountyId={bounty.id} userId={bounty.user?.id} />
        </Stack>
      </Container>
    </>
  );
}

const BountySidebar = ({ bounty }: { bounty: BountyGetById }) => {
  const { theme } = useStyles();
  const router = useRouter();
  const queryUtils = trpc.useContext();
  const currentUser = useCurrentUser();
  const benefactor = bounty.benefactors.find((b) => b.user.id === currentUser?.id);
  const expired = bounty.expiresAt < new Date();
  const minUnitAmount = bounty.minBenefactorUnitAmount;
  const [addToBountyModalOpen, setAddToBountyModalOpen] = useState<boolean>(false);
  const [addToBountyAmount, setAddToBountyAmount] = useState<number>(minUnitAmount);
  const isOwner = bounty?.user && bounty?.user?.id === currentUser?.id;

  const { trackAction } = useTrackEvent();

  const { data: entries, isLoading: loadingEntries } = trpc.bounty.getEntries.useQuery({
    id: bounty.id,
  });

  const addToBountyEnabled =
    !expired &&
    !bounty.complete &&
    !benefactor?.awardedToId &&
    (bounty.mode !== BountyMode.Individual || isMainBenefactor(bounty, currentUser));
  const { isLoading, mutate: addBenefactorUnitAmountMutation } =
    trpc.bounty.addBenefactorUnitAmount.useMutation({
      onMutate: async ({ unitAmount }) => {
        await queryUtils.bounty.getById.cancel();
        queryUtils.bounty.getById.setData(
          { id: bounty.id },
          produce((bounty) => {
            if (!bounty || !currentUser) {
              return;
            }

            if (isBenefactor) {
              // Update the benefactor:
              bounty.benefactors = bounty.benefactors.map((b) => {
                if (b.user.id === currentUser?.id) {
                  return { ...b, unitAmount: b.unitAmount + unitAmount };
                }

                return b;
              });
            } else {
              // No need to do anything, as the benefactor will be added to the list
              // on invalidate
            }
          })
        );
      },
      onSuccess: (_, { unitAmount }) => {
        showSuccessNotification({
          title: isBenefactor
            ? 'Your contribution has increased!'
            : 'You have been added as a supporter to the bounty!',
          message: `The amount of ${formatCurrencyForDisplay(
            unitAmount,
            currency
          )} ${currency} has been added to the bounty`,
        });
      },
      onError: (error) => {
        showErrorNotification({
          title: 'There was an error adding to the bounty.',
          error: new Error(error.message),
        });
      },
      onSettled: async () => {
        await queryUtils.bounty.getById.invalidate({ id: bounty.id });
      },
    });

  const isBenefactor = useMemo(() => {
    if (!bounty || !currentUser) {
      return false;
    }

    return bounty.benefactors.some((b) => b.user.id === currentUser.id);
  }, [bounty, currentUser]);
  const currency = getBountyCurrency(bounty);

  const { toggle, engagements, toggling } = useBountyEngagement();

  const isFavorite = !!engagements?.Favorite?.find((id) => id === bounty.id);
  const isTracked = !!engagements?.Track?.find((id) => id === bounty.id);
  const handleEngagementClick = async (type: BountyEngagementType) => {
    if (toggling) return;
    await toggle({ type, bountyId: bounty.id });
  };

  const onAddToBounty = (amount: number) => {
    addBenefactorUnitAmountMutation({ bountyId: bounty.id, unitAmount: amount });
  };

  const meta = bounty.details;

  const bountyDetails: DescriptionTableProps['items'] = [
    {
      label: 'Bounty Type',
      value: (
        <Badge radius="xl" color="gray">
          {getDisplayName(bounty.type)}
        </Badge>
      ),
    },
    {
      label: 'Base Model',
      value: (
        <Badge radius="xl" color="gray">
          {meta?.baseModel}
        </Badge>
      ),
      visible: !!meta?.baseModel,
    },
    {
      label: 'Model Preferences',
      value: (
        <Group spacing={8}>
          {meta?.modelFormat && (
            <Badge radius="xl" color="gray">
              {meta?.modelFormat}
            </Badge>
          )}
          {meta?.modelSize && (
            <Badge radius="xl" color="gray">
              {meta?.modelSize}
            </Badge>
          )}
        </Group>
      ),
      visible: !!meta?.modelFormat || !!meta?.modelSize,
    },
    {
      label: 'Bounty Mode',
      value: (
        <Badge radius="xl" color="gray">
          {getDisplayName(bounty.mode)}
        </Badge>
      ),
      // TODO.bounty: show this once we allow splitting bounties
      visible: false,
    },
    {
      label: isFutureDate(bounty.startsAt) ? 'Starts at' : 'Started',
      value: <Text>{formatDate(bounty.startsAt, undefined, true)}</Text>,
    },
    {
      label: 'Deadline',
      value: <Text>{formatDate(bounty.expiresAt, undefined, true)}</Text>,
    },
  ];

  const benefactorDetails: DescriptionTableProps['items'] = bounty.benefactors.map((b) => ({
    label: (
      <Group spacing={4} position="apart">
        <UserAvatar
          user={b.user}
          badge={
            isMainBenefactor(bounty, b.user) ? (
              <IconStar
                color={CurrencyConfig[currency].color(theme)}
                fill={CurrencyConfig[currency].color(theme)}
                size={18}
              />
            ) : null
          }
          withUsername
          linkToProfile
        />
        {b.awardedToId && (
          <Tooltip label="This supporter has already awarded an entry" color="dark" withinPortal>
            <IconTrophy
              color={CurrencyConfig[currency].color(theme)}
              fill={CurrencyConfig[currency].color(theme)}
              size={18}
            />
          </Tooltip>
        )}
      </Group>
    ),
    value: (
      <Group spacing={4} style={{ float: 'right' }}>
        <CurrencyIcon currency={currency} size={20} />
        <Text weight={590} td={b.awardedToId ? 'line-through' : undefined}>
          {formatCurrencyForDisplay(b.unitAmount, currency)}
        </Text>
      </Group>
    ),
  }));

  const files = bounty.files ?? [];
  const filesCount = files.length;
  const hasEntries = (entries?.length ?? 0) > 0;

  return (
    <Stack spacing="md">
      <Group spacing={8} noWrap>
        {addToBountyEnabled && (
          <Group
            color="gray"
            position="apart"
            h={36}
            py={2}
            px={4}
            sx={(theme) => ({
              background:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
              flexGrow: 1,
              borderRadius: theme.radius.xs,
            })}
            noWrap
          >
            <Tooltip label="Minimum amount to add">
              <Group spacing={2}>
                <CurrencyIcon currency={currency} size={20} />
                <Text weight={590}>{formatCurrencyForDisplay(minUnitAmount, currency)}</Text>
              </Group>
            </Tooltip>
            <Button
              variant="filled"
              h="100%"
              disabled={isLoading}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Ignore track error
                trackAction({ type: 'AddToBounty_Click' }).catch(() => undefined);
                setAddToBountyAmount(minUnitAmount);
                setAddToBountyModalOpen(true);
              }}
            >
              {isLoading ? 'Processing...' : isBenefactor ? 'Add to bounty' : 'Support'}
            </Button>
            <Modal
              opened={addToBountyModalOpen}
              onClose={() => {
                setAddToBountyModalOpen(false);
              }}
              title="Support this bounty"
            >
              <Stack>
                <Stack spacing="xs">
                  <NumberInput
                    min={minUnitAmount}
                    step={5}
                    value={addToBountyAmount}
                    onChange={(val) => setAddToBountyAmount(val ?? minUnitAmount)}
                    mb="md"
                  />
                  <Text size="sm">
                    Are you sure you want {isBenefactor ? 'to add' : 'become a supporter'}{' '}
                    <Text component="span" weight={590}>
                      <CurrencyIcon currency={currency} size={16} />{' '}
                      {formatCurrencyForDisplay(addToBountyAmount, currency)}
                    </Text>{' '}
                    to this bounty?
                  </Text>
                  <Text color="red.4" size="sm">
                    This action is non reversible.
                  </Text>

                  {!isBenefactor && (
                    <Text size="sm" mt="sm">
                      <strong>Note:</strong> As a supporter, you will be <strong>unable</strong> to
                      add entries to this bounty
                    </Text>
                  )}
                </Stack>
                <Group position="right">
                  <Button variant="default" onClick={() => setAddToBountyModalOpen(false)}>
                    Cancel
                  </Button>

                  <BuzzTransactionButton
                    loading={isLoading}
                    type="submit"
                    label="Continue"
                    buzzAmount={addToBountyAmount}
                    color="yellow.7"
                    onPerformTransaction={() => {
                      if (addToBountyAmount < minUnitAmount) {
                        return;
                      }

                      onAddToBounty(addToBountyAmount);
                      trackAction({ type: 'AddToBounty_Confirm' }).catch(() => undefined);
                      setAddToBountyModalOpen(false);
                    }}
                  />
                </Group>
              </Stack>
            </Modal>
          </Group>
        )}
        <Group spacing={8} noWrap>
          <Tooltip label={isTracked ? 'Stop tracking' : 'Track'} position="top">
            <div>
              <LoginRedirect reason="perform-action">
                <Button
                  onClick={async () => {
                    if (!isTracked)
                      showSuccessNotification({
                        title: 'You are now tracking this bounty',
                        message: "You'll receive notifications for updates to it",
                      });
                    await handleEngagementClick('Track');
                  }}
                  color={isTracked ? 'green' : theme.colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
                  sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                >
                  <IconViewfinder
                    color={theme.colorScheme === 'light' ? theme.black : 'currentColor'}
                  />{' '}
                </Button>
              </LoginRedirect>
            </div>
          </Tooltip>
          <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top">
            <div>
              <LoginRedirect reason="perform-action">
                <Button
                  onClick={() => handleEngagementClick('Favorite')}
                  color={isFavorite ? 'red' : theme.colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
                  sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                >
                  <IconHeart color={theme.colorScheme === 'light' ? theme.black : 'currentColor'} />
                </Button>
              </LoginRedirect>
            </div>
          </Tooltip>
          <Tooltip label="Share" position="top">
            <div style={{ marginLeft: 'auto' }}>
              <ShareButton url={router.asPath} title={bounty.name}>
                <Button
                  sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                  color={theme.colorScheme === 'dark' ? 'dark.6' : 'gray.1'}
                >
                  <IconShare3 />
                </Button>
              </ShareButton>
            </div>
          </Tooltip>
        </Group>
      </Group>
      {bounty.complete && !loadingEntries && (
        <Alert color="yellow">
          {(entries?.length ?? 0) > 0 ? (
            <Group spacing={8} align="center" noWrap>
              <ThemeIcon color="yellow.7" variant="light">
                <IconTrophy size={20} fill="currentColor" />
              </ThemeIcon>
              <Text>
                This bounty has been completed and prizes have been awarded to the winners
              </Text>
            </Group>
          ) : (
            <Text>
              This bounty has been marked as completed with no entries. All supporters have been
              refunded.
            </Text>
          )}
        </Alert>
      )}
      {bounty.complete &&
        !loadingEntries &&
        hasEntries &&
        isOwner &&
        constants.bounties.supportedBountyToModels.some((t) => bounty.type === t) && (
          <Button component={NextLink} href={`/models/create?bountyId=${bounty.id}`}>
            Create model from awarded entry
          </Button>
        )}

      <Accordion
        variant="separated"
        multiple
        defaultValue={['details', 'benefactors']}
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
        <Accordion.Item value="details">
          <Accordion.Control>
            <Group position="apart">Overview</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <DescriptionTable
              items={bountyDetails}
              labelWidth="30%"
              withBorder
              paperProps={{
                sx: {
                  borderLeft: 0,
                  borderRight: 0,
                  borderBottom: 0,
                },
                radius: 0,
              }}
            />
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="benefactors">
          <Accordion.Control>
            <Group position="apart">Supporters</Group>
          </Accordion.Control>
          <Accordion.Panel>
            <ScrollArea.Autosize maxHeight={500}>
              <DescriptionTable
                items={benefactorDetails}
                labelWidth="70%"
                withBorder
                paperProps={{
                  sx: {
                    borderLeft: 0,
                    borderRight: 0,
                    borderBottom: 0,
                  },
                  radius: 0,
                }}
              />
            </ScrollArea.Autosize>
          </Accordion.Panel>
        </Accordion.Item>
        {filesCount > 0 && (
          <Accordion.Item
            value="files"
            sx={(theme) => ({
              marginTop: theme.spacing.md,
              marginBottom: theme.spacing.md,
            })}
          >
            <Accordion.Control>
              <Group position="apart">
                {filesCount ? `${filesCount === 1 ? '1 File' : `${filesCount} Files`}` : 'Files'}
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <ScrollArea.Autosize maxHeight={300}>
                <Stack spacing={2}>
                  {filesCount > 0 ? (
                    <SimpleGrid cols={1} spacing={2}>
                      {files.map((file) => (
                        <AttachmentCard key={file.id} {...file} />
                      ))}
                    </SimpleGrid>
                  ) : (
                    <Center p="xl">
                      <Text size="md" color="dimmed">
                        No files were provided for this bounty
                      </Text>
                    </Center>
                  )}
                </Stack>
              </ScrollArea.Autosize>
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>
      {bounty.poi && <PoiAlert type="Bounty" />}
    </Stack>
  );
};

const useStyles = createStyles((theme) => ({
  titleWrapper: {
    gap: theme.spacing.xs,

    [containerQuery.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
      alignItems: 'flex-start',
    },
  },

  title: {
    wordBreak: 'break-word',
    [containerQuery.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },
}));

const BountyEntries = ({ bounty }: { bounty: BountyGetById }) => {
  const entryCreateUrl = `/bounties/${bounty.id}/entries/create`;
  const currentUser = useCurrentUser();

  const { data: entries = [], isLoading } = trpc.bounty.getEntries.useQuery({ id: bounty.id });
  const { data: ownedEntries = [], isLoading: isLoadingOwnedEntries } =
    trpc.bounty.getEntries.useQuery({
      id: bounty.id,
      owned: true,
    });

  const { items: filteredEntries, hiddenCount } = useApplyHiddenPreferences({
    type: 'bounties',
    data: entries,
  });

  const currency = getBountyCurrency(bounty);
  const benefactorItem = !currentUser
    ? null
    : bounty.benefactors.find((b) => b.user.id === currentUser.id);
  const expired = bounty.expiresAt < new Date();
  const displaySubmitAction =
    !benefactorItem &&
    !isLoadingOwnedEntries &&
    ownedEntries.length < bounty.entryLimit &&
    !currentUser?.muted &&
    !bounty.complete &&
    !expired;

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <Container
      fluid
      my="md"
      sx={(theme) => ({
        background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
      })}
    >
      <Container size="xl">
        <Stack spacing="md" py={32}>
          <Group>
            <Title order={2}>Entries</Title>
            {displaySubmitAction && (
              <Button size="xs" variant="outline" component={NextLink} href={entryCreateUrl}>
                Submit Entry
              </Button>
            )}
            <Tooltip label={`Max entries per user: ${bounty.entryLimit}`}>
              <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
            </Tooltip>
            {hiddenCount > 0 && (
              <Text color="dimmed">
                {hiddenCount.toLocaleString()} entries have been hidden due to your settings or due
                to lack of images
              </Text>
            )}
          </Group>
          {children}
        </Stack>
      </Container>
    </Container>
  );

  if (isLoading) {
    return (
      <Wrapper>
        <Center>
          <Loader />
        </Center>
      </Wrapper>
    );
  }

  if (!filteredEntries?.length) {
    return (
      <Wrapper>
        <Group spacing="xs">
          <ThemeIcon color="gray" size="xl" radius="xl">
            <IconTournament />
          </ThemeIcon>
          <Text size="md" color="dimmed">
            No submissions yet
          </Text>
          {displaySubmitAction && (
            <>
              <Divider orientation="vertical" />
              <Text size="md" color="dimmed">
                Be the first to submit your solution.
              </Text>
            </>
          )}
        </Group>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <SimpleGrid
        spacing="sm"
        breakpoints={[
          { minWidth: 'xs', cols: 1 },
          { minWidth: 'sm', cols: 2 },
          { minWidth: 'md', cols: 4 },
        ]}
        style={{ width: '100%' }}
      >
        {filteredEntries.map((entry) => (
          <BountyEntryCard
            key={entry.id}
            data={entry}
            currency={currency}
            renderActions={() => {
              return (
                <>
                  <AwardBountyAction
                    bounty={bounty}
                    bountyEntryId={entry.id}
                    fileUnlockAmount={entry.fileUnlockAmount}
                  >
                    {({ onClick }) => (
                      <HoverActionButton
                        label="Award"
                        size={30}
                        color="yellow.7"
                        variant="filled"
                        onClick={onClick}
                        keepIconOnHover
                      >
                        <IconAward stroke={2.5} size={16} />
                      </HoverActionButton>
                    )}
                  </AwardBountyAction>
                  {benefactorItem && benefactorItem.awardedToId === entry.id && (
                    <Tooltip label="You awarded this entry">
                      <ThemeIcon color={'yellow.7'} radius="xl" size={30} variant={'filled'}>
                        <IconTrophy size={16} stroke={2.5} />
                      </ThemeIcon>
                    </Tooltip>
                  )}
                </>
              );
            }}
          />
        ))}
      </SimpleGrid>
    </Wrapper>
  );
};

setPageOptions(BountyDetailsPage, {
  withScrollArea: false,
  innerLayout: ({ children }: { children: React.ReactNode }) => (
    <ImageViewer>
      <ScrollAreaMain>{children}</ScrollAreaMain>
    </ImageViewer>
  ),
});
