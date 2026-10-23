import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { SYSTEM_WORKLOAD_ROLE, TOKEN_EXCHANGE_GRANT } from './constants';

// Operator actions on workload clients and worker devices. They take the db as an argument and import
// nothing from `$lib`/`$env`, so scripts/worker-client.ts can run them outside SvelteKit.

export type CreateWorkerClientInput = {
  id: string;
  name: string;
  provider: string;
  saladContainerGroupIds?: string[];
};

/**
 * Register a workload client owned by the `system:workload` account. Returns the client secret, which
 * is stored only as its hash: the caller shows it once.
 */
export async function createWorkerClient(
  db: Kysely<DB>,
  input: CreateWorkerClientInput
): Promise<{ clientId: string; secret: string }> {
  const owners = await db
    .selectFrom('UserRole')
    .select('userId')
    .where('role', '=', SYSTEM_WORKLOAD_ROLE)
    .execute();
  if (owners.length !== 1) {
    throw new Error(`Expected exactly one ${SYSTEM_WORKLOAD_ROLE} account, found ${owners.length}`);
  }

  const secret = generateKey(64);
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('OauthClient')
      .values({
        id: input.id,
        secret: generateSecretHash(secret),
        name: input.name,
        grants: [TOKEN_EXCHANGE_GRANT],
        allowedScopes: TokenScope.WorkerRegister,
        isConfidential: true,
        userId: owners[0].userId,
        updatedAt: new Date(),
      })
      .execute();
    await trx
      .insertInto('WorkerClient')
      .values({
        clientId: input.id,
        provider: input.provider,
        saladContainerGroupIds: input.saladContainerGroupIds ?? [],
      })
      .execute();
  });
  return { clientId: input.id, secret };
}

/**
 * Block a worker device: its exchanges are refused from now on and its live `Worker` tokens are deleted.
 * Returns how many tokens were deleted. Throws when no device has that id.
 */
export async function blockWorkerDevice(
  db: Kysely<DB>,
  deviceId: number,
  reason: string
): Promise<{ tokensDeleted: number }> {
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('WorkerDevice')
      .set({ status: 'blocked', blockedAt: new Date(), blockedReason: reason })
      .where('id', '=', deviceId)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) throw new Error(`No worker device ${deviceId}`);

    const deleted = await trx
      .deleteFrom('ApiKey')
      .where('workerDeviceId', '=', deviceId)
      .where('type', '=', 'Worker')
      .executeTakeFirst();
    return { tokensDeleted: Number(deleted.numDeletedRows) };
  });
}
