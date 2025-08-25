import {
  Badge,
  Button,
  Divider,
  Group,
  Overlay,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { CosmeticType, Currency } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
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
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopItemGetById } from '~/types/router';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './ShopItem.module.scss';
import { IconCheck } from '@tabler/icons-react';

export const ShopItem = ({
  item,
  sectionItemCreatedAt,
  alreadyOwned = false,
}: {
  item: CosmeticShopItemGetById;
  sectionItemCreatedAt?: Date;
  alreadyOwned?: boolean;
}) => {
  const cosmetic = item.cosmetic;
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
  const outOfStock = remaining === 0;

  const isNew =
    !outOfStock &&
    lastViewed &&
    sectionItemCreatedAt &&
    dayjs(sectionItemCreatedAt).isAfter(dayjs(lastViewed));

  return (
    <Paper className={`${classes.card} ${isNew ? classes.newItem : ''}`}>
      {isNew && (
        <Badge color="yellow.7" className={classes.newBadge} variant="filled">
          New!
        </Badge>
      )}
      {(available !== null || availableTo) && (
        <Badge color="grape" className={classes.availability} px={6}>
          <Group justify="space-between" wrap="nowrap" gap={4}>
            {outOfStock ? (
              <Text inherit>Out of Stock</Text>
            ) : (
              <>
                {isUpcoming ? (
                  <Text inherit>
                    Available in{' '}
                    <Countdown
                      endTime={item.availableFrom!}
                      refreshIntervalMs={1000}
                      format="short"
                    />
                  </Text>
                ) : availableTo ? (
                  leavingSoon ? (
                    <Text inherit>
                      Leaves in{' '}
                      <Countdown
                        endTime={item.availableTo!}
                        refreshIntervalMs={1000}
                        format="short"
                      />
                    </Text>
                  ) : (
                    <Text inherit>Until {availableTo}</Text>
                  )
                ) : null}
                {hasDate && remaining && <Divider orientation="vertical" color="grape.3" />}
                {remaining && available && (
                  <Text inherit>
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
            className={outOfStock ? 'cursor-not-allowed' : undefined}
            onClick={() => {
              if (!currentUser) return;

              dialogStore.trigger({
                component: CosmeticShopItemPreviewModal,
                props: { shopItem: item },
              });
            }}
            disabled={!isAvailable || outOfStock}
          >
            <div className={classes.cardHeader}>
              <CosmeticSample cosmetic={cosmetic} size="lg" />
              <Text size="xs" c="dimmed" px={6} component="div" className={classes.type}>
                {getDisplayName(item.cosmetic.type)}
              </Text>
              {cosmetic.type !== CosmeticType.ContentDecoration && alreadyOwned && (
                <Overlay center>
                  <Text className="flex items-center gap-1" size="xl" fw="bold" c="gray.1">
                    <IconCheck stroke={2.5} />
                    Owned
                  </Text>
                </Overlay>
              )}
            </div>
          </UnstyledButton>
          <Stack gap={4} align="flex-start">
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={item.unitAmount}
              variant="transparent"
              className="!px-0"
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
              disabled={!isAvailable || outOfStock}
            >
              Preview
            </Button>
          </LoginRedirect>
        </Stack>
      </Stack>
    </Paper>
  );
};
