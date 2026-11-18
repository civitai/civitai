import type { Prisma } from '@prisma/client';

/**
 * Deletes the OAuth app tokens of a suspended block's own OAuth client, so the suspension stops
 * them at once instead of when they expire: general bearer routes check the token, not the
 * block's status. Runs in the suspending transaction, after the block row is suspended.
 *
 * Does nothing unless the block now reads `suspended`, so a drifted flip (pending, deprecated) and
 * the shared remix client's rows (their own statuses) revoke nothing. A client with another block
 * still approved keeps its tokens. Returns the number of tokens deleted.
 */
export async function revokeAppBlockOauthTokens(
  tx: Prisma.TransactionClient,
  appBlockId: string
): Promise<number> {
  const block = await tx.appBlock.findUnique({
    where: { id: appBlockId },
    select: { appId: true, status: true },
  });
  if (!block?.appId || block.status !== 'suspended') return 0;
  const approvedSiblings = await tx.appBlock.count({
    where: { appId: block.appId, status: 'approved', NOT: { id: appBlockId } },
  });
  if (approvedSiblings > 0) return 0;
  const { count } = await tx.apiKey.deleteMany({
    where: { clientId: block.appId, type: { in: ['Access', 'Refresh'] } },
  });
  return count;
}
