import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { numberWithCommas } from '~/utils/number-helpers';

export const cosmeticShopNotifications = createNotificationProcessor({
  // Event-driven (created in reviewCreatorShopItem) — a creator's submission was reviewed.
  'creator-shop-item-approved': {
    displayName: 'Creator Shop: Cosmetic approved',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `Your cosmetic "${
        details.title as string
      }" was approved and is now live in your shop.`,
      url: details.username ? `/user/${details.username as string}/shop` : '/',
    }),
  },
  'creator-shop-item-changes-requested': {
    displayName: 'Creator Shop: Changes requested',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: details.reason
        ? `Your cosmetic "${details.title as string}" needs changes: ${details.reason as string}`
        : `Changes were requested on your cosmetic "${
            details.title as string
          }". Edit and resubmit it from your shop.`,
      url: details.username ? `/user/${details.username as string}/shop/manage` : '/',
    }),
  },
  'creator-shop-item-reverted': {
    displayName: 'Creator Shop: Cosmetic unpublished',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: details.reason
        ? `Your cosmetic "${details.title as string}" was unpublished and returned to review: ${
            details.reason as string
          }`
        : `Your cosmetic "${details.title as string}" was unpublished and returned to review.`,
      url: details.username ? `/user/${details.username as string}/shop/manage` : '/',
    }),
  },
  'creator-shop-item-rejected': {
    displayName: 'Creator Shop: Cosmetic rejected',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: details.reason
        ? `Your cosmetic "${details.title as string}" was rejected: ${details.reason as string}`
        : `Your cosmetic "${details.title as string}" was rejected.`,
      url: details.username ? `/user/${details.username as string}/shop/manage` : '/',
    }),
  },
  // Moveable (if created through API)
  'cosmetic-shop-item-added-to-section': {
    defaultDisabled: true,
    displayName: 'Shop: New Products Available',
    category: NotificationCategory.System,
    prepareMessage: () => ({
      message: `New items have been added to the shop! Check 'em out now!`,
      url: `/shop`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_items AS (
        SELECT * FROM "CosmeticShopSectionItem" ssi
        JOIN "CosmeticShopItem" si ON si.id = ssi."shopItemId"
        JOIN "CosmeticShopSection" ss ON ss.id = ssi."shopSectionId"
        WHERE (
          (
            ssi."createdAt" > '${lastSent}'::timestamp
            AND si."availableFrom" IS NULL
          )
          OR
          (
            si."availableFrom" BETWEEN '${lastSent}'::timestamp
            AND now()
          )
        )
        AND (si."availableTo" >= NOW() OR si."availableTo" IS NULL)
        AND ss."published" = TRUE
        ORDER BY si."availableFrom" DESC, ssi."createdAt" DESC
        LIMIT 1
      )
        SELECT
          CONCAT('cosmetic-shop-item-added-to-section:', ni."shopItemId") "key",
          uns."userId" as "userId",
          'cosmetic-shop-item-added-to-section' as "type",
          '{}'::jsonb "details"
        FROM new_items ni
        JOIN "UserNotificationSettings" uns ON uns."type" = 'cosmetic-shop-item-added-to-section'
        WHERE ni."shopItemId" IS NOT NULL
    `,
  },
  // Moveable
  'cosmetic-shop-item-sold': {
    displayName: 'Shop: Your Item got bought (Creator Program exclusive)',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: details.buyer
        ? `${details.buyer as string} bought your "${
            details.shopItemTitle as string
          }" shop item. You got paid ${numberWithCommas(details.buzzAmount as number)} Buzz!`
        : `You got paid ${numberWithCommas(details.buzzAmount as number)} Buzz for selling 1 "${
            details.shopItemTitle as string
          }" item`,
      url: `/user/transactions`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH sold_items AS (
        SELECT DISTINCT
          cp."buzzTransactionId",
          CAST(jsonb_array_elements(si.meta->'paidToUserIds') as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'shopItemTitle', si."title",
            'buzzAmount', FLOOR(si."unitAmount" / jsonb_array_length(si.meta->'paidToUserIds')),
			      'buyer', u.username
          ) "details"
        FROM "UserCosmeticShopPurchases" cp
        JOIN "CosmeticShopItem" si ON si.id = cp."shopItemId"
		    LEFT JOIN "User" u ON u.id = cp."userId"
        WHERE cp."purchasedAt" > '${lastSent}'::timestamp - INTERVAL '5 minutes' AND
        cp."purchasedAt" <= NOW() - INTERVAL '5 minutes'
      )
      SELECT
        CONCAT('cosmetic-shop-item-sold:',"buzzTransactionId") "key",
        "ownerId"    "userId",
        'cosmetic-shop-item-sold' "type",
        details
      FROM sold_items
    `,
  },
});
