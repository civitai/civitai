import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import {
  DEVICE_ID_TOKEN_TYPE,
  JWT_TOKEN_TYPE,
  SYSTEM_WORKLOAD_ROLE,
  TOKEN_EXCHANGE_GRANT,
} from './constants';

// Operator actions on workload clients and worker devices. They take the db as an argument and import
// nothing from `$lib`/`$env`, so scripts/worker-client.ts can run them outside SvelteKit.

/** civitai-orchestration's `Provider` enum names, spelled exactly. Add a name when the enum gains one. */
const WORKER_PROVIDERS = [
  'Civitai',
  'OctoML',
  'SaladML',
  'PicFinder',
  'RunPods',
  'ValdiAI',
  'OctoMLNext',
  'RunDiffusion',
  'SaladShared',
  'BaseTen',
  'Cerebrium',
  'Cloudflare',
  'FalAI',
  'Haiper',
  'Runware',
  'Kling',
  'MiniMax',
  'Vidu',
  'Byteplus',
  'Submodel',
  'Alibaba',
  'Google',
  'Krea',
  'Sonilo',
  'OpenRouter',
] as const;

export type CreateWorkerClientInput = {
  id: string;
  name: string;
  provider: string;
  /** The `subject_token_type` URNs the client may exchange. */
  subjectTokenTypes: string[];
  saladContainerGroupIds?: string[];
};

function clientIdError(id: string): string | null {
  // Basic credentials are decoded differently across the token, revoke and introspect routes for any
  // character that form-encoding changes, such as `+`.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return 'a client id may contain only letters, digits, ".", "_" and "-"';
  }
  return null;
}

/** Why `input` is not a valid workload client, or null. */
export function workerClientInputError(input: CreateWorkerClientInput): string | null {
  const types = input.subjectTokenTypes;
  const groups = input.saladContainerGroupIds ?? [];
  const idError = clientIdError(input.id);
  if (idError) return idError;
  if (!(WORKER_PROVIDERS as readonly string[]).includes(input.provider)) {
    return `unknown provider ${input.provider}; use one of ${WORKER_PROVIDERS.join(', ')}`;
  }
  if (types.length === 0) return 'at least one subject token type is required';
  const unknown = types.find((t) => t !== DEVICE_ID_TOKEN_TYPE && t !== JWT_TOKEN_TYPE);
  if (unknown) return `unknown subject token type ${unknown}`;
  if (groups.length > 0 && types.includes(DEVICE_ID_TOKEN_TYPE)) {
    return 'a client with Salad container groups cannot accept device ids';
  }
  if (types.includes(JWT_TOKEN_TYPE) && groups.length === 0) {
    return 'accepting Salad tokens needs at least one Salad container group';
  }
  return null;
}

/**
 * Register a workload client owned by the `system:workload` account. Returns the client secret, which
 * is stored only as its hash: the caller shows it once.
 */
export async function createWorkerClient(
  db: Kysely<DB>,
  input: CreateWorkerClientInput
): Promise<{ clientId: string; secret: string }> {
  const invalid = workerClientInputError(input);
  if (invalid) throw new Error(`Invalid workload client: ${invalid}`);

  const ownerId = await systemWorkloadOwner(db);
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
        userId: ownerId,
        updatedAt: new Date(),
      })
      .execute();
    await trx
      .insertInto('WorkerClient')
      .values({
        clientId: input.id,
        provider: input.provider,
        subjectTokenTypes: input.subjectTokenTypes,
        saladContainerGroupIds: input.saladContainerGroupIds ?? [],
      })
      .execute();
  });
  return { clientId: input.id, secret };
}

/**
 * Register a client whose only use is to call introspection, once its id is on
 * OAUTH_WORKER_INTROSPECTION_CLIENT_IDS. It has no grants, so the token route issues it nothing. Returns
 * the client secret, which is stored only as its hash: the caller shows it once.
 */
export async function createIntrospectorClient(
  db: Kysely<DB>,
  input: { id: string; name: string }
): Promise<{ clientId: string; secret: string }> {
  const invalid = clientIdError(input.id);
  if (invalid) throw new Error(`Invalid introspector client: ${invalid}`);
  const existing = await db
    .selectFrom('OauthClient')
    .select('id')
    .where('id', '=', input.id)
    .executeTakeFirst();
  if (existing) throw new Error(`An OAuth client ${input.id} already exists`);

  const ownerId = await systemWorkloadOwner(db);
  const secret = generateKey(64);
  await db
    .insertInto('OauthClient')
    .values({
      id: input.id,
      secret: generateSecretHash(secret),
      name: input.name,
      grants: [],
      allowedScopes: 0,
      isConfidential: true,
      userId: ownerId,
      updatedAt: new Date(),
    })
    .execute();
  return { clientId: input.id, secret };
}

async function systemWorkloadOwner(db: Kysely<DB>): Promise<number> {
  const owners = await db
    .selectFrom('UserRole')
    .select('userId')
    .where('role', '=', SYSTEM_WORKLOAD_ROLE)
    .execute();
  if (owners.length !== 1) {
    throw new Error(`Expected exactly one ${SYSTEM_WORKLOAD_ROLE} account, found ${owners.length}`);
  }
  return owners[0].userId;
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
