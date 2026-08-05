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
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import type { MouseEvent } from 'react';
import { CosmeticType, Currency } from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import {
  useShopLastViewed,
  useToggleWishlistShopItem,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticShopItemPreviewModal } from '~/components/CosmeticShop/CosmeticShopItemPreviewModal';
import { CosmeticPackPreviewModal } from '~/components/CosmeticShop/CosmeticPackPreviewModal';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopItemGetById } from '~/types/router';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './ShopItem.module.scss';
import { IconCheck, IconHeart, IconHeartFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const ShopItem = ({
  item,
  sectionItemCreatedAt,
  alreadyOwned = false,
  wishlisted,
  viaShopUserId,
  creator,
}: {
  item: CosmeticShopItemGetById;
  sectionItemCreatedAt?: Date;
  alreadyOwned?: boolean;
  // Undefined (not false) hides the wishlist control, for surfaces that don't
  // fetch the viewer's wishlist.
  wishlisted?: boolean;
  // Attributes the purchase to this shop owner (Creator Shop cross-creator resale).
  viaShopUserId?: number;
  // The cosmetic's original creator, shown as attribution (Creator Shop only).
  creator?: UserWithCosmetics | null;
}) => {
  const showWishlist = wishlisted !== undefined;
  const cosmetic = item.cosmetic;
  const isAvailable =
    (item.availableQuantity ?? null) === null || (item.availableQuantity ?? 0) > 0;
  const currentUser = useCurrentUser();
  const { lastViewed } = useShopLastViewed();
  const { toggleWishlist, togglingWishlist } = useToggleWishlistShopItem();
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
    <Paper className={clsx(classes.card, isNew && classes.newItem)}>
      {(isNew || showWishlist) && (
        <div className={classes.cardControls}>
          {isNew && (
            <Badge color="yellow.7" variant="filled">
              New!
            </Badge>
          )}
          {showWishlist && (
            <div className={classes.wishlist}>
              <LoginRedirect reason="shop">
                <LegacyActionIcon
                  radius="xl"
                  color={wishlisted ? 'red' : 'gray'}
                  loading={togglingWishlist}
                  aria-label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                  onClick={() => toggleWishlist({ shopItemId: item.id, wishlisted: !wishlisted })}
                >
                  <Tooltip
                    label={wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
                    withArrow
                  >
                    {wishlisted ? <IconHeartFilled size={18} /> : <IconHeart size={18} />}
                  </Tooltip>
                </LegacyActionIcon>
              </LoginRedirect>
            </div>
          )}
        </div>
      )}
      {(available !== null || availableTo) && (
        <Badge
          color="grape"
          className={clsx(classes.availability, showWishlist && classes.availabilityInset)}
          px={6}
        >
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

              if (cosmetic)
                dialogStore.trigger({
                  component: CosmeticShopItemPreviewModal,
                  props: { shopItem: item, viaShopUserId },
                });
              else
                dialogStore.trigger({
                  component: CosmeticPackPreviewModal,
                  props: { shopItemId: item.id, viaShopUserId },
                });
            }}
            disabled={!isAvailable || outOfStock}
          >
            <div className={classes.cardHeader}>
              <div className={clsx(classes.sampleWrapper, outOfStock && classes.dim)}>
                {cosmetic ? (
                  <CosmeticSample cosmetic={cosmetic} size="lg" />
                ) : (
                  itemMeta.coverUrl && (
                    <EdgeMedia src={itemMeta.coverUrl} width={450} alt={item.title} />
                  )
                )}
              </div>
              <Text size="xs" c="dimmed" px={6} component="div" className={classes.type}>
                {cosmetic
                  ? getDisplayName(cosmetic.type)
                  : `Pack of ${itemMeta.packMemberCount ?? 0}`}
              </Text>
              {cosmetic && cosmetic.type !== CosmeticType.ContentDecoration && alreadyOwned && (
                <Overlay center>
                  <Text className="flex items-center gap-1" size="xl" fw="bold" c="gray.1">
                    <IconCheck stroke={2.5} />
                    Owned
                  </Text>
                </Overlay>
              )}
            </div>
          </UnstyledButton>
          <Stack gap={2}>
            <div className={classes.titleRow}>
              <Title order={3} className={classes.title}>
                {item.title}
              </Title>
              <CurrencyBadge
                currency={Currency.BUZZ}
                type={domain === 'green' ? 'green' : 'yellow'}
                unitAmount={item.unitAmount}
                variant="transparent"
                className={clsx('!px-0', classes.price)}
              />
            </div>
            {creator?.username && (
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
            )}
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
              radius="xl"
              className={clsx(classes.buyButton, domain === 'green' && classes.buyButtonGreen)}
              onClick={() => {
                dialogStore.trigger({
                  component: CosmeticShopItemPreviewModal,
                  props: { shopItem: item, viaShopUserId },
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
