import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const deliverCosmetics = createJob('deliver-cosmetics', '*/1 * * * *', async () => {
  // Get the last time this ran from the KeyValue store
  // --------------------------------------
  const key = 'last-cosmetic-delivery';
  const lastDelivered = new Date(
    ((
      await dbWrite.keyValue.findUnique({
        where: { key },
      })
    )?.value as number) ?? 0
  ).toISOString();

  const deliverPurchasedCosmetics = async () =>
    dbWrite.$executeRawUnsafe(`
      -- Deliver purchased cosmetics
      with recent_purchases AS (
        SELECT
          u.id "userId",
          p."productId",
          p."createdAt"
        FROM "Purchase" p
        JOIN "User" u ON u."customerId" = p."customerId"
        WHERE p."createdAt" >= '${lastDelivered}'
      )
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt")
      SELECT DISTINCT
        p."userId",
        c.id "cosmeticId",
        now()
      FROM recent_purchases p
      JOIN "Cosmetic" c ON
        c."productId" = p."productId"
        AND (c."availableStart" IS NULL OR p."createdAt" >= c."availableStart")
        AND (c."availableEnd" IS NULL OR p."createdAt" <= c."availableEnd")
      WHERE NOT EXISTS (SELECT 1 FROM "UserCosmetic" uc WHERE uc."cosmeticId" = c.id AND uc."userId" = p."userId");
    `);

  const revokeMembershipLimitedCosmetics = async () =>
    dbWrite.$executeRawUnsafe(`
        -- Revoke member limited cosmetics
        WITH to_revoke AS (
          SELECT
          "userId"
          FROM "CustomerSubscription" cs
          WHERE "cancelAt" <= '${lastDelivered}'
        )
        DELETE FROM "UserCosmetic" uc
        WHERE EXISTS (
          SELECT 1
          FROM to_revoke r
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
          WHERE r."userId" = uc."userId"
          AND c."permanentUnlock" = false
          AND c.source = 'Membership'
        );
      `);

  // Deliver cosmetics
  // --------------------------------------------
  await deliverPurchasedCosmetics();
  await revokeMembershipLimitedCosmetics();

  // Update the last time this ran in the KeyValue store
  // --------------------------------------------
  const value = new Date().getTime();
  await dbWrite.keyValue.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
});
