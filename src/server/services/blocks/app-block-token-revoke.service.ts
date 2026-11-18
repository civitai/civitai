import type { Prisma } from '@prisma/client';

/** The holders of the app tokens a suspension deleted, for the post-commit orchestrator revoke. */
export type RevokedAppTokens = { clientId: string; userIds: number[] };

/**
 * Deletes the OAuth app tokens of a suspended block's own OAuth client, so the suspension stops
 * them at once instead of when they expire: general bearer routes check the token, not the
 * block's status. Runs in the suspending transaction, after the block row is suspended. The
 * caller passes the result to {@link forgetRevokedAppTokens} once the transaction commits.
 *
 * Does nothing unless the block now reads `suspended`, so a drifted flip (pending, deprecated) and
 * the shared remix client's rows (their own statuses) revoke nothing. A client with another block
 * still approved keeps its tokens.
 */
export async function revokeAppBlockOauthTokens(
  tx: Prisma.TransactionClient,
  appBlockId: string
): Promise<RevokedAppTokens | null> {
  const block = await tx.appBlock.findUnique({
    where: { id: appBlockId },
    select: { appId: true, status: true },
  });
  if (!block?.appId || block.status !== 'suspended') return null;
  const approvedSiblings = await tx.appBlock.count({
    where: { appId: block.appId, status: 'approved', NOT: { id: appBlockId } },
  });
  if (approvedSiblings > 0) return null;
  const where = { clientId: block.appId, type: { in: ['Access' as const, 'Refresh' as const] } };
  const holders = await tx.apiKey.findMany({ where, select: { userId: true } });
  if (!holders.length) return null;
  await tx.apiKey.deleteMany({ where });
  return { clientId: block.appId, userIds: [...new Set(holders.map((h) => h.userId))] };
}

/**
 * After the suspending transaction commits: drops what the orchestrator cached for the deleted
 * tokens, as every other OAuth token revoke does. Never throws.
 */
export async function forgetRevokedAppTokens(revoked: RevokedAppTokens | null): Promise<void> {
  if (!revoked) return;
  const [{ deleteAuthSubject }, { revokeCivitaiUserTokens }, logging] = await Promise.all([
    import('~/server/http/orchestrator/api-key-spend'),
    import('~/server/services/orchestrator/civitai'),
    import('~/server/logging/client'),
  ]);
  await Promise.all(
    revoked.userIds.map(async (userId) => {
      await deleteAuthSubject({ userId, subject: { type: 'oauth', id: revoked.clientId } }).catch(
        (err) =>
          logging.logToAxiom({
            type: 'oauth.delete-subject.failed',
            message: `delete-subject failed for oauth client ${revoked.clientId} user ${userId}`,
            error: logging.safeError(err),
          })
      );
      await revokeCivitaiUserTokens({ userId }).catch(() => undefined);
    })
  );
}
