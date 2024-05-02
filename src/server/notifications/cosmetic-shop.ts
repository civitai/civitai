import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const cosmeticShopNotifications = createNotificationProcessor({
  'cosmetic-shop-item-sold': {
    displayName: 'Cosmetic Shop - Item sold',
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
