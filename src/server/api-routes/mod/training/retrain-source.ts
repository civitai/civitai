import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { getWorkflow, headBlob, submitWorkflow } from '@civitai/orchestration-client';
import { env } from '~/env/server';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflowCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { trainingStepModelRefusal } from '~/server/services/blocks/block-training-model-check';
import { getFeatureFlagsAsync, isFliptDecisive } from '~/server/services/feature-flags.service';
import { assertTrainingLicenseAccepted } from '~/server/services/generation-license.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { blobKeyFromAir } from '~/server/services/orchestrator/training/studio-dataset-archive.service';
import { studioWithheldWorkflowIds } from '~/server/services/orchestrator/training/studio-withheld';
import {
  RETRAIN_HARD_STOP,
  RETRAIN_SOURCE_ID,
  RetrainUnavailableError,
  retrainSourceHandler,
  type OrchestratorAnswer,
  type OwnerOrchestrator,
  type RetrainDeps,
} from '~/server/services/orchestrator/training/training-retrain';
import { assertTrainingTriggerWordAllowed } from '~/server/services/orchestrator/training/training-trigger-word-check';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { getTrainingLicenseTerms } from '~/shared/constants/generation-license.constants';
import type { SessionUser } from '~/types/session';

async function answer(
  call: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>
): Promise<OrchestratorAnswer> {
  try {
    const { data, error, response } = await call();
    const status = response?.status ?? 0;
    if (data && response?.ok) return { status, workflow: data as OrchestratorAnswer['workflow'] };
    const detail = (error as { detail?: unknown; title?: unknown } | undefined) ?? {};
    const message = typeof detail.detail === 'string' ? detail.detail : detail.title;
    return { status, ...(typeof message === 'string' ? { error: message } : {}) };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

async function ownerOrchestrator(userId: number): Promise<OwnerOrchestrator | null> {
  let token: string;
  try {
    // Not the cached token: this is a moderator acting for another account.
    token = await getOrchestratorToken(userId, undefined, { bypassCache: true });
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'FORBIDDEN') return null;
    throw e;
  }
  const client = createOrchestratorClient(token);
  return {
    read: (workflowId) => answer(() => getWorkflow({ client, path: { workflowId } })),
    quote: (body) => answer(() => submitWorkflow({ client, body, query: { whatif: true } })),
    submit: (body) => answer(() => submitWorkflow({ client, body })),
    blobNsfwLevel: async (air) => {
      const { response } = await headBlob({ client, path: { blobId: blobKeyFromAir(air) } });
      if (!response?.ok) return null;
      return response.headers.get('x-nsfw-level') ?? '';
    },
  };
}

async function forceRefund(workflowId: string): Promise<number> {
  try {
    const response = await outboundFetch(
      `${env.ORCHESTRATOR_ENDPOINT}/v1/manager/workflows/${encodeURIComponent(workflowId)}/refund`,
      {
        timeoutMs: 30_000,
        method: 'POST',
        headers: { Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}` },
      }
    );
    return response.status;
  } catch {
    return 0;
  }
}

/** The owner's Studio Kohya flag, decided by Flipt on the owner's own session. */
async function studioKohyaFor(userId: number): Promise<boolean> {
  const { sessionClient } = await import('~/server/auth/session-client');
  const user = (await sessionClient
    .getSessionUserById(userId)
    .catch(() => null)) as SessionUser | null;
  if (!user) throw new RetrainUnavailableError('the owner’s session could not be read');
  if (!(await isFliptDecisive(['trainingStudioKohya'], user)))
    throw new RetrainUnavailableError('the Kohya flag could not be decided for the owner');
  return (await getFeatureFlagsAsync({ user })).trainingStudioKohya;
}

/** A refusal's message, or null when the check passed; any other error is not a refusal. */
async function refusalOf(code: TRPCError['code'], check: () => Promise<void>) {
  try {
    await check();
    return null;
  } catch (e) {
    if (e instanceof TRPCError && e.code === code) return e.message;
    throw e;
  }
}

const deps: RetrainDeps = {
  now: () => new Date(),
  readAllowlist: async (sourceWorkflowId) => {
    const value = await redis.hGet<string | Buffer>(
      REDIS_KEYS.TRAINING.RETRAIN_ALLOWLIST,
      sourceWorkflowId
    );
    return value === null ? null : value.toString();
  },
  // HSET keeps the key's expiry, which the operator set when writing the allowlist.
  markRetrained: async (sourceWorkflowId, marker) => {
    await redis.hSet(REDIS_KEYS.TRAINING.RETRAIN_ALLOWLIST, sourceWorkflowId, marker);
  },
  ownerOrchestrator,
  forceRefund,
  callbacksFor: getWorkflowCallbacks,
  gates: {
    withheld: async (userId, sourceWorkflowId) =>
      (await studioWithheldWorkflowIds(userId, [sourceWorkflowId])).length > 0,
    training: async (modelAir) =>
      trainingStepModelRefusal(
        [{ engine: ['kohya'], ecosystem: [], modelVariant: [], model: [modelAir] }],
        await getTrainingServiceStatus()
      ),
    studioKohya: studioKohyaFor,
    triggerWord: (userId, triggerWord) =>
      refusalOf('BAD_REQUEST', () =>
        assertTrainingTriggerWordAllowed({
          triggerWord,
          log: { userId, source: 'training-retrain' },
        })
      ),
    license: async (userId, ecosystem) =>
      getTrainingLicenseTerms(ecosystem)
        ? refusalOf('FORBIDDEN', () => assertTrainingLicenseAccepted({ ecosystem, userId }))
        : null,
  },
};

export default defineModeratorEndpoint('training.retrainSource', {
  summary:
    'Refund one allowlisted training run and, in retrain mode, submit the same run again on its owner’s Buzz at low priority. One run per call.',
  returns:
    "{ sourceWorkflowId, userId, mode: 'retrain' | 'refund-only' | null, execute, outcome: 'would-retrain' | 'would-refund' | 'retrained' | 'already-retrained' | 'refunded' | 'already-refunded' | 'refund-unconfirmed' | 'refunded-not-submitted' | 'bad-submit-result' | 'skipped', reason?, detail?, warnings, refundNetByColour?, confirmedNetByColour?, grossDebits?, quote?, body?, bodySha256?, retrain?: { id, status, chargedByColour } }",
  notes: [
    'Requires the moderator app permission `training.retrain`.',
    'Dry run unless `execute=true`. The dry run runs every check and the quote, and returns the body execute would submit with its sha256.',
    'The input is the source workflow id only: the body is built from the source run, never from the request.',
    'Only ids in the Redis allowlist hash (`REDIS_KEYS.TRAINING.RETRAIN_ALLOWLIST`) are acted on, each with its mode (`retrain` or `refund-only`). The caller cannot choose the mode. An allowlist read that fails refuses the call; deleting the allowlist refuses every call.',
    `Every call is refused from ${RETRAIN_HARD_STOP.toISOString()}.`,
    'Before any money moves: the owner must be issued a token; the source must be a one-step Kohya run in the bug window, Succeeded (or already force-refunded); and in retrain mode no moderator action may withhold the source’s outputs (`source-withheld`), and the training service, the Studio Kohya flag for the owner (Studio runs only), the trigger word, the licence, the Green-mature rule and the quote (at most what the source charged) must all pass.',
    'Execute: `/refund` (up to 3 tries), then the source is read back and must net 0 in every colour (`refund-unconfirmed` otherwise, and nothing is submitted). Then the submit (up to 3 tries) under externalId `retrain-<source>`, so a repeat returns the first retrain (`already-retrained`) instead of charging again.',
    'After a retrain the source’s allowlist value becomes `retrained:<retrain id>`, and every later call is skipped with reason `already-retrained-marked`, reporting that retrain and its status, without a refund or a submit. If that value cannot be written (3 tries) the outcome is `retrained-unmarked`: record the retrain by hand and never execute that source again. Add fields to the allowlist; never replace the key, which would drop the markers. Resuming `refund-unconfirmed` or `refunded-not-submitted` is safe: a source that already nets 0 is not refunded again.',
    'Audit row `affected`: the source, owner, mode, outcome, reason, the nets before and after, the quote, the body sha256 and the retrain id.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    sourceWorkflowId: z.string().trim().regex(RETRAIN_SOURCE_ID, 'not a workflow id'),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    const result = await retrainSourceHandler(input, {
      holdsGrant: () => hasModeratorGrant(ctx.actor, 'training.retrain'),
      deps,
    });
    return {
      ...result,
      affected: {
        workflowIds: [input.sourceWorkflowId, ...(result.retrain ? [result.retrain.id] : [])],
        userIds: result.userId === null ? [] : [result.userId],
        execute: input.execute,
        mode: result.mode,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        warnings: result.warnings,
        refundNetByColour: result.refundNetByColour,
        confirmedNetByColour: result.confirmedNetByColour,
        quote: result.quote,
        bodySha256: result.bodySha256,
        retrainWorkflowId: result.retrain?.id,
      },
    };
  },
});
