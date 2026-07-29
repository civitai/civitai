import {
  Anchor,
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
import { NextLink } from '~/components/NextLink/NextLink';
import type { MouseEvent } from 'react';
import { CosmeticType, Currency } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import { useShopLastViewed } from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { BuzzPill } from '~/components/Shop/BuzzPill';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopItemGetById } from '~/types/router';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './ShopItem.module.scss';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';

export const ShopItem = ({
  item,
  sectionItemCreatedAt,
  alreadyOwned = false,
  viaShopUserId,
  creator,
  layout = 'shop',
}: {
  item: CosmeticShopItemGetById;
  sectionItemCreatedAt?: Date;
  alreadyOwned?: boolean;
  // Attributes the purchase to this shop owner (Creator Shop cross-creator resale).
  viaShopUserId?: number;
  // The cosmetic's original creator, shown as attribution (Creator Shop only).
  creator?: UserWithCosmetics | null;
  // 'shop' = the official /shop cards (default). 'storefront' = the leaner
  // creator-shop cards: compact artwork, creator avatar attribution, and the
  // Buzz price on the button instead of beside the title.
  layout?: 'shop' | 'storefront';
}) => {
  const isStorefront = layout === 'storefront';
  const cosmetic = item.cosmetic;
  const isAvailable =
    (item.availableQuantity ?? null) === null || (item.availableQuantity ?? 0) > 0;
  const currentUser = useCurrentUser();
  const { lastViewed } = useShopLastViewed();
  const domain = useDomainColor();
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
    <Paper
      className={clsx(
        classes.card,
        isStorefront && classes.cardStorefront,
        isNew && !isStorefront && classes.newItem
      )}
    >
      {isNew && !isStorefront && (
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
                props: { shopItem: item, viaShopUserId },
              });
            }}
            disabled={!isAvailable || outOfStock}
          >
            <div className={clsx(classes.cardHeader, isStorefront && classes.cardHeaderCompact)}>
              <div className={clsx(classes.sampleWrapper, outOfStock && classes.dim)}>
                <CosmeticSample cosmetic={cosmetic} size={isStorefront ? 'md' : 'lg'} />
              </div>
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
          <Stack gap={isStorefront ? 6 : 2}>
            <div className={classes.titleRow}>
              <Title
                order={isStorefront ? 4 : 3}
                className={clsx(classes.title, isStorefront && classes.titleStorefront)}
              >
                {item.title}
              </Title>
              {!isStorefront && (
                <CurrencyBadge
                  currency={Currency.BUZZ}
                  type={domain === 'green' ? 'green' : 'yellow'}
                  unitAmount={item.unitAmount}
                  variant="transparent"
                  className={clsx('!px-0', classes.price)}
                />
              )}
            </div>
            {creator?.username &&
              (isStorefront ? (
                <div onClick={(e: MouseEvent) => e.stopPropagation()}>
                  <UserAvatar user={creator} withUsername size="sm" linkToProfile />
                </div>
              ) : (
                <Text size="xs" c="dimmed">
                  by{' '}
                  <Anchor
                    component={NextLink}
                    href={`/user/${creator.username}`}
                    c="blue.4"
                    fw={500}
                    underline="always"
                    // Don't trigger the card's purchase modal.
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                  >
                    @{creator.username}
                  </Anchor>
                </Text>
              ))}
          </Stack>
          {!!item.description && (
            <div className={classes.description}>
              <RenderHtml html={item.description} />
            </div>
          )}
        </Stack>
        <Stack mt="auto" gap={4}>
          <LoginRedirect reason="shop">
            <Button
              radius={isStorefront ? 'sm' : 'xl'}
              px={isStorefront ? 10 : undefined}
              className={
                isStorefront
                  ? clsx(
                      classes.buyButton,
                      domain === 'green' ? classes.buyButtonSolidGreen : classes.buyButtonSolid
                    )
                  : clsx(classes.buyButton, domain === 'green' && classes.buyButtonGreen)
              }
              styles={isStorefront ? { label: { width: '100%' } } : undefined}
              onClick={() => {
                dialogStore.trigger({
                  component: CosmeticShopItemPreviewModal,
                  props: { shopItem: item, viaShopUserId },
                });
              }}
              disabled={!isAvailable || outOfStock}
            >
              {isStorefront ? (
                <span className={classes.buyButtonInner}>
                  <span className={classes.buyButtonLabel}>Preview</span>
                  <BuzzPill
                    amount={item.unitAmount}
                    variant={domain === 'green' ? 'green' : 'yellow'}
                  />
                </span>
              ) : (
                'Preview'
              )}
            </Button>
          </LoginRedirect>
        </Stack>
      </Stack>
    </Paper>
  );
};
