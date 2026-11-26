import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The recipe runner's tables (`runner_*`) and the offline cap columns on "OauthConsent" are
// `@no-type` (raw SQL only), applied by hand in migration `20271204120000_recipe_runner_ledger`.

export interface RunnerClientRow {
  userId: number;
  isConfidential: boolean;
  skipConsent: boolean;
  grants: string[];
  accessMode: string;
}
/**
 * A client that may hold runner tokens at all: Civitai-owned (`systemUserId`), confidential,
 * consented, open (a disabled or testers-only client mints nothing), and no device flow.
 * `grants` stores the URN; the bare name is refused too, so a hand-written row cannot slip past.
 * The one copy of this rule: the auth hub's issuance and the main app's mint both call it.
 */
export function isRunnerClient(
  client: RunnerClientRow | null | undefined,
  systemUserId: number
): boolean {
  return (
    client != null &&
    client.userId === systemUserId &&
    client.isConfidential === true &&
    client.skipConsent === false &&
    client.accessMode === 'open' &&
    !client.grants.includes('urn:ietf:params:oauth:grant-type:device_code') &&
    !client.grants.includes('device_code')
  );
}

export interface RunnerBindingRow {
  appBlockId: string;
  status: string;
}
export interface RunnerAppBlockRow {
  id: string;
  appId: string;
  blockId: string;
  status: string;
}
export interface RunnerConsentRow {
  /** The zoneless column read as UTC. */
  offlineGrantedAt: Date | null;
  offlineBuzzLimit: number | null;
  offlineBuzzPeriod: string | null;
}
export interface RunnerAuthorizationRow {
  id: string;
  userId: number;
  runnerClientId: string;
  kind: string;
  runId: string | null;
  /** The binding hashes a runner submit must reproduce (binding v1). */
  recipeVersionHash: string;
  paramsHash: string;
  maxAmountPerRun: number;
  maxRunsPerPeriod: number | null;
  period: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** The columns `isRunnerClient` decides on. Pass a primary client. */
export async function readRunnerClient(
  db: Kysely<DB>,
  clientId: string
): Promise<RunnerClientRow | null> {
  const row = await db
    .selectFrom('OauthClient')
    .select(['userId', 'isConfidential', 'skipConsent', 'grants', 'accessMode'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  return row ?? null;
}

/** Reads the runner mint needs; see `decideRunnerMint` in the main app. */
export interface RunnerMintReads {
  client(clientId: string): Promise<RunnerClientRow | null>;
  binding(clientId: string): Promise<RunnerBindingRow | null>;
  appBlock(appBlockId: string): Promise<RunnerAppBlockRow | null>;
  consent(userId: number, clientId: string): Promise<RunnerConsentRow | null>;
  authorization(id: string): Promise<RunnerAuthorizationRow | null>;
  hasLiveAttempt(runId: string): Promise<boolean>;
  /** Spend counted against the offline cap since `since`, for (user, client). */
  capUsed(userId: number, clientId: string, since: Date): Promise<number>;
  /** Runs of `authorizationId` that hold or held a live attempt since `since`. */
  runsSince(authorizationId: string, since: Date): Promise<number>;
}

/** Attempt states that hold or spent budget; also a run's live states. `failed` is counted separately in `capUsed`. */
export const RUNNER_CAP_STATES = ['reserved', 'submitting', 'unknown', 'submitted', 'settled'];

/**
 * The runner mint reads. Pass a primary client: a consent change, revocation or attempt written
 * moments ago must be seen.
 */
export function runnerMintReads(db: Kysely<DB>): RunnerMintReads {
  const one = async <T>(query: RawBuilder<T>): Promise<T | null> => {
    const { rows } = await query.execute(db);
    return (rows[0] as T | undefined) ?? null;
  };
  return {
    client: (clientId) => readRunnerClient(db, clientId),
    binding: (clientId) =>
      one<RunnerBindingRow>(sql`
        SELECT app_block_id AS "appBlockId", status
        FROM runner_client_bindings WHERE runner_client_id = ${clientId}`),
    appBlock: (appBlockId) =>
      one<RunnerAppBlockRow>(sql`
        SELECT id, app_id AS "appId", block_id AS "blockId", status
        FROM app_blocks WHERE id = ${appBlockId}`),
    consent: (userId, clientId) =>
      one<RunnerConsentRow>(sql`
        SELECT ("offlineGrantedAt" AT TIME ZONE 'UTC') AS "offlineGrantedAt",
               "offlineBuzzLimit", "offlineBuzzPeriod"
        FROM "OauthConsent" WHERE "userId" = ${userId} AND "clientId" = ${clientId}`),
    authorization: (id) =>
      one<RunnerAuthorizationRow>(sql`
        SELECT id, user_id AS "userId", runner_client_id AS "runnerClientId", kind,
               run_id AS "runId", recipe_version_hash AS "recipeVersionHash",
               params_hash AS "paramsHash", max_amount_per_run AS "maxAmountPerRun",
               max_runs_per_period AS "maxRunsPerPeriod", period,
               created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
        FROM runner_run_authorizations WHERE id = ${id}`),
    hasLiveAttempt: async (runId) =>
      (
        await one<{ live: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM runner_run_attempts
          WHERE run_id = ${runId} AND state = ANY(${RUNNER_CAP_STATES})
        ) AS live`)
      )?.live !== false,
    capUsed: async (userId, clientId, since) => {
      const row = await one<{ used: string | number | null }>(sql`
        SELECT COALESCE(SUM(
          CASE WHEN state = 'failed' THEN COALESCE(charged_amount, 0)
               ELSE COALESCE(charged_amount, reserved_amount) END
        ), 0) AS used
        FROM runner_run_attempts
        WHERE user_id = ${userId} AND runner_client_id = ${clientId}
          AND created_at > ${since}
          AND (state = ANY(${RUNNER_CAP_STATES}) OR state = 'failed')`);
      // A missing row is not "nothing spent": refuse by counting the cap as used.
      return row ? Number(row.used) : Number.POSITIVE_INFINITY;
    },
    runsSince: async (authorizationId, since) => {
      const row = await one<{ runs: string | number }>(sql`
        SELECT COUNT(DISTINCT run_id) AS runs
        FROM runner_run_attempts
        WHERE authorization_id = ${authorizationId} AND created_at > ${since}
          AND state = ANY(${RUNNER_CAP_STATES})`);
      return row ? Number(row.runs) : Number.POSITIVE_INFINITY;
    },
  };
}

// Built with the query builder, not `sql`, so the auth hub's in-memory Kysely fake can run them.
type RunnerTables = {
  runner_client_bindings: { runner_client_id: string; status: string };
  runner_run_authorizations: {
    user_id: number;
    runner_client_id: string;
    revoked_at: Date | null;
    revoked_reason: string | null;
  };
};

/** The runner client's binding status (`active` | `suspended`), or null when unbound. Pass a primary client. */
export async function readRunnerBindingStatus(
  db: Kysely<DB>,
  clientId: string
): Promise<string | null> {
  const row = await db
    .withTables<RunnerTables>()
    .selectFrom('runner_client_bindings')
    .select('status')
    .where('runner_client_id', '=', clientId)
    .executeTakeFirst();
  return row?.status ?? null;
}

export type RunnerAuthorizationRevokeReason = 'offline_declined' | 'disconnected' | 'banned';

/**
 * Revoke every live run authorization the user gave the runner client, or every runner client
 * when `clientId` is null; returns how many.
 */
export async function revokeRunnerAuthorizations(
  db: Kysely<DB>,
  opts: {
    userId: number;
    clientId: string | null;
    reason: RunnerAuthorizationRevokeReason;
    now?: Date;
  }
): Promise<number> {
  let query = db
    .withTables<RunnerTables>()
    .updateTable('runner_run_authorizations')
    .set({ revoked_at: opts.now ?? new Date(), revoked_reason: opts.reason })
    .where('user_id', '=', opts.userId)
    .where('revoked_at', 'is', null);
  if (opts.clientId !== null) query = query.where('runner_client_id', '=', opts.clientId);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows);
}
