import {
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Container,
  Divider,
  Group,
  Image,
  Loader,
  MantineColor,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  createStyles,
  HoverCard,
  Box,
  Grid,
  TypographyStylesProvider,
  UnstyledButton,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconBell,
  IconBellOff,
  IconBrandSpeedtest,
  IconCircleCheck,
  IconPencilMinus,
} from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, BuildFeatures } from '~/server/schema/build-guide.schema';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client.mjs';
import dayjs from 'dayjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  useCosmeticShopQueryParams,
  useQueryShop,
  useShopLastViewed,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useIsMobile } from '~/hooks/useIsMobile';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticShopItemGetById } from '~/types/router';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { CosmeticSample } from '~/pages/moderator/cosmetic-store/cosmetics';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { CosmeticShopSectionMeta, GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { formatDate, formatDateMin, isFutureDate } from '~/utils/date-helpers';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { useDebouncedValue } from '@mantine/hooks';
import { useEffect } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import { NotificationToggle } from '~/components/Notifications/NotificationToggle';

const IMAGE_SECTION_WIDTH = 1288;

const useStyles = createStyles((theme, _params, getRef) => {
  const sectionRef = getRef('section');

  return {
    section: {
      ref: sectionRef,
      overflow: 'hidden',
      position: 'relative',

      [`& + .${sectionRef}`]: {
        marginTop: theme.spacing.xl * 3,
      },
    },

    sectionHeaderContainer: {
      overflow: 'hidden',
      position: 'relative',
      height: 250,
    },

    sectionHeaderContainerWithBackground: {
      background: 'transparent',
      borderRadius: theme.radius.md,
    },

    sectionDescription: {
      padding: `0 ${theme.spacing.sm}px ${theme.spacing.sm}px`,
      p: {
        fontSize: 18,
        lineHeight: 1.3,
      },
    },

    backgroundImage: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      opacity: 0.4,
      zIndex: -1,
    },

    sectionHeaderContentWrap: {
      position: 'absolute',
      zIndex: 1,
      width: '100%',
      height: '100%',
      top: 0,
      left: 0,
    },

    sectionTitle: {
      color: theme.white,
      width: '100%',
      padding: theme.spacing.lg,
      paddingLeft: 8,
      paddingRight: 8,
      textShadow: `3px 0px 7px rgba(0,0,0,0.8), -3px 0px 7px rgba(0,0,0,0.8), 0px 4px 7px rgba(0,0,0,0.8)`,
      maxWidth: 400,
      fontSize: 48,
      lineHeight: 1.1,
      ['@container (min-width: 500px)']: {
        fontSize: 64,
        maxWidth: 500,
      },
    },

    card: {
      height: '100%',
      background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      position: 'relative',
      margin: '3px',
    },

    cardHeader: {
      background: theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[2],
      margin: -theme.spacing.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderBottomRightRadius: 0,
      borderBottomLeftRadius: 0,
      height: 250,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden',
    },

    availability: {
      position: 'absolute',
      left: theme.spacing.md,
      right: theme.spacing.md,
      top: theme.spacing.md,
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 2,
      '.mantine-Badge-inner': {
        display: 'block',
        width: '100%',
      },
      '.mantine-Text-root': {
        margin: '0 auto',
      },
    },
    countdown: {
      position: 'absolute',
      left: theme.spacing.md,
      right: theme.spacing.md,
      bottom: theme.spacing.md,
      display: 'flex',
      alignItems: 'stretch',
      textAlign: 'center',
      zIndex: 2,
      '.mantine-Badge-inner': {
        display: 'block',
        width: '100%',
      },
      '.mantine-Text-root': {
        margin: '0 auto',
      },
    },

    new: {
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: -1,
        margin: '-3px' /* !importanté */,
        borderRadius: 'inherit' /* !importanté */,
        background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
      },
    },

    newBadge: {
      position: 'absolute',
      top: '-10px',
      right: '-10px',
      zIndex: 1,
    },
  };
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, features }) => {
    if (!features?.cosmeticShop) return { notFound: true };

    await ssg?.cosmeticShop.getShop.prefetch({});
  },
});

export const CosmeticShopItem = ({
  item,
  sectionItemCreatedAt,
}: {
  item: CosmeticShopItemGetById;
  sectionItemCreatedAt?: Date;
}) => {
  const cosmetic = item.cosmetic;
  const { classes, cx } = useStyles();
  const isAvailable =
    (item.availableQuantity ?? null) === null || (item.availableQuantity ?? 0) > 0;
  const currentUser = useCurrentUser();
  const { lastViewed } = useShopLastViewed();

  const remaining = item.availableQuantity;
  const availableTo = item.availableTo ? formatDate(item.availableTo) : null;
  const isUpcoming = item.availableFrom && isFutureDate(item.availableFrom);

  const isNew =
    lastViewed && sectionItemCreatedAt && dayjs(sectionItemCreatedAt).isAfter(dayjs(lastViewed));

  return (
    <Paper
      className={cx(classes.card, {
        [classes.new]: isNew,
      })}
    >
      {isNew && (
        <Badge color="yellow.7" className={classes.newBadge} variant="filled">
          New!
        </Badge>
      )}
      {(remaining !== null || availableTo) && (
        <Badge color="grape" className={classes.availability} px={6}>
          <Group position="apart" noWrap spacing={4}>
            {remaining === 0 ? (
              <Text>Out of Stock</Text>
            ) : (
              <>
                {remaining && <Text>{remaining} remaining</Text>}
                {availableTo && remaining && <Divider orientation="vertical" color="grape.3" />}
                {availableTo && <Text>Available until {availableTo}</Text>}
              </>
            )}
          </Group>
        </Badge>
      )}

      <Stack h="100%">
        <Stack spacing="md">
          <UnstyledButton
            onClick={() => {
              if (!currentUser) {
                return;
              }

              dialogStore.trigger({
                component: CosmeticShopItemPreviewModal,
                props: { shopItem: item },
              });
            }}
            disabled={!isAvailable}
          >
            <Box className={classes.cardHeader}>
              <CosmeticSample cosmetic={cosmetic} size="lg" />
              {isUpcoming && item.availableFrom && (
                <Badge color="grape" className={classes.countdown} px={6}>
                  Available in{' '}
                  <Countdown endTime={item.availableFrom} refreshIntervalMs={1000} format="short" />
                </Badge>
              )}
            </Box>
          </UnstyledButton>
          <Stack spacing={4} align="flex-start">
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={item.unitAmount}
              // @ts-ignore
              variant="transparent"
              px={0}
            />
            <Title order={3}>{item.title}</Title>
          </Stack>
          {!!item.description && (
            <ContentClamp maxHeight={200}>
              <RenderHtml html={item.description} />
            </ContentClamp>
          )}
        </Stack>
        <Stack mt="auto" spacing={4}>
          <LoginRedirect reason="shop">
            <Button
              color="gray"
              radius="xl"
              onClick={() => {
                dialogStore.trigger({
                  component: CosmeticShopItemPreviewModal,
                  props: { shopItem: item },
                });
              }}
              disabled={!isAvailable}
            >
              Preview
            </Button>
          </LoginRedirect>
        </Stack>
      </Stack>
    </Paper>
  );
};

