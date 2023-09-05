import {
  Badge,
  Button,
  Container,
  Divider,
  Grid,
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
} from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import React, { useMemo } from 'react';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';
import { createModelFileDownloadUrl, isNsfwImage } from '~/server/common/model-helpers';
import { ImageCarousel } from '~/components/Bounty/ImageCarousel';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { BountyMode, CollectionType, Currency, ModelStatus } from '@prisma/client';
import { Countdown } from '~/components/Countdown/Countdown';
import { BountyGetById } from '~/types/router';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { IconCheck, IconDownload, IconHeart, IconShare3, IconStar } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useRouter } from 'next/router';
import { formatCurrencyForDisplay, formatKBytes } from '~/utils/number-helpers';
import { getBountyCurrency, isMainBenefactor } from '~/components/Bounty/bounties.util';
import { CurrencyConfig } from '~/server/common/constants';
import { openRoutedContext, RoutedContextLink } from '~/providers/RoutedContextProvider';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { getDisplayName } from '~/utils/string-helpers';
import { HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { getFileDisplayName } from '~/server/utils/model-helpers';
import { AttachmentCard } from '~/components/Article/Detail/AttachmentCard';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import produce from 'immer';
import { showErrorNotification } from '~/utils/notifications';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.bounties) return { notFound: true };

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
  const mobile = useIsMobile();

  const { data: bounty, isLoading } = trpc.bounty.getById.useQuery({ id });
  const [mainImage] = bounty?.images ?? [];
  const totalUnitAmount = useMemo(() => {
    if (!bounty) {
      return 0;
    }

    return bounty.benefactors.reduce((acc, benefactor) => {
      return acc + (benefactor.unitAmount || 0);
    }, 0);
  }, [bounty]);

  const mainBenefactor = useMemo(() => {
    if (!bounty) {
      return null;
    }

    return bounty.benefactors.find((b) => b.user.id === bounty.user?.id);
  }, [bounty]);

  const currency = getBountyCurrency(bounty);

  const isBenefactor = useMemo(() => {
    if (!bounty || !currentUser) {
      return false;
    }

    return bounty.benefactors.some((b) => b.user.id === currentUser.id);
  }, [bounty, currentUser]);

  const meta = (
    <Meta
      title={`Civitai | ${bounty?.name}`}
      image={
        !mainImage || isNsfwImage(mainImage) || bounty?.nsfw
          ? undefined
          : getEdgeUrl(mainImage.url, { width: 1200 })
      }
      description={bounty?.description}
    />
  );

  if (isLoading) return <PageLoader />;
  if (!bounty) return <NotFound />;

  if ((bounty.nsfw || isNsfwImage(mainImage)) && !currentUser) {
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );
  }

  const defaultBadgeProps: BadgeProps = {
    variant: theme.colorScheme === 'dark' ? 'filled' : 'light',
    radius: 'xl',
    pl: 8,
    pr: 12,
    color: 'gray',
  };

  return (
    <>
      {meta}
      <Container size="xl">
        <Stack spacing={0} mb="xl">
          <Group position="apart" noWrap>
            <Title weight="bold" className={bounty.name}>
              {bounty.name}
            </Title>
          </Group>
          <Group spacing={8} my="sm">
            <CurrencyBadge currency={currency} unitAmount={totalUnitAmount} />
            <Badge {...defaultBadgeProps} style={{ color: theme.colors.teal[6] }}>
              <Countdown endTime={bounty.expiresAt} />
            </Badge>
          </Group>
          <Group spacing={8}>
            <UserAvatar user={bounty.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text color="dimmed" size="sm">
              {formatDate(bounty.startsAt)}
            </Text>
          </Group>
        </Stack>
        <Grid>
          <Grid.Col xs={12} md={4} orderMd={2}>
            <BountySidebar bounty={bounty} />
          </Grid.Col>
          <Grid.Col xs={12} md={8} orderMd={1}>
            <Stack spacing="xs">
              <ImageCarousel
                images={bounty.images}
                nsfw={bounty.nsfw}
                entityId={bounty.id}
                entityType="bounty"
                mobile={mobile}
              />
              <Title order={2} mt="sm">
                About this bounty
              </Title>
              <article>
                <RenderHtml html={bounty.description} />
              </article>
              <Divider />
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}

const BountySidebar = ({ bounty }: { bounty: BountyGetById }) => {
  const { theme } = useStyles();
  const currentUser = useCurrentUser();
  const router = useRouter();
  const queryUtils = trpc.useContext();

  const addToBountyEnabled =
    bounty.mode !== BountyMode.Individual || isMainBenefactor(bounty, currentUser);
  const { isLoading, mutate: addBenefactorUnitAmountMutation } =
    trpc.bounty.addBenefactorUnitAmount.useMutation({
      onMutate: async ({ unitAmount }) => {
        console.log(unitAmount);
        await queryUtils.bounty.getById.setData(
          { id: bounty.id },
          produce((bounty) => {
            if (!bounty) {
              return;
            }

            if (isBenefactor) {
              // Update the benefactor:
              bounty.benefactors = bounty.benefactors.map((b) => {
                if (b.user.id === currentUser.id) {
                  return { ...b, unitAmount: b.unitAmount + unitAmount };
                }

                return b;
              });
            } else {
              bounty.benefactors.push({ user: currentUser, unitAmount });
            }
          })
        );
      },
      onSuccess: async () => {
        await queryUtils.bounty.getById.invalidate({ id: bounty.id });
      },
      onError: async (error) => {
        await queryUtils.bounty.getById.invalidate({ id: bounty.id });

        showErrorNotification({
          title: 'There was an error adding to the bounty.',
          error: new Error(error.message),
        });
      },
    });

  const isBenefactor = useMemo(() => {
    if (!bounty || !currentUser) {
      return false;
    }

    return bounty.benefactors.some((b) => b.user.id === currentUser.id);
  }, [bounty, currentUser]);
  const currency = getBountyCurrency(bounty);

  const minUnitAmount = bounty.minBenefactorUnitAmount;
  const Icon = CurrencyConfig[currency].icon;

  const isFavorite = false;
  const onFavoriteClick = () => {
    console.log('is favorite');
  };

  const onAddToBounty = (amount: number) => {
    addBenefactorUnitAmountMutation({ bountyId: bounty.id, unitAmount: amount });
  };

  const bountyDetails: DescriptionTableProps['items'] = [
    {
      label: 'Bounty Type',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="xl" color="gray">
            {getDisplayName(bounty.type)}
          </Badge>
        </Group>
      ),
    },
    {
      label: 'Bounty Mode',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="xl" color="gray">
            {getDisplayName(bounty.mode)}
          </Badge>
        </Group>
      ),
    },
    {
      label: 'Entry Mode',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="xl" color="gray">
            {getDisplayName(bounty.entryMode)}
          </Badge>
        </Group>
      ),
    },
    {
      label: 'Date started',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Text>{formatDate(bounty.startsAt)}</Text>
        </Group>
      ),
    },
    {
      label: 'Deadline',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Text>{formatDate(bounty.expiresAt)}</Text>
        </Group>
      ),
    },
    {
      label: 'Tags',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="xl" color="gray">
            TODO.bounties
          </Badge>
        </Group>
      ),
    },
  ];

  const benefactorDetails: DescriptionTableProps['items'] = bounty.benefactors.map((b) => ({
    label: (
      <Group spacing={4}>
        <UserAvatar user={b.user} withUsername linkToProfile />
        {isMainBenefactor(bounty, b.user) && (
          <IconStar
            color={CurrencyConfig[currency].color(theme)}
            fill={CurrencyConfig[currency].color(theme)}
            size={12}
          />
        )}
      </Group>
    ),
    value: (
      <Group spacing={4} style={{ float: 'right' }}>
        <Icon
          color={CurrencyConfig[currency].color(theme)}
          fill={CurrencyConfig[currency].color(theme)}
          size={20}
        />
        <Text weight={590}>{formatCurrencyForDisplay(b.unitAmount, currency)}</Text>
      </Group>
    ),
  }));

  const files = bounty.files ?? [];
  const filesCount = files.length;

  return (
    <Stack>
      <Group>
        {addToBountyEnabled && (
          <Group color="gray" p={4} style={{ background: theme.colors.dark[6] }}>
            <Group spacing={2}>
              <Icon
                color={CurrencyConfig[currency].color(theme)}
                fill={CurrencyConfig[currency].color(theme)}
                size={20}
              />
              <Text weight={590}>{formatCurrencyForDisplay(minUnitAmount, currency)}</Text>
            </Group>
            <PopConfirm
              message={
                <Stack spacing={0}>
                  <Text size="sm">
                    Are you sure you want {isBenefactor ? 'add' : 'become a benefactor by adding'}{' '}
                    <Text component="span" weight={590}>
                      <Icon
                        color={CurrencyConfig[currency].color(theme)}
                        fill={CurrencyConfig[currency].color(theme)}
                        size={16}
                      />{' '}
                      {formatCurrencyForDisplay(minUnitAmount, currency)}
                    </Text>{' '}
                    to this bounty?
                  </Text>
                  <Text color="red.4" size="sm">
                    This action is non refundable.
                  </Text>

                  {!isBenefactor && (
                    <Text size="sm" mt="sm">
                      <strong>Note:</strong> As a benefactor, you will be unable to add entries to
                      this bounty
                    </Text>
                  )}
                </Stack>
              }
              position="bottom-end"
              onConfirm={() => onAddToBounty(minUnitAmount)}
              withArrow
            >
              <Button variant="filled" disabled={isLoading}>
                {isLoading
                  ? 'Processing...'
                  : isBenefactor
                  ? 'Add to bounty'
                  : 'Become a benefactor'}
              </Button>
            </PopConfirm>
          </Group>
        )}
        <Tooltip label="Share" position="top" withArrow>
          <div>
            <ShareButton url={router.asPath} title={bounty.name}>
              <Button
                sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                color="gray"
              >
                <IconShare3 />
              </Button>
            </ShareButton>
          </div>
        </Tooltip>
        <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top" withArrow>
          <div>
            <LoginRedirect reason="favorite-model">
              <Button
                onClick={onFavoriteClick}
                color={isFavorite ? 'red' : 'gray'}
                sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
              >
                <IconHeart color="#fff" />
              </Button>
            </LoginRedirect>
          </div>
        </Tooltip>
      </Group>

      <Accordion
        variant="separated"
        multiple
        defaultValue={['details']}
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
            <Group position="apart">Benefactors</Group>
          </Accordion.Control>
          <Accordion.Panel>
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
          </Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item
          value="files"
          sx={(theme) => ({
            marginTop: theme.spacing.md,
            marginBottom: theme.spacing.md,
            borderColor: !filesCount ? `${theme.colors.red[4]} !important` : undefined,
          })}
        >
          <Accordion.Control>
            <Group position="apart">
              {filesCount ? `${filesCount === 1 ? '1 File' : `${filesCount} Files`}` : 'Files'}
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
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
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
};

const useStyles = createStyles((theme) => ({
  titleWrapper: {
    gap: theme.spacing.xs,

    [theme.fn.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
    },
  },

  title: {
    wordBreak: 'break-word',
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },
}));
