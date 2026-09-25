import type { ChatCompletionStepTemplate } from '@civitai/client';
import { submitWorkflow } from '@civitai/client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { getTextScanMode, textScanEmEntityType } from '~/server/services/text-scan/mode';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
  MissingTextScanPromptError,
  subjectTextLength,
  textScanTextHash,
} from '~/server/services/text-scan/prompt';
import {
  bindTextScanWorkflowId,
  markTextScanPending,
  markTextScanSubmitFailed,
} from '~/server/services/text-scan/record';
import { buildTextScanResponseFormat } from '~/server/services/text-scan/schema';
import type {
  PromptIds,
  TextScanEntityType,
  TextScanLabel,
} from '~/server/services/text-scan/types';

export const TEXT_SCAN_CALLBACK_PATH = '/api/webhooks/text-scan-result';
const MAX_OUTPUT_TOKENS = 1024;
// Same window as the retry cron's stuck-Pending timeout (text-moderation-retry.ts).
const IN_FLIGHT_MINUTES = 30;
const MISSING_PROMPT_LOG_SECONDS = 15 * 60;

export function textScanCallbackUrl() {
  // `||`, not `??`: an unset override arrives from a ConfigMap as ''.
  return (
    env.TEXT_SCAN_CALLBACK ||
    `${env.NEXTAUTH_URL}${TEXT_SCAN_CALLBACK_PATH}?token=${env.WEBHOOK_TOKEN}`
  );
}

export type ScanEntityResult =
  | {
      status: 'skipped';
      reason:
        | 'off'
        | 'no-profile'
        | 'missing'
        | 'too-short'
        | 'unchanged'
        | 'in-flight'
        | 'missing-prompt';
    }
  | { status: 'submitted'; workflowId: string }
  | { status: 'failed' };

export function buildTextScanStep({
  system,
  user,
  model,
  labels,
  thinking,
}: {
  system: string;
  user: string;
  model: string;
  labels: TextScanLabel[];
  thinking: boolean;
}) {
  // The generated ChatCompletionMessage type declares only `role`; content is untyped upstream.
  const input: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    chatTemplateKwargs: { enable_thinking: thinking },
    responseFormat: buildTextScanResponseFormat(labels),
  };
  return { $type: 'chatCompletion', name: 'textScan', input } as ChatCompletionStepTemplate;
}

export function textScanContentHash({
  user,
  promptIds,
  model,
  thinking,
}: {
  user: string;
  promptIds: PromptIds;
  model: string;
  thinking: boolean;
}) {
  const ids = Object.keys(promptIds)
    .sort()
    .map((key) => `${key}=${promptIds[key]}`)
    .join(',');
  return hashContent(`${user}\u0000${ids}\u0000${model}\u0000thinking=${thinking}`);
}

export function textScanExternalId({
  entityType,
  entityId,
  contentHash,
  attempt,
}: {
  entityType: string;
  entityId: number;
  contentHash: string;
  attempt: string;
}) {
  return `ts-${entityType.replace(':', '_')}-${entityId}-${contentHash.slice(0, 24)}-${attempt}`;
}

async function logMissingPrompts(ctx: { entityType: string; entityId: number; keys: string[] }) {
  const unlogged: string[] = [];
  for (const key of ctx.keys) {
    const first = await redis
      .set(`${REDIS_KEYS.TEXT_SCAN.MISSING_PROMPT_LOGGED}:${key}`, '1', {
        NX: true,
        EX: MISSING_PROMPT_LOG_SECONDS,
      })
      // Fail closed: during a Redis outage every scan would otherwise log.
      .catch(() => null);
    if (first) unlogged.push(key);
  }
  if (!unlogged.length) return;
  await logToAxiom({
    name: 'text-scan',
    type: 'error',
    message: 'missing prompt rows',
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    missing: unlogged,
  });
}

