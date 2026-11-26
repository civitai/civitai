import { TRPCError } from '@trpc/server';
import { runnerMintReads } from '@civitai/db-queries/recipe-runner';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { RUNNER_TOKEN_LIFETIME_SECONDS } from '~/server/services/block-token.service';
import type { RunnerBindingHashes, RunnerSlot } from '~/server/services/blocks/runner-binding';
import type { RunnerReserveRefusal } from '~/server/services/blocks/runner-ledger.service';
import { CONSENT_SPEND_SCOPE } from '~/server/services/blocks/scope-grant.service';

/** What a runner submit carries from its pre-checks to the reserve and the ledger transitions. */
export interface RunnerSubmit {
  runId: string;
  authorizationId: string;
  runKey: string;
  clientId: string;
  slots: RunnerSlot[];
  authorized: RunnerBindingHashes;
  /** Set once the ledger reserves this submit's attempt. */
  attemptId: string | null;
}

export type RunnerSubmitRefusal =
  | 'kind'
  | 'idempotency'
  | 'claims'
  | 'offline_flag'
  | 'app_block'
  | 'approved_scopes'
  | 'publisher_banned'
  | 'authorization'
  | 'binding'
  | 'replay';

interface RunnerAppBlockState {
  status: string;
  approvedScopes: string[];
  publisherBanned: boolean;
}

export interface RunnerSubmitDeps {
  offlineGrantOn(): Promise<boolean>;
  appBlock(appBlockId: string): Promise<RunnerAppBlockState | null>;
  authorization: ReturnType<typeof runnerMintReads>['authorization'];
}

async function readRunnerAppBlock(appBlockId: string): Promise<RunnerAppBlockState | null> {
  // primary: a takedown or publisher ban moments ago must stop the next run.
  const row = await dbWrite.appBlock.findUnique({
    where: { id: appBlockId },
    select: {
      status: true,
      approvedScopes: true,
      app: { select: { user: { select: { bannedAt: true } } } },
      appListing: { select: { kind: true, user: { select: { bannedAt: true } } } },
    },
  });
  if (!row) return null;
  // The canonical owner, as `canonicallyOwnedAppBlock` defines it: an off-site listing's owner,
  // else the app client's.
  const owner =
    row.appListing && row.appListing.kind !== 'onsite' ? row.appListing.user : row.app.user;
  return {
    status: row.status,
    approvedScopes: row.approvedScopes,
    publisherBanned: owner.bannedAt != null,
  };
}

const liveDeps: RunnerSubmitDeps = {
  offlineGrantOn: () => isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT),
  appBlock: readRunnerAppBlock,
  authorization: async (id) => {
    const { kyselyWrite } = await import('~/server/db/kyselyDb');
    return runnerMintReads(kyselyWrite).authorization(id);
  },
};

/** Refuse a runner submit: FORBIDDEN, logged with the run and a reason code. */
export function refuseRunnerSubmit(
  runId: string | undefined,
  reason: RunnerSubmitRefusal | RunnerReserveRefusal
): never {
  logToAxiom({
    name: 'runner-submit',
    type: 'info',
    payload: { outcome: 'refused', reason, runId },
  });
  throw new TRPCError({ code: 'FORBIDDEN', message: `runner submit refused: ${reason}` });
}

/**
 * The checks a runner token's submit runs before any spend, beyond what the mint checked: the
 * token may be up to its lifetime old, so the flag, the app block's approval and approved scopes,
 * its publisher and the run authorization are read again. The consent, cap, binding and
 * authorization rules are re-checked under the ledger lock when the attempt is reserved.
 */
export async function prepareRunnerSubmit(
  input: {
    claims: BlockTokenClaims;
    bodyKind: string;
    idempotencyKey: string | undefined;
    runnerSlots: RunnerSlot[] | undefined;
  },
  deps: RunnerSubmitDeps = liveDeps
): Promise<RunnerSubmit> {
  const { claims } = input;
  const runId = claims.runId;
  const refuse: (reason: RunnerSubmitRefusal) => never = (reason) =>
    refuseRunnerSubmit(runId, reason);

  if (input.bodyKind !== 'customComfy') refuse('kind');
  if (!runId || input.idempotencyKey !== runId) refuse('idempotency');
  const clientId = claims.blockInstanceId.startsWith('rbi_')
    ? claims.blockInstanceId.slice('rbi_'.length)
    : '';
  if (!claims.authorizationId || !claims.runKey || !clientId) refuse('claims');

  if (!(await deps.offlineGrantOn())) refuse('offline_flag');

  const appBlock = await deps.appBlock(claims.appBlockId);
  if (!appBlock || appBlock.status !== 'approved') refuse('app_block');
  if (!appBlock.approvedScopes.includes(CONSENT_SPEND_SCOPE)) refuse('approved_scopes');
  if (appBlock.publisherBanned) refuse('publisher_banned');

  const auth = await deps.authorization(claims.authorizationId!);
  if (!auth || auth.revokedAt != null || auth.runnerClientId !== clientId) refuse('authorization');

  return {
    runId: runId!,
    authorizationId: claims.authorizationId!,
    runKey: claims.runKey!,
    clientId,
    slots: input.runnerSlots ?? [],
    authorized: { recipeVersionHash: auth!.recipeVersionHash, paramsHash: auth!.paramsHash },
    attemptId: null,
  };
}

/**
 * Use the token's `jti` once. False: already used (a replay). Throws when Redis cannot answer;
 * the caller refuses. An eviction reopens the window for that one token only, and the attempt
 * ledger still allows one live attempt per run.
 */
export async function claimRunnerSubmitJti(jti: string): Promise<boolean> {
  const key = `${REDIS_KEYS.BLOCKS.RUNNER_SUBMIT_JTI}:${jti}` as const;
  // Past the token's lifetime: the verifier still accepts it within its clock tolerance.
  const set = await redis.set(key, '1', { NX: true, EX: RUNNER_TOKEN_LIFETIME_SECONDS + 60 });
  return set !== null;
}
