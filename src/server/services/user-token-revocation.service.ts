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
  // Read first, so a slow revocation cannot stamp a later ban or deletion it did not cover.
  const since = await readRevocationSince(userId).catch(() => null);

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

  if (!expired || !since) return false;
  if (confirmed) {
    await markTokenRevocation(userId, 'confirmedAt', since).catch((error) =>
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

async function readRevocationSince(userId: number) {
  const [row] = await dbWrite.$queryRaw<{ since: Date | null }[]>`
    SELECT GREATEST("bannedAt", "deletedAt") AS "since" FROM "User" WHERE id = ${userId}
  `;
  return row?.since ?? null;
}

/** Stamps the account only while its latest ban or deletion is still the one at `since`. */
export async function markTokenRevocation(
  userId: number,
  field: 'confirmedAt' | 'alertedAt',
  since: Date
) {
  await dbWrite.$executeRaw`
    UPDATE "User"
    SET meta = jsonb_set(
      CASE WHEN jsonb_typeof(meta) = 'object' THEN meta ELSE '{}'::jsonb END,
      '{tokenRevocation}',
      CASE WHEN jsonb_typeof(meta -> 'tokenRevocation') = 'object'
        THEN meta -> 'tokenRevocation' ELSE '{}'::jsonb END
        || jsonb_build_object(${field}::text, NOW())
    )
    WHERE id = ${userId} AND GREATEST("bannedAt", "deletedAt") = ${since}
  `;
}
