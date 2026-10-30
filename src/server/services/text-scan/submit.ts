import type { ChatCompletionStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { hashContent } from '~/server/services/entity-moderation.service';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import {
  getTextScanMode,
  getTextScanWebSearchMode,
  TEXT_SCAN_WEB_SEARCH_LABELS,
  textScanEmEntityType,
  type TextScanVariant,
} from '~/server/services/text-scan/mode';
import {
  getTextScanProfile,
  resolveTextScanProfileLabels,
} from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
  MissingTextScanPromptError,
  subjectTextLength,
  textScanTextHash,
} from '~/server/services/text-scan/prompt';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import {
  bindTextScanWorkflowId,
  markTextScanPending,
  markTextScanSubmitFailed,
  recordTextScanSuccess,
} from '~/server/services/text-scan/record';
import { buildTextScanResponseFormat } from '~/server/services/text-scan/schema';
import type {
  PromptIds,
  TextScanEntityType,
  TextScanLabel,
  TextScanMode,
  TextScanOutput,
  TextScanSubject,
} from '~/server/services/text-scan/types';

export const TEXT_SCAN_CALLBACK_PATH = '/api/webhooks/text-scan-result';
const MAX_OUTPUT_TOKENS = 1024;
// Same window as the retry cron's stuck-Pending timeout (text-moderation-retry.ts).
const IN_FLIGHT_MINUTES = 30;
const BACKGROUND_SCAN_CONCURRENCY = 5;
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
        | 'not-public'
        | 'too-short'
        | 'unchanged'
        | 'in-flight'
        | 'missing-prompt';
    }
  | { status: 'submitted'; workflowId: string }
  | { status: 'failed' };

/** Segment 0 keeps the pre-segmentation step name. */
export function textScanStepName(segment: number) {
  return segment === 0 ? 'textScan' : `textScan${segment}`;
}

export function buildTextScanStep({
  system,
  user,
  model,
  labels,
  thinking,
  segment,
  webSearch = false,
}: {
  system: string;
  user: string;
  model: string;
  labels: TextScanLabel[];
  thinking: boolean;
  segment?: number;
  webSearch?: boolean;
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
    // Auto tool choice: the model decides whether a name needs looking up.
    ...(webSearch ? { tools: [{ type: 'civitai:web_search' }] } : {}),
  };
  return {
    $type: 'chatCompletion',
    name: textScanStepName(segment ?? 0),
    ...(segment === undefined ? {} : { metadata: { segment } }),
    input,
  } as ChatCompletionStepTemplate;
}

export function buildTextScanSteps({
  system,
  segments,
  model,
  labels,
  thinking,
  webSearch = false,
}: {
  system: string;
  segments: string[];
  model: string;
  labels: TextScanLabel[];
  thinking: boolean;
  webSearch?: boolean;
}) {
  if (segments.length === 1)
    return [buildTextScanStep({ system, user: segments[0], model, labels, thinking, webSearch })];
  return segments.map((user, segment) =>
    buildTextScanStep({ system, user, model, labels, thinking, webSearch, segment })
  );
}