export default function CosmeticShopMain() {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { query } = useCosmeticShopQueryParams();
  const [filters, setFilters] = useState<GetShopInput>({
    ...(query ?? {}),
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { cosmeticShopSections, isLoading } = useQueryShop(debouncedFilters);

  const { lastViewed, updateLastViewed, isFetched } = useShopLastViewed();

  useEffect(() => {
    setFilters(query);
  }, [query]);

  useEffect(() => {
    if (isFetched) {
      // Update last viewed
      updateLastViewed();
    }
  }, [isFetched]);

  return (
    <>
      <Meta
        title="Civitai Cosmetic Shop | Created with Love & AI"
        description="Civitai Cosmetic Shop is a place where you can find the best cosmetic products to really express youself."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/builds`, rel: 'canonical' }]}
      />
      <Container size="xl" p="sm">
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Group noWrap position="apart">
              <Title>Civitai Cosmetic Shop</Title>

              <Group>
                <Button
                  leftIcon={<IconPencilMinus size={16} />}
                  onClick={() => {
                    openUserProfileEditModal({});
                  }}
                  sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
                  radius="xl"
                  compact
                >
                  Customize profile
                </Button>
                <NotificationToggle type="cosmetic-shop-item-added-to-section">
                  {({ onToggle, isEnabled, isLoading }) => (
                    <ActionIcon onClick={onToggle} loading={isLoading}>
                      <Tooltip
                        w={200}
                        multiline
                        withArrow
                        label={`${
                          isEnabled ? 'Do not notify me' : 'Notify me'
                        } about new items in the shop.`}
                      >
                        {isEnabled ? <IconBellOff /> : <IconBell />}
                      </Tooltip>
                    </ActionIcon>
                  )}
                </NotificationToggle>
              </Group>
            </Group>
            <Text size="sm" color="dimmed" mb="sm">
              Any cosmetic purchases directly contributes to Civitai ❤️
            </Text>
          </Stack>
          <Stack ml="auto">
            <ShopFiltersDropdown filters={filters} setFilters={setFilters} />
          </Stack>
          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : cosmeticShopSections?.length > 0 ? (
            cosmeticShopSections.map((section) => {
              const { image, items } = section;
              const meta = section.meta as CosmeticShopSectionMeta;
              const backgroundImageUrl = image
                ? getEdgeUrl(image.url, { width: IMAGE_SECTION_WIDTH, optimized: true })
                : undefined;

              return (
                <Stack key={section.id} className={classes.section} m="sm">
                  <Box
                    className={cx(classes.sectionHeaderContainer, {
                      [classes.sectionHeaderContainerWithBackground]: !!image,
                    })}
                  >
                    <Box
                      className={cx({ [classes.sectionHeaderContentWrap]: !!image })}
                      style={
                        backgroundImageUrl
                          ? {
                              backgroundImage: `url(${backgroundImageUrl})`,
                              backgroundPosition: 'left center',
                            }
                          : undefined
                      }
                    >
                      {!meta?.hideTitle && (
                        <Stack mih="100%" justify="center" align="center" style={{ flexGrow: 1 }}>
                          <Title order={2} className={classes.sectionTitle} align="center">
                            {section.title}
                          </Title>
                        </Stack>
                      )}
                    </Box>
                  </Box>

                  <Stack>
                    {section.description && (
                      <ContentClamp maxHeight={200} className={classes.sectionDescription}>
                        <TypographyStylesProvider>
                          <RenderHtml html={section.description} />
                        </TypographyStylesProvider>
                      </ContentClamp>
                    )}
                  </Stack>

                  <Grid mb={0} mt={0}>
                    {items.map((item) => {
                      const { shopItem } = item;
                      return (
                        <Grid.Col span={12} sm={6} md={3} key={shopItem.id}>
                          <CosmeticShopItem item={shopItem} sectionItemCreatedAt={item.createdAt} />
                        </Grid.Col>
                      );
                    })}
                  </Grid>
                </Stack>
              );
            })
          ) : (
            <NoContent message="It looks like we're still working on some changes. Please come back later." />
          )}
        </Stack>
      </Container>
    </>
  );
}
