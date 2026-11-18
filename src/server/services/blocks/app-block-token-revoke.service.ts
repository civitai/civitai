import type { Prisma } from '@prisma/client';

/**
 * Deletes the OAuth app tokens of a block's own OAuth client, so suspending the block stops
 * them at once instead of when they expire: general bearer routes check the token, not the
 * block's status. Runs in the suspending transaction.
 *
 * A client that backs other blocks too (the shared remix client) is left alone, so suspending
 * one block never signs out the rest. Returns the number of tokens deleted.
 */
export async function revokeAppBlockOauthTokens(
  tx: Prisma.TransactionClient,
  appBlockId: string
): Promise<number> {
  const block = await tx.appBlock.findUnique({
    where: { id: appBlockId },
    select: { appId: true },
  });
  if (!block?.appId) return 0;
  const siblings = await tx.appBlock.count({
    where: { appId: block.appId, NOT: { id: appBlockId } },
  });
  if (siblings > 0) return 0;
  const { count } = await tx.apiKey.deleteMany({
    where: { clientId: block.appId, type: { in: ['Access', 'Refresh'] } },
  });
  return count;
}
