import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const cosmeticShopNotifications = createNotificationProcessor({
  'cosmetic-shop-item-added-to-section': {
    defaultDisabled: true,
    displayName: 'Shop: New Products Available',
    category: 'System',
    prepareMessage: () => ({
      message: `New items have been added to the shop! Check 'em out now!`,
      url: `/shop`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH new_items AS (
        SELECT ssi."shopItemId" "id" FROM "CosmeticShopSectionItem" ssi
        JOIN "CosmeticShopItem" si ON si.id = ssi."shopItemId"
        WHERE ssi."createdAt" > '${lastSent}'::timestamp - INTERVAL '60 minutes'
          AND ssi."createdAt" <= NOW() - INTERVAL '60 minutes'
          AND (si."availableFrom" >= NOW() OR si."availableFrom" IS NULL)
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        -- Technically, max id would always point out to the latest added product. It's not a perfect approach but should work well enough.
        CONCAT(uns."userId",':','cosmetic-shop-item-added-to-section', ':', (SELECT MAX(id) FROM new_items)) "id",
        uns."userId" "userId",
        'cosmetic-shop-item-added-to-section' "type",
        '{}' "details",
        '${category}'::"NotificationCategory" "category"
      FROM "UserNotificationSettings" uns
      WHERE uns."type" = 'cosmetic-shop-item-added-to-section' 
      AND EXISTS (SELECT 1 FROM new_items)
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'cosmetic-shop-item-sold': {
    displayName: "Shop: Your Item Sold (Creator's club exclusive)",
    category: 'System',
    prepareMessage: ({ details }) => ({
      message: `You got paid ${details.buzzAmount} Buzz for selling 1 "${details.shopItemTitle}" item`,
      url: `/user/transactions`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH sold_items AS (
        SELECT DISTINCT
          cp."buzzTransactionId",
          CAST(jsonb_array_elements(si.meta->'paidToUserIds') as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'shopItemTitle', si."title", 
            'buzzAmount', FLOOR(si."unitAmount" / jsonb_array_length(si.meta->'paidToUserIds'))
          ) "details"
        FROM "UserCosmeticShopPurchases" cp
        JOIN "CosmeticShopItem" si ON si.id = cp."shopItemId" 
        WHERE cp."purchasedAt" > '${lastSent}'::timestamp - INTERVAL '5 minutes' AND
        cp."purchasedAt" <= NOW() - INTERVAL '5 minutes'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("ownerId",':','cosmetic-shop-item-sold',':',"buzzTransactionId") "id",
        "ownerId"    "userId",
        'cosmetic-shop-item-sold' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM sold_items
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});