export function textScanContentHash({
  user,
  promptIds,
  model,
  thinking,
  variant,
  segmentBudget,
}: {
  user: string;
  promptIds: PromptIds;
  model: string;
  thinking: boolean;
  variant?: TextScanVariant;
  segmentBudget?: { maxInputChars: number; maxSegments: number };
}) {
  const ids = Object.keys(promptIds)
    .sort()
    .map((key) => `${key}=${promptIds[key]}`)
    .join(',');
  const tail = variant ? `\u0000${variant}` : '';
  // Only text over the budget is split, so only its hash may change with the budget: a shorter
  // text keeps its hash and is not rescanned when the budget changes.
  const segmenting =
    segmentBudget && user.length > segmentBudget.maxInputChars
      ? `\u0000segments=${segmentBudget.maxInputChars}x${segmentBudget.maxSegments}`
      : '';
  return hashContent(
    `${user}\u0000${ids}\u0000${model}\u0000thinking=${thinking}${tail}${segmenting}`
  );
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

const CSAM_PROMPT_KEY = 'label:csam';
const csamShadowDropLogged = new Set<string>();

function logCsamShadowDrop(entityType: TextScanEntityType) {
  if (csamShadowDropLogged.has(entityType)) return;
  csamShadowDropLogged.add(entityType);
  logToAxiom({
    name: 'text-scan',
    type: 'info',
    message: 'csam not requested for shadow scans',
    entityType,
  }).catch(() => null);
}

const NO_TEXT_REASON = 'No text left to scan.';

// Text removed below the minimum is never submitted, so without this a verdict on the old text
// would keep raising the rating (or keep a scam flag) with nothing left to justify it.
async function clearStaleVerdict({
  entityType,
  entityId,
  pass: { mode, labels, variant },
  subject,
}: {
  entityType: TextScanEntityType;
  entityId: number;
  pass: TextScanPass;
  subject: TextScanSubject;
}) {
  const emEntityType = textScanEmEntityType(entityType, mode, variant);
  const existing = await dbWrite.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: emEntityType, entityId } },
    select: {
      workflowId: true,
      status: true,
      nsfwLevel: true,
      triggeredLabels: true,
      result: true,
    },
  });
  if (!existing?.workflowId || existing.status !== 'Succeeded') return;
  if ((existing.result as { version?: number } | null)?.version === undefined) return;
  if ((existing.nsfwLevel ?? 0) <= 1 && !existing.triggeredLabels.length) return;

  const output: TextScanOutput = {};
  for (const label of labels) {
    if (label === 'nsfw') output.nsfw = { level: 'none', reason: NO_TEXT_REASON };
    else if (label === 'poi') output.poi = { detected: false, names: [], reason: NO_TEXT_REASON };
    else output[label] = { detected: false, reason: NO_TEXT_REASON };
  }
  const outcome = evaluateTextScan(output, subject.declared, labels);
  const textHash = textScanTextHash(subject);
  const recorded = await recordTextScanSuccess({
    entityType: emEntityType,
    entityId,
    workflowId: existing.workflowId,
    outcome,
    output,
    promptIds: {},
    model: 'none',
    textHash,
    meta: subject.meta,
  });
  if (!recorded || mode !== 'active') return;

  // Imported here: moderation-adapters reaches this module through the text-scan adapter.
  const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
  await getModerationAdapter(entityType)?.applyTextScan?.({
    entityId,
    workflowId: existing.workflowId,
    outcome,
    subject,
    textHash,
  });
}

export type TextScanPass = {
  mode: Exclude<TextScanMode, 'off'>;
  labels: TextScanLabel[];
  variant?: TextScanVariant;
};

/**
 * The main pass, plus the web-search pass when its rollout covers the entity. In shadow the search
 * pass only duplicates poi/minor; in active it owns them, so the main pass stops asking for them.
 */
export function planTextScanPasses(
  labels: TextScanLabel[],
  mode: Exclude<TextScanMode, 'off'>,
  searchMode: TextScanMode
): TextScanPass[] {
  const isSearchLabel = (label: TextScanLabel) =>
    (TEXT_SCAN_WEB_SEARCH_LABELS as readonly TextScanLabel[]).includes(label);
  const searchLabels = labels.filter(isSearchLabel);
  if (searchMode === 'off' || !searchLabels.length) return [{ mode, labels }];
  const mainLabels = searchMode === 'active' ? labels.filter((l) => !isSearchLabel(l)) : labels;
  return [
    ...(mainLabels.length ? [{ mode, labels: mainLabels }] : []),
    { mode: searchMode, labels: searchLabels, variant: 'web-search' as const },
  ];
}

