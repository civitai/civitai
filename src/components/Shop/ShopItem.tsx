import {
  Badge,
  Button,
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
import styles from './ShopItem.module.scss';

export const ShopItem = ({
  item,
  sectionItemCreatedAt,
}: {
  item: CosmeticShopItemGetById;
  sectionItemCreatedAt?: Date;
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

  const isNew =
    remaining !== 0 &&
    lastViewed &&
    sectionItemCreatedAt &&
    dayjs(sectionItemCreatedAt).isAfter(dayjs(lastViewed));

  return (
    <Paper className={`${styles.card} ${isNew ? styles.new : ''}`}>
      {isNew && (
        <Badge color="yellow.7" className={styles.newBadge} variant="filled">
          New!
        </Badge>
      )}
      {(available !== null || availableTo) && (
        <Badge color="grape" className={styles.availability} px={6}>
          <Group position="apart" noWrap spacing={4}>
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
                    {remaining} of {available} left
                  </Text>
                )}
              </>
            )}
          </Group>
        </Badge>
      )}
      <div className={styles.cardHeader}>
        <CosmeticSample cosmetic={cosmetic} />
      </div>
      <Stack spacing="xs">
        <Title order={3}>{getDisplayName(cosmetic)}</Title>
        <ContentClamp maxHeight={60}>
          <RenderHtml html={item.description} />
        </ContentClamp>
        <Group position="apart" mt="auto">
          <CurrencyBadge currency={Currency.BUZZ} amount={item.price} />
          {currentUser ? (
            <Button
              variant="light"
              color="blue"
              onClick={() => {
                dialogStore.trigger({
                  component: CosmeticShopItemPreviewModal,
                  props: {
                    item,
                  },
                });
              }}
              disabled={!isAvailable}
            >
              {isAvailable ? 'Preview' : 'Out of Stock'}
            </Button>
          ) : (
            <LoginRedirect>
              <Button variant="light" color="blue" disabled={!isAvailable}>
                {isAvailable ? 'Preview' : 'Out of Stock'}
              </Button>
            </LoginRedirect>
          )}
        </Group>
      </Stack>
    </Paper>
  );
};

