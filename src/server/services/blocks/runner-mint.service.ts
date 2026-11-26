import { createHash } from 'node:crypto';
import { SIMPLE_BUZZ_LIMIT_PERIOD_DAYS, SIMPLE_BUZZ_LIMIT_PERIODS } from '@civitai/auth/buzz-limit';
import type { RunnerAppBlockRow, RunnerMintReads } from '@civitai/db-queries/recipe-runner';
import { constants } from '~/server/common/constants';
import { DEVICE_CODE_GRANT } from '~/server/services/blocks/connect-agent-review.logic';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** `OauthClient.userId` of a Civitai-owned (system) client. */
export const SYSTEM_CLIENT_OWNER_ID = constants.system.user.id;
/** The exact scope a runner client's access token carries. */
export const RUNNER_TOKEN_SCOPE = TokenScope.RunnerMint | TokenScope.UserRead;

export type RunnerPeriod = (typeof SIMPLE_BUZZ_LIMIT_PERIODS)[number];

function isPeriod(v: unknown): v is RunnerPeriod {
  return (SIMPLE_BUZZ_LIMIT_PERIODS as readonly unknown[]).includes(v);
}

export function periodStart(period: RunnerPeriod, now: Date): Date {
  return new Date(now.getTime() - SIMPLE_BUZZ_LIMIT_PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
}

/** A standing authorization's run id: a replayed trigger is the same run. */
export function standingRunId(authorizationId: string, triggerId: string): string {
  return `run_${createHash('sha256')
    .update(`${authorizationId}\u0000${triggerId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export type RunnerMintRefusal =
  | 'scope'
  | 'client'
  | 'binding'
  | 'app_block'
  | 'consent'
  | 'cap'
  | 'authorization'
  | 'run_live'
  | 'amount'
  | 'runs_per_period';

export interface RunnerMintRequest {
  authorizationId: string;
  /** A `single` authorization's run id, or a `standing` authorization's trigger id. */
  runKey: string;
  /** What this run's submit will reserve. */
  amount: number;
}

export interface RunnerMintGrant {
  runId: string;
  authorizationId: string;
  appBlock: RunnerAppBlockRow;
  buzzBudget: number;
}

export type RunnerMintDecision =
  | { ok: true; grant: RunnerMintGrant }
  | { ok: false; refusal: RunnerMintRefusal };

/**
 * The client may hold runner tokens at all: Civitai-owned, confidential, consented, no device
 * flow, and open (a disabled or testers-only client mints nothing).
 */
export function isRunnerClient(client: Awaited<ReturnType<RunnerMintReads['client']>>): boolean {
  return (
    client != null &&
    client.userId === SYSTEM_CLIENT_OWNER_ID &&
    client.isConfidential === true &&
    client.skipConsent === false &&
    !client.grants.includes(DEVICE_CODE_GRANT) &&
    client.accessMode === 'open'
  );
}

/**
 * Whether a recipe runner may mint a block token for one run of a user who granted it offline
 * access, and with what budget. Every check fails closed. The ledger peek here is advisory and
 * reserves nothing; the submit path has to be the authority on budget.
 */
export async function decideRunnerMint(
  input: {
    userId: number;
    clientId: string;
    tokenScope: bigint;
    request: RunnerMintRequest;
    now: Date;
  },
  reads: RunnerMintReads
): Promise<RunnerMintDecision> {
  const refuse = (refusal: RunnerMintRefusal): RunnerMintDecision => ({ ok: false, refusal });
  const { userId, clientId, request, now } = input;

  if (input.tokenScope !== RUNNER_TOKEN_SCOPE) return refuse('scope');
  if (!isRunnerClient(await reads.client(clientId))) return refuse('client');

  const binding = await reads.binding(clientId);
  if (!binding || binding.status !== 'active') return refuse('binding');
  const appBlock = await reads.appBlock(binding.appBlockId);
  if (!appBlock || appBlock.status !== 'approved') return refuse('app_block');

  const consent = await reads.consent(userId, clientId);
  if (!consent || consent.offlineGrantedAt == null) return refuse('consent');
  const cap = consent.offlineBuzzLimit;
  const capPeriod = consent.offlineBuzzPeriod;
  if (typeof cap !== 'number' || !(cap > 0) || !isPeriod(capPeriod)) return refuse('cap');

  const auth = await reads.authorization(request.authorizationId);
  if (
    !auth ||
    auth.userId !== userId ||
    auth.runnerClientId !== clientId ||
    auth.revokedAt != null ||
    // Made under an earlier offline grant: a withdrawn and re-given grant starts clean.
    auth.createdAt.getTime() < consent.offlineGrantedAt.getTime() ||
    !(auth.expiresAt.getTime() > now.getTime())
  ) {
    return refuse('authorization');
  }
  let runId: string;
  if (auth.kind === 'single') {
    if (auth.runId == null || auth.runId !== request.runKey) return refuse('authorization');
    runId = auth.runId;
  } else if (auth.kind === 'standing') {
    if (auth.maxRunsPerPeriod == null || !isPeriod(auth.period)) return refuse('authorization');
    runId = standingRunId(auth.id, request.runKey);
  } else {
    return refuse('authorization');
  }

  if (!Number.isSafeInteger(request.amount) || request.amount <= 0) return refuse('amount');
  if (request.amount > auth.maxAmountPerRun) return refuse('amount');

  if (await reads.hasLiveAttempt(runId)) return refuse('run_live');

  const headroom = cap - (await reads.capUsed(userId, clientId, periodStart(capPeriod, now)));
  if (request.amount > headroom) return refuse('cap');

  if (auth.kind === 'standing' && isPeriod(auth.period) && auth.maxRunsPerPeriod != null) {
    const runs = await reads.runsSince(auth.id, periodStart(auth.period, now));
    if (runs >= auth.maxRunsPerPeriod) return refuse('runs_per_period');
  }

  return {
    ok: true,
    grant: {
      runId,
      authorizationId: auth.id,
      appBlock,
      buzzBudget: request.amount,
    },
  };
}