export async function scanEntity({
  entityType,
  entityId,
  force = false,
  fromRetry = false,
  pass: only,
}: {
  entityType: TextScanEntityType;
  entityId: number;
  force?: boolean;
  /** The retry cron already judged this row's Pending state as timed out. */
  fromRetry?: boolean;
  /** One pass only, for the retry cron's per-row adapters; both run when omitted. */
  pass?: 'main' | 'web-search';
}): Promise<ScanEntityResult> {
  const mode = await getTextScanMode(entityType, entityId);
  if (mode === 'off') return { status: 'skipped', reason: 'off' };
  const searchMode = await getTextScanWebSearchMode(entityType, entityId, mode);
  if (only === 'web-search' && searchMode === 'off') return { status: 'skipped', reason: 'off' };

  const profile = getTextScanProfile(entityType);
  if (!profile) return { status: 'skipped', reason: 'no-profile' };

  const planPasses = (labels: TextScanLabel[]) =>
    labels.length
      ? planTextScanPasses(labels, mode, searchMode).filter(
          (p) => !only || (only === 'web-search') === (p.variant === 'web-search')
        )
      : [];
  // Only an active verdict reaches the adapter that records a csam hold, so a shadow one is unread.
  const resolveLabels = async (subject?: TextScanSubject) => {
    const resolved = await resolveTextScanProfileLabels(profile, subject);
    if (mode !== 'shadow' || !resolved.includes('csam')) return resolved;
    logCsamShadowDrop(entityType);
    return resolved.filter((label) => label !== 'csam');
  };
  const gatedPasses = planPasses(await resolveLabels());
  if (!gatedPasses.length) return { status: 'skipped', reason: 'off' };

  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return { status: 'skipped', reason: 'missing' };
  if (subject.notPublic) return { status: 'skipped', reason: 'not-public' };

  let labels = await resolveLabels(subject);
  let passes = planPasses(labels);
  if (!passes.length) return { status: 'skipped', reason: 'off' };
  if (subjectTextLength(subject) < (profile.minChars ?? 1)) {
    // Every gated label, not just the narrowed ones: an earlier verdict may carry a dropped label.
    for (const pass of gatedPasses)
      await clearStaleVerdict({ entityType, entityId, pass, subject });
    return { status: 'skipped', reason: 'too-short' };
  }

  const [config, prompts] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  // The csam gate can open before its prompt exists; that must not stop the other labels.
  if (labels.includes('csam') && !prompts[CSAM_PROMPT_KEY]?.content?.trim()) {
    await logMissingPrompts({ entityType, entityId, keys: [CSAM_PROMPT_KEY] }).catch(() => null);
    labels = labels.filter((label) => label !== 'csam');
    passes = planPasses(labels);
    if (!passes.length) return { status: 'skipped', reason: 'off' };
  }
  const ctx = { entityType, entityId, subject, config, prompts, force };

  const [first, ...rest] = passes;
  const result = await submitTextScanPass({ ...ctx, fromRetry, pass: first });
  for (const pass of rest) {
    // The retry cron judged only the main row stuck; the search row has its own adapter.
    // The main verdict is already submitted; a search-pass error must not report it as failed.
    await submitTextScanPass({ ...ctx, fromRetry: false, pass }).catch((e) =>
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'web-search pass threw',
        entityType,
        entityId,
        error: (e as Error).message,
      })
    );
  }
  return result;
}

