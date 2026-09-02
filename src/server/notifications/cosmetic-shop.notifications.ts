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
  // Event-driven (created in endResaleListings) — the original creator withdrew
  // an item you were reselling, so your listing of it is gone.
  'creator-shop-resale-ended': {
    displayName: 'Creator Shop: An item you resell was withdrawn',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `"${
        details.title as string
      }" is no longer for sale, so it's been removed from your shop. You can list it again if its creator brings it back.`,
      url: details.username ? `/user/${details.username as string}/shop/manage` : '/shop',
    }),
  },
  // Event-driven (created in takedownCosmeticShopItem).
  'creator-shop-item-taken-down': {
    displayName: 'Creator Shop: Cosmetic removed',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `Your cosmetic "${
        details.title as string
      }" was removed from the shop and all sales were refunded: ${details.reason as string}`,
      url: '/content/tos',
    }),
  },
  'cosmetic-shop-item-taken-down': {
    displayName: 'Shop: A cosmetic you bought was removed',
    category: NotificationCategory.System,
    prepareMessage: ({ details }) => ({
      message: `"${
        details.title as string
      }" had to be removed from the shop. It's been taken off your account and your Buzz was refunded.`,
      url: `/user/transactions`,
    }),
  },
  // Moveable (if created through API)
  'cosmetic-shop-item-added-to-section': {
    optIn: true,
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
        SELECT
          cp."buzzTransactionId",
          (payout->>'userId')::int "ownerId",
          si."title" "shopItemTitle",
          u.username "buyer",
          SUM((payout->>'amount')::int) "buzzAmount"
        FROM "UserCosmeticShopPurchases" cp
        JOIN "CosmeticShopItem" si ON si.id = cp."shopItemId"
        LEFT JOIN "User" u ON u.id = cp."userId"
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(cp.meta->'payouts') = 'array' THEN cp.meta->'payouts' ELSE '[]'::jsonb END
        ) payout
        WHERE cp."purchasedAt" > '${lastSent}'::timestamp - INTERVAL '5 minutes'
          AND cp."purchasedAt" <= NOW() - INTERVAL '5 minutes'
          AND (payout->>'amount')::int > 0
        GROUP BY cp."buzzTransactionId", (payout->>'userId')::int, si."title", u.username
      )
      SELECT
        CONCAT('cosmetic-shop-item-sold:', "buzzTransactionId", ':', "ownerId") "key",
        "ownerId"    "userId",
        'cosmetic-shop-item-sold' "type",
        JSONB_BUILD_OBJECT(
          'shopItemTitle', "shopItemTitle",
          'buzzAmount', "buzzAmount",
          'buyer', "buyer"
        ) "details"
      FROM sold_items
      -- One line: the polarity guard matches this clause as a literal.
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = sold_items."ownerId" AND type = 'cosmetic-shop-item-sold')
    `,
  },
});
