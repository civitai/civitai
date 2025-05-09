import {
  Badge,
  Button,
  createStyles,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { Currency } from '~/shared/utils/prisma/enums';
import dayjs from 'dayjs';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useShopLastViewed } from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { CosmeticShopItemGetById } from '~/types/router';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';

const useStyles = createStyles((theme) => {
  return {
    card: {
      height: '100%',
      background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      position: 'relative',
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
    type: {
      position: 'absolute',
      left: theme.spacing.md,
      right: theme.spacing.md,
      bottom: theme.spacing.md,
      zIndex: 2,
      textAlign: 'center',
      fontWeight: 600,
    },

    new: {
      outline: `1px solid ${theme.colors.yellow[4]}`,
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: -1,
        margin: '-2px' /* !important */,
        borderRadius: 'inherit' /* !important */,
        background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
        filter: 'blur(3px)',
        opacity: 0.5,
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

export const ShopItem = ({
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
  const itemMeta = item.meta as CosmeticShopItemMeta;

  const remaining =
    item.availableQuantity !== null
      ? Math.max(0, (item.availableQuantity ?? 0) - (itemMeta.purchases ?? 0))
      : null;
  const available = item.availableQuantity !== null ? item.availableQuantity : null;
  const availableTo = item.availableTo ? formatDate(item.availableTo, 'MMM D') : null;
  const leavingSoon = item.availableTo && item.availableTo > dayjs().subtract(24, 'hours').toDate();
  const isUpcoming = item.availableFrom && isFutureDate(item.availableFrom);
  const hasDate = isUpcoming || item.availableTo;

  const isNew =
    remaining !== 0 &&
    lastViewed &&
    sectionItemCreatedAt &&
    dayjs(sectionItemCreatedAt).isAfter(dayjs(lastViewed));

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
      {(available !== null || availableTo) && (
        <Badge color="grape" className={classes.availability} px={6}>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            {remaining === 0 ? (
              <Text>Out of Stock</Text>
            ) : (
              <>
                {isUpcoming ? (
                  <Text>
                    Available in{' '}
                    <Countdown
                      endTime={item.availableFrom!}
                      refreshIntervalMs={1000}
                      format="short"
                    />
                  </Text>
                ) : availableTo ? (
                  leavingSoon ? (
                    <Text>
                      Leaves in{' '}
                      <Countdown
                        endTime={item.availableTo!}
                        refreshIntervalMs={1000}
                        format="short"
                      />
                    </Text>
                  ) : (
                    <Text>Until {availableTo}</Text>
                  )
                ) : null}
                {hasDate && remaining && <Divider orientation="vertical" color="grape.3" />}
                {remaining && available && (
                  <Text>
                    {remaining}/{available} remaining
                  </Text>
                )}
              </>
            )}
          </Group>
        </Badge>
      )}

      <Stack h="100%">
        <Stack gap="md">
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
            <div className={classes.cardHeader}>
              <CosmeticSample cosmetic={cosmetic} size="lg" />
              <Text size="xs" color="dimmed" px={6} component="div" className={classes.type}>
                {getDisplayName(item.cosmetic.type)}
              </Text>
            </div>
          </UnstyledButton>
          <Stack gap={4} align="flex-start">
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
        <Stack mt="auto" gap={4}>
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
