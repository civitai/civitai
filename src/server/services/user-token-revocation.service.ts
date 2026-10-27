import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { expireUserApiKeys } from '~/server/services/api-key.service';
import { revokeCivitaiUserTokens } from '~/server/services/orchestrator/civitai';

export const TOKEN_REVOCATION_RETRY_DELAYS_MS = [1_000, 4_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Revokes every API key and OAuth token of a banned or deleted account, here and in the
 * orchestrator's auth cache, and stamps `meta.tokenRevocation.confirmedAt` once the orchestrator
 * confirms. Never throws: the account change has already committed. Unconfirmed accounts are retried
 * by the `revoke-user-tokens` job.
 */
export async function revokeUserTokens(
  userId: number,
  { retryDelaysMs = TOKEN_REVOCATION_RETRY_DELAYS_MS }: { retryDelaysMs?: number[] } = {}
) {
  let expired = false;
  let confirmed = false;
  try {
    ({ orchestratorConfirmed: confirmed } = await expireUserApiKeys(userId));
    expired = true;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'user-token-revocation-expire-failed',
      userId,
      message: (error as Error).message,
      error: safeError(error),
    }).catch(() => null);
  }

  for (const delay of retryDelaysMs) {
    if (confirmed) break;
    await sleep(delay);
    confirmed = await revokeCivitaiUserTokens({ userId });
  }

  if (!expired) return false;
  if (confirmed) {
    await markTokenRevocation(userId, 'confirmedAt').catch((error) =>
      logToAxiom({
        type: 'error',
        name: 'user-token-revocation-stamp-failed',
        userId,
        message: (error as Error).message,
      }).catch(() => null)
    );
  }
  return confirmed;
}

export async function markTokenRevocation(userId: number, field: 'confirmedAt' | 'alertedAt') {
  await dbWrite.$executeRaw`
    UPDATE "User"
    SET meta = jsonb_set(
      COALESCE(meta, '{}'::jsonb),
      '{tokenRevocation}',
      COALESCE(meta -> 'tokenRevocation', '{}'::jsonb) || jsonb_build_object(${field}::text, NOW())
    )
    WHERE id = ${userId}
  `;
}