async function submitTextScanPass({
  entityType,
  entityId,
  subject,
  config,
  prompts,
  force,
  fromRetry,
  pass: { mode, labels, variant },
}: {
  entityType: TextScanEntityType;
  entityId: number;
  subject: TextScanSubject;
  config: Awaited<ReturnType<typeof getTextScanConfig>>;
  prompts: Awaited<ReturnType<typeof getActiveTextScanPrompts>>;
  force: boolean;
  fromRetry: boolean;
  pass: TextScanPass;
}): Promise<ScanEntityResult> {
  let composed: ReturnType<typeof composeTextScanMessages>;
  try {
    composed = composeTextScanMessages({
      prompts,
      labels,
      subject,
      maxInputChars: config.maxInputChars,
      maxSegments: config.maxSegments,
    });
  } catch (e) {
    if (!(e instanceof MissingTextScanPromptError)) throw e;
    await logMissingPrompts({ entityType, entityId, keys: e.keys });
    return { status: 'skipped', reason: 'missing-prompt' };
  }
  // A profile with minChars 0 would otherwise submit an empty step.
  if (!composed.text.trim()) {
    await clearStaleVerdict({ entityType, entityId, pass: { mode, labels, variant }, subject });
    return { status: 'skipped', reason: 'too-short' };
  }

  const contentHash = textScanContentHash({
    user: composed.text,
    promptIds: composed.promptIds,
    model: config.model,
    thinking: config.thinking,
    variant,
    segmentBudget: config,
  });

  const emEntityType = textScanEmEntityType(entityType, mode, variant);
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
    ...(variant ? { variant } : {}),
    externalId,
    labels,
    promptIds: composed.promptIds,
    model: config.model,
    thinking: config.thinking,
    textHash: textScanTextHash(subject),
    inputChars: composed.inputChars,
    inputCut: composed.inputCut,
    segments: composed.segments.length,
    scannedChars: composed.scannedChars,
    ...(subject.meta ? { subjectMeta: subject.meta } : {}),
  };

  // Before submit: a content-cache hit can call back before submitWorkflow returns.
  await markTextScanPending({
    entityType: emEntityType,
    entityId,
    marker: externalId,
    contentHash,
    rearmRetries: !fromRetry,
  });

  let workflowId: string | undefined;
  let error: unknown;
  try {
    const { data, error: submitError } = await submitWorkflow({
      client: internalOrchestratorClient,
      body: {
        metadata,
        tags: ['text-scan', entityType, mode, ...(variant ? [variant] : [])],
        externalId,
        currencies: [],
        steps: buildTextScanSteps({
          system: composed.system,
          segments: composed.segments,
          model: config.model,
          labels,
          thinking: config.thinking,
          webSearch: variant === 'web-search',
        }),
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
      ...(variant ? { variant } : {}),
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
    ...(variant ? { variant } : {}),
    workflowId,
    segments: composed.segments.length,
  }).catch(() => null);
  return { status: 'submitted', workflowId };
}

type BackgroundScanArgs = { entityType: TextScanEntityType; entityId: number; force?: boolean };

function scanEntityOrLog(args: BackgroundScanArgs) {
  return scanEntity(args).catch((e) =>
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

export function scanEntityInBackground(args: BackgroundScanArgs) {
  scanEntityOrLog(args).catch(() => null);
}

// A publish can date every post on a model at once.
export function scanEntitiesInBackground(entityType: TextScanEntityType, entityIds: number[]) {
  limitConcurrency(
    entityIds.map((entityId) => () => scanEntityOrLog({ entityType, entityId })),
    BACKGROUND_SCAN_CONCURRENCY
  ).catch(() => null);
}

/**
 * The one place a public model's rules are checked after its text changed. Callers decide who is
 * checked (moderator edits are not); the check skips a model that is not public.
 */
export function checkModelRulesInBackground(modelId: number) {
  // Imported here: the action reaches model-version.service, which imports this module.
  import('~/server/services/text-scan/actions/model-rules')
    .then(({ checkModelRulesOnEdit }) => checkModelRulesOnEdit(modelId))
    .catch((error) =>
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'model rules edit check failed',
        entityType: 'ModelRules',
        entityId: modelId,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    );
}

/** Every Model scan trigger also checks the rules; both skip a model that is not public. */
export function scanModelAndRules(modelId: number, { rules = true }: { rules?: boolean } = {}) {
  scanEntityInBackground({ entityType: 'Model', entityId: modelId });
  if (rules) checkModelRulesInBackground(modelId);
}
