import { dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { redis } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { EventInput } from '~/server/schema/event.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { cosmeticStatus } from '~/server/services/user.service';

export function getTeamScores({ event }: EventInput) {
  return eventEngine.getTeamScores(event);
}

type EventCosmetic = Awaited<ReturnType<typeof cosmeticStatus>> & {
  cosmetic: Awaited<ReturnType<typeof getCosmeticDetail>>;
};
export async function getEventCosmetic({ event, userId }: EventInput & { userId: number }) {
  // TODO optimize, let's cache this to avoid multiple queries
  const cacheJson = await redis.hGet(`event:${event}:cosmetic`, userId.toString());
  if (cacheJson) return JSON.parse(cacheJson) as EventCosmetic;

  const { cosmeticId } = await eventEngine.getUserData({ event, userId });
  if (!cosmeticId) return { available: false, obtained: false, equipped: false, cosmetic: null };

  const cosmetic = await getCosmeticDetail({ id: cosmeticId });
  const status = await cosmeticStatus({ id: cosmeticId, userId });
  // Get the userCosmetic record so we can display the data

  const result: EventCosmetic = { ...status, cosmetic };
  await redis.hSet(`event:${event}:cosmetic`, userId.toString(), JSON.stringify(result));

  return result;
}

export async function activateEventCosmetic({ event, userId }: EventInput & { userId: number }) {
  // Get cosmetic
  const { cosmeticId } = await eventEngine.getUserData({ event, userId });
  if (!cosmeticId) throw new Error("You don't have a cosmetic for this event");
  const cosmetic = await getCosmeticDetail({ id: cosmeticId });
  if (!cosmetic) throw new Error("That cosmetic doesn't exist");

  // Update database
  await dbWrite.$executeRaw`
    INSERT INTO "userCosmetic" ("userId", "cosmeticId", "obtainedAt", "equippedAt")
    VALUES (${userId}, ${cosmeticId}, NOW(), NOW())
    ON CONFLICT ("userId", "cosmeticId") DO UPDATE SET "equippedAt" = NOW()
  `;

  const { data } = (await dbWrite.userCosmetic.findUnique({
    where: { userId_cosmeticId: { userId, cosmeticId } },
    select: { data: true },
  })) ?? { data: {} };

  // Update cache
  await redis.hSet(
    `event:${event}:cosmetic`,
    userId.toString(),
    JSON.stringify({ equipped: true, available: true, obtained: true, data, cosmetic })
  );
}

export async function donate({
  event,
  userId,
  amount,
}: EventInput & { userId: number; amount: number }) {
  const { team, accountId } = await eventEngine.getUserData({ event, userId });
  if (!team || !accountId) throw new Error("You don't have a team for this event");

  const { title } = eventEngine.getEventData(event);

  await createBuzzTransaction({
    toAccountId: accountId,
    fromAccountId: userId,
    // type: TransactionType.Donation,
    type: TransactionType.Tip,
    amount,
    description: `${title} Donation - ${team}`,
  });
}