export async function scanEntity({
  entityType,
  entityId,
  force = false,
  fromRetry = false,
}: {
  entityType: TextScanEntityType;
  entityId: number;
  force?: boolean;
  /** The retry cron already judged this row's Pending state as timed out. */
  fromRetry?: boolean;
}): Promise<ScanEntityResult> {
  const mode = await getTextScanMode(entityType, entityId);
  if (mode === 'off') return { status: 'skipped', reason: 'off' };

  const profile = getTextScanProfile(entityType);
  if (!profile) return { status: 'skipped', reason: 'no-profile' };

  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return { status: 'skipped', reason: 'missing' };
  if (subjectTextLength(subject) < (profile.minChars ?? 1))
    return { status: 'skipped', reason: 'too-short' };

  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);

  let composed: ReturnType<typeof composeTextScanMessages>;
  try {
    composed = composeTextScanMessages({
      prompts,
      labels: profile.labels,
      subject,
      maxInputChars: config.maxInputChars,
    });
  } catch (e) {
    if (!(e instanceof MissingTextScanPromptError)) throw e;
    await logMissingPrompts({ entityType, entityId, keys: e.keys });
    return { status: 'skipped', reason: 'missing-prompt' };
  }

  const contentHash = textScanContentHash({
    user: composed.user,
    promptIds: composed.promptIds,
    model: config.model,
    thinking: config.thinking,
  });

  const emEntityType = textScanEmEntityType(entityType, mode);
  // Primary, not replica: the retry cron bumps retryCount on dbWrite, and a lagging read
  // would rebuild the previous attempt's externalId and get its dead workflow back.
  const existing = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: emEntityType, entityId } },
    select: {
      status: true,
      contentHash: true,
      workflowId: true,
      retryCount: true,
      updatedAt: true,
    },
  });
  if (
    !force &&
    existing?.status === 'Succeeded' &&
    existing.contentHash === contentHash &&
    existing.workflowId
  )
    return { status: 'skipped', reason: 'unchanged' };
  // Each edit save would otherwise bill a second workflow for text already being scanned.
  if (
    !force &&
    !fromRetry &&
    existing?.status === 'Pending' &&
    existing.contentHash === contentHash &&
    Date.now() - existing.updatedAt.getTime() < IN_FLIGHT_MINUTES * 60_000
  )
    return { status: 'skipped', reason: 'in-flight' };

  const externalId = textScanExternalId({
    entityType: emEntityType,
    entityId,
    contentHash,
    attempt: force
      ? `f${Date.now().toString(36)}`
      : `${existing?.retryCount ?? 0}-${
          existing ? existing.updatedAt.getTime().toString(36) : '0'
        }`,
  });

  const metadata = {
    entityType,
    entityId,
    emEntityType,
    mode,
    externalId,
    labels: profile.labels,
    promptIds: composed.promptIds,
    model: config.model,
    thinking: config.thinking,
    textHash: textScanTextHash(subject),
    ...(subject.meta ? { subjectMeta: subject.meta } : {}),
  };

  // Before submit: a content-cache hit can call back before submitWorkflow returns.
  await markTextScanPending({
    entityType: emEntityType,
    entityId,
    marker: externalId,
    contentHash,
  });

  let workflowId: string | undefined;
  let error: unknown;
  try {
    const { data, error: submitError } = await submitWorkflow({
      client: internalOrchestratorClient,
      body: {
        metadata,
        tags: ['text-scan', entityType, mode],
        externalId,
        currencies: [],
        steps: [
          buildTextScanStep({
            system: composed.system,
            user: composed.user,
            model: config.model,
            labels: profile.labels,
            thinking: config.thinking,
          }),
        ],
        callbacks: [
          {
            url: textScanCallbackUrl(),
            type: [
              'workflow:succeeded',
              'workflow:failed',
              'workflow:expired',
              'workflow:canceled',
            ],
          },
        ],
      },
    });
    workflowId = data?.id ?? undefined;
    error = submitError;
  } catch (e) {
    error = e;
  }

  if (!workflowId) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'submit failed',
      entityType,
      entityId,
      error: error instanceof Error ? error.message : error,
    });
    await markTextScanSubmitFailed({ entityType: emEntityType, entityId, marker: externalId });
    return { status: 'failed' };
  }

  await bindTextScanWorkflowId({
    entityType: emEntityType,
    entityId,
    marker: externalId,
    workflowId,
  });
  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'submitted',
    entityType,
    entityId,
    mode,
    workflowId,
  }).catch(() => null);
  return { status: 'submitted', workflowId };
}

export function scanEntityInBackground(args: {
  entityType: TextScanEntityType;
  entityId: number;
  force?: boolean;
}) {
  scanEntity(args).catch((e) =>
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'background scan threw',
      entityType: args.entityType,
      entityId: args.entityId,
      error: (e as Error).message,
    })
  );
}
