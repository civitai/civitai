import { submitWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import { findChatCompletionStep, parseTextScanStep } from '~/server/services/text-scan/parse';
import type { ChatCompletionStepLike } from '~/server/services/text-scan/parse';
import { readTextScanRollouts, textScanEmEntityType } from '~/server/services/text-scan/mode';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import {
  composeTextScanMessages,
  composeUserMessage,
  getActiveTextScanPrompts,
  getTextScanConfig,
  insertTextScanPrompt,
  MissingTextScanPromptError,
  setTextScanConfig,
  setTextScanRollout,
  subjectTextLength,
  TEXT_SCAN_PROMPT_KEY,
} from '~/server/services/text-scan/prompt';
import type { TextScanResult } from '~/server/services/text-scan/record';
import { buildTextScanStep, textScanContentHash } from '~/server/services/text-scan/submit';
import { TEXT_SCAN_LABELS } from '~/server/services/text-scan/types';
import type {
  TextScanDeclared,
  TextScanEntityType,
  TextScanLabel,
  TextScanOutput,
  TextScanProfile,
  TextScanSubject,
} from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const TEXT_SCAN_HARNESS_ACTIONS = [
  'getPrompts',
  'putPrompt',
  'putConfig',
  'putModes',
  'scanEntity',
  'batchEntities',
  'sampleShadow',
  'quoteEntities',
  'composeEntities',
  'scanTexts',
  'quoteTexts',
] as const;

export const isTextScanHarnessAction = (action: unknown) =>
  typeof action === 'string' && (TEXT_SCAN_HARNESS_ACTIONS as readonly string[]).includes(action);

const promptContent = z.string().refine((s) => s.trim().length > 0, 'empty prompt');
const promptOverrides = z.record(z.string().regex(TEXT_SCAN_PROMPT_KEY), promptContent).optional();
const entityType = z
  .string()
  .refine(isTextScanEntityType, 'unknown text-scan entity type')
  .transform((value) => value as TextScanEntityType);
const moderatorId = z.number().int().positive();
export const HARNESS_BUDGET_SECONDS = 120;
const waitSecondsSchema = z.number().int().min(1).max(HARNESS_BUDGET_SECONDS).default(90);

/**
 * Each wave of `concurrency` items can take up to `wait` seconds. Past the budget the caller (and any
 * proxy) times out while the submitted workflows keep running.
 */
function refineTimeBudget(noun: string) {
  return (
    { items, concurrency, wait }: { items: number; concurrency: number; wait: number },
    ctx: z.RefinementCtx
  ) => {
    const worstCase = Math.ceil(items / concurrency) * wait;
    if (worstCase > HARNESS_BUDGET_SECONDS)
      ctx.addIssue({
        code: 'custom',
        path: ['wait'],
        message: `${items} ${noun} at concurrency ${concurrency} and wait ${wait}s could take ${worstCase}s; keep ceil(${noun} / concurrency) * wait within ${HARNESS_BUDGET_SECONDS}s`,
      });
  };
}
const textsWithinBudget = refineTimeBudget('texts');
const entitiesWithinBudget = refineTimeBudget('entities');
/**
 * Sized for real entities, which production composes in full and then truncates to `maxInputChars`:
 * a Model emits up to three fields per version. Mirrored by the moderator lab
 * (apps/moderator/src/lib/text-scan-lab/limits.ts), which checks each text before sending.
 */
export const TEXT_SCAN_HARNESS_LIMITS = {
  textsPerRequest: 50,
  fieldsPerText: 500,
  charsPerText: 200_000,
  charsPerRequest: 1_000_000,
  headingChars: 100,
} as const;
const fieldChars = (fields: { text: string }[]) =>
  fields.reduce((sum, field) => sum + field.text.length, 0);
const texts = z
  .array(
    z.object({
      key: z.string().min(1).max(100),
      fields: z
        .array(
          z.object({
            heading: z.string().min(1).max(TEXT_SCAN_HARNESS_LIMITS.headingChars),
            text: z.string().max(TEXT_SCAN_HARNESS_LIMITS.charsPerText),
          })
        )
        .min(1)
        .max(TEXT_SCAN_HARNESS_LIMITS.fieldsPerText)
        .refine(
          (fields) => fieldChars(fields) <= TEXT_SCAN_HARNESS_LIMITS.charsPerText,
          `a text's fields total more than ${TEXT_SCAN_HARNESS_LIMITS.charsPerText} characters`
        ),
    })
  )
  .min(1)
  .max(TEXT_SCAN_HARNESS_LIMITS.textsPerRequest)
  .refine(
    (texts) =>
      texts.reduce((sum, t) => sum + fieldChars(t.fields), 0) <=
      TEXT_SCAN_HARNESS_LIMITS.charsPerRequest,
    `texts total more than ${TEXT_SCAN_HARNESS_LIMITS.charsPerRequest} characters`
  );

export const textScanHarnessSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('getPrompts'),
    history: z.string().regex(TEXT_SCAN_PROMPT_KEY).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal('putPrompt'),
    key: z.string().regex(TEXT_SCAN_PROMPT_KEY),
    content: promptContent,
    note: z.string().min(1),
    createdById: moderatorId.optional(),
  }),
  z.object({
    action: z.literal('putConfig'),
    moderatorId: moderatorId.optional(),
    config: z
      .strictObject({
        model: z.string().min(1).optional(),
        maxInputChars: z.number().int().positive().optional(),
        thinking: z.boolean().optional(),
      })
      .refine((c) => Object.keys(c).length > 0, 'empty config patch'),
  }),
  z.object({
    action: z.literal('putModes'),
    moderatorId: moderatorId.optional(),
    entityType,
    /** `null` turns the entity type off. */
    rollout: z
      .strictObject({
        shadow: z.number().int().min(0).max(100),
        active: z.number().int().min(0).max(100).default(0),
      })
      .nullable(),
    allowActive: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('scanEntity'),
    entityType,
    entityId: z.number().int().positive(),
    promptOverrides,
    model: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
    wait: waitSecondsSchema,
  }),
  z
    .object({
      action: z.literal('batchEntities'),
      entityType,
      entityIds: z.array(z.number().int().positive()).min(1).max(50),
      promptOverrides,
      model: z.string().min(1).optional(),
      thinking: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(8).default(3),
      wait: waitSecondsSchema,
    })
    .superRefine(({ entityIds, concurrency, wait }, ctx) =>
      entitiesWithinBudget({ items: entityIds.length, concurrency, wait }, ctx)
    ),
  z.object({
    action: z.literal('sampleShadow'),
    entityType,
    label: z.enum(TEXT_SCAN_LABELS),
    verdict: z.enum(['triggered', 'clear', 'any']).default('triggered'),
    n: z.number().int().min(1).max(200).default(100),
    sinceDays: z.number().int().min(1).max(60).default(14),
    seed: z.string().min(1).max(64).default('shadow'),
    promptScope: z.enum(['active', 'any']).default('active'),
    format: z.enum(['json', 'csv']).default('json'),
  }),
  z.object({
    action: z.literal('quoteEntities'),
    entityType,
    entityIds: z.array(z.number().int().positive()).min(1).max(50),
    model: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(8).default(3),
  }),
  z.object({
    action: z.literal('composeEntities'),
    entityType,
    entityIds: z.array(z.number().int().positive()).min(1).max(50),
  }),
  z
    .object({
      action: z.literal('scanTexts'),
      entityType,
      texts,
      promptOverrides,
      model: z.string().min(1).optional(),
      thinking: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(8).default(3),
      wait: waitSecondsSchema,
    })
    .superRefine(({ texts, concurrency, wait }, ctx) =>
      textsWithinBudget({ items: texts.length, concurrency, wait }, ctx)
    ),
  z.object({
    action: z.literal('quoteTexts'),
    entityType,
    texts,
    promptOverrides,
    model: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(8).default(3),
  }),
]);

export type TextScanHarnessInput = z.infer<typeof textScanHarnessSchema>;
export type TextScanHarnessResult = { kind: 'json'; body: unknown } | { kind: 'csv'; body: string };

type ScanEntitySyncInput = Omit<Extract<TextScanHarnessInput, { action: 'scanEntity' }>, 'action'>;

function isTooShort(subject: TextScanSubject, profile: TextScanProfile) {
  return subjectTextLength(subject) < (profile.minChars ?? 1);
}

async function loadSubject(entityType: TextScanEntityType, entityId: number) {
  const profile = requireProfile(entityType);
  const subject = (await profile.load([entityId])).get(entityId);
  if (!subject) return { ok: false as const, error: 'entity not found' };
  if (isTooShort(subject, profile)) return { ok: false as const, error: 'too-short' };
  return { ok: true as const, profile, subject };
}

type ComposeInput = {
  subject: TextScanSubject;
  profile: TextScanProfile;
  promptOverrides?: Record<string, string>;
  model?: string;
  thinking?: boolean;
};

async function composeStep({ subject, profile, promptOverrides, model, thinking }: ComposeInput) {
  const [config, active] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  const prompts = { ...active };
  for (const [key, content] of Object.entries(promptOverrides ?? {}))
    prompts[key] = { id: 0, key, content };

  let composed: ReturnType<typeof composeTextScanMessages>;
  try {
    composed = composeTextScanMessages({
      prompts,
      labels: profile.labels,
      subject,
      maxInputChars: config.maxInputChars,
    });
  } catch (e) {
    if (e instanceof MissingTextScanPromptError)
      return { ok: false as const, error: e.message, missingPrompts: e.keys };
    throw e;
  }
  const useThinking = thinking ?? config.thinking;
  return {
    ok: true as const,
    composed,
    thinking: useThinking,
    step: buildTextScanStep({
      system: composed.system,
      user: composed.user,
      model: model ?? config.model,
      labels: profile.labels,
      thinking: useThinking,
    }),
  };
}

// The client types `error` loosely; an object would otherwise reach the moderator as [object Object].
function workflowErrorText(error: unknown, fallback: string): string {
  if (error == null) return fallback;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

const FAILED_WORKFLOW_STATUSES = ['failed', 'expired', 'canceled'];
const ERROR_KEYS = ['error', 'errors', 'reason', 'blockedReason', 'message'];

function orchestratorErrorDetail(step: unknown): string {
  const found: string[] = [];
  const collect = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const key of ERROR_KEYS) {
      const value = (node as Record<string, unknown>)[key];
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v === 'string' && v) found.push(v);
        else if (v && typeof v === 'object') found.push(JSON.stringify(v));
      }
    }
  };
  const s = step as { metadata?: unknown; output?: unknown; jobs?: unknown } | undefined;
  collect(s);
  collect(s?.metadata);
  collect(s?.output);
  const jobs = s?.jobs;
  if (Array.isArray(jobs)) jobs.forEach(collect);
  return [...new Set(found)].join('; ');
}

/**
 * Why a workflow has no reply to parse, in the orchestrator's own words, or null when finished. A
 * workflow still running after `wait` keeps running and bills.
 */
function unfinishedWorkflowError(
  workflow: { id: string; status?: string; steps?: unknown },
  step: ChatCompletionStepLike | undefined,
  wait: number
): string | null {
  const status = workflow.status;
  if (!status || status === 'succeeded') return null;
  if (FAILED_WORKFLOW_STATUSES.includes(status)) {
    const stepStatus = (step as { status?: string } | undefined)?.status;
    const detail = orchestratorErrorDetail(step);
    return [
      `workflow ${workflow.id} ${status}`,
      stepStatus && stepStatus !== status ? `step ${stepStatus}` : null,
      detail || null,
    ]
      .filter(Boolean)
      .join(': ');
  }
  return `workflow ${workflow.id} still ${status} after ${wait}s`;
}

async function scanComposed(input: ComposeInput & { wait: number }) {
  const ctx = await composeStep(input);
  if (!ctx.ok) return ctx;
  const startedAt = Date.now();
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: input.wait },
    body: { currencies: [], steps: [ctx.step] },
  });
  if (!data?.id) return { ok: false as const, error: workflowErrorText(error, 'no workflow id') };

  const workflow = data as { id: string; status?: string; steps?: unknown };
  const step = findChatCompletionStep(workflow.steps);
  const unfinished = unfinishedWorkflowError(workflow, step, input.wait);
  if (unfinished)
    return {
      ok: false as const,
      error: unfinished,
      workflowId: workflow.id,
      workflowStatus: workflow.status,
    };
  const parse = parseTextScanStep(step, input.profile.labels);
  return {
    ok: true as const,
    workflowId: data.id,
    promptIds: ctx.composed.promptIds,
    thinking: ctx.thinking,
    parse,
    outcome: parse.ok
      ? evaluateTextScan(parse.output, input.subject.declared, input.profile.labels)
      : null,
    rawContent: parse.ok ? undefined : step?.output?.choices?.[0]?.message?.content,
    elapsedMs: Date.now() - startedAt,
  };
}

async function quoteComposed(input: ComposeInput) {
  const ctx = await composeStep(input);
  if (!ctx.ok) return ctx;
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { whatif: true },
    body: { currencies: [], steps: [ctx.step] },
  });
  const costTotal = data?.cost?.total;
  if (typeof costTotal !== 'number')
    return { ok: false as const, error: workflowErrorText(error, 'no cost in whatif response') };
  return {
    ok: true as const,
    chars: ctx.composed.system.length + ctx.composed.user.length,
    costTotal,
  };
}

async function scanEntitySync(input: ScanEntitySyncInput) {
  const loaded = await loadSubject(input.entityType, input.entityId);
  if (!loaded.ok) return { entityId: input.entityId, ...loaded };
  return { entityId: input.entityId, ...(await scanComposed({ ...input, ...loaded })) };
}

/** Free text declares nothing, so `raised`/`newlyDetected` mean "would act on an entity declaring nothing". */
function freeTextSubject(fields: TextScanSubject['fields']): TextScanSubject {
  return { fields, declared: {} };
}

type ScanResult = Awaited<ReturnType<typeof scanComposed>>;

function summarizeScans<T extends ScanResult>(entityType: TextScanEntityType, results: T[]) {
  const byOutcome: Record<string, number> = {};
  const firing: Record<string, number> = {};
  for (const r of results) {
    const key = r.ok
      ? r.parse.ok
        ? 'ok'
        : r.parse.reason
      : r.error === 'too-short'
      ? 'too_short'
      : 'missingPrompts' in r
      ? 'missing_prompt'
      : 'workflowStatus' in r
      ? `workflow_${r.workflowStatus}`
      : 'submit_failed';
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    for (const label of (r.ok && r.outcome?.triggeredLabels) || [])
      firing[label] = (firing[label] ?? 0) + 1;
  }
  return {
    entityType,
    count: results.length,
    byOutcome,
    refusalRate: (byOutcome.refused ?? 0) / results.length,
    firing,
    results,
  };
}

type QuoteResult = Awaited<ReturnType<typeof quoteComposed>>;

function summarizeQuotes<T extends QuoteResult>(entityType: TextScanEntityType, results: T[]) {
  const quoted = results.flatMap((r: QuoteResult) => (r.ok ? [r] : []));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    entityType,
    count: results.length,
    quoted: quoted.length,
    meanCostTotal: mean(quoted.map((q) => q.costTotal)),
    maxCostTotal: quoted.length ? Math.max(...quoted.map((q) => q.costTotal)) : null,
    meanChars: mean(quoted.map((q) => q.chars)),
    results,
  };
}

async function composeEntities(entityType: TextScanEntityType, entityIds: number[]) {
  const profile = requireProfile(entityType);
  const [subjects, config] = await Promise.all([profile.load(entityIds), getTextScanConfig()]);
  const results = entityIds.map((entityId) => {
    const subject = subjects.get(entityId);
    if (!subject) return { entityId, ok: false as const, error: 'entity not found' };
    if (isTooShort(subject, profile)) return { entityId, ok: false as const, error: 'too-short' };
    return {
      entityId,
      ok: true as const,
      text: composeUserMessage(subject, config.maxInputChars),
      // An absent optional field loads as null text; callers take `fields` as non-blank strings.
      fields: subject.fields.flatMap(({ heading, text }) =>
        typeof text === 'string' && text.trim() ? [{ heading, text }] : []
      ),
      userId: subject.userId ?? null,
    };
  });
  return { entityType, results };
}

type ShadowSampleInput = Omit<Extract<TextScanHarnessInput, { action: 'sampleShadow' }>, 'action'>;

type ShadowRow = {
  entityId: number;
  workflowId: string | null;
  triggeredLabels: string[];
  nsfwLevel: number | null;
  result: TextScanResult;
  contentHash: string | null;
  updatedAt: Date;
};

function verdictSummary(verdict: TextScanOutput[TextScanLabel] | undefined) {
  if (!verdict) return null;
  if ('level' in verdict) return verdict.level;
  if ('names' in verdict)
    return verdict.detected ? `detected: ${verdict.names.join(', ')}` : 'clear';
  return verdict.detected ? 'detected' : 'clear';
}

async function activePromptIdsJson(labels: readonly TextScanLabel[]) {
  const active = await getActiveTextScanPrompts();
  const ids: Record<string, number | undefined> = { base: active.base?.id };
  for (const label of labels) ids[label] = active[`label:${label}`]?.id;
  return JSON.stringify(ids);
}

async function sampleShadow(input: ShadowSampleInput) {
  const profile = requireProfile(input.entityType);
  if (!profile.labels.includes(input.label))
    throwBadRequestError(`${input.entityType} does not scan ${input.label}`);

  const since = new Date(Date.now() - input.sinceDays * 86_400_000);
  const shadowKey = textScanEmEntityType(input.entityType, 'shadow');
  const promptIds =
    input.promptScope === 'active' ? await activePromptIdsJson(profile.labels) : null;
  const rows = await dbRead.$queryRaw<ShadowRow[]>`
    SELECT "entityId", "workflowId", "triggeredLabels", "nsfwLevel", result, "contentHash", "updatedAt"
    FROM "EntityModeration"
    WHERE "entityType" = ${shadowKey}
      AND status = 'Succeeded'::"EntityModerationStatus"
      AND result->>'version' = '1'
      AND "updatedAt" >= ${since}
      AND (${input.verdict} = 'any' OR ((${input.label} = ANY("triggeredLabels")) = (${input.verdict} = 'triggered')))
      AND (${promptIds}::jsonb IS NULL OR result->'promptIds' = ${promptIds}::jsonb)
    ORDER BY md5("entityId"::text || ${input.seed})
    LIMIT ${input.n}
  `;

  const [subjects, config] = await Promise.all([
    profile.load(rows.map((r) => r.entityId)),
    getTextScanConfig(),
  ]);

  const items = rows.map((row) => {
    const subject = subjects.get(row.entityId);
    const text = subject ? composeUserMessage(subject, config.maxInputChars) : null;
    const verdict = row.result.labels[input.label];
    return {
      entityId: row.entityId,
      userId: subject?.userId ?? null,
      workflowId: row.workflowId,
      scannedAt: new Date(row.updatedAt).toISOString(),
      triggered: row.triggeredLabels.includes(input.label),
      verdict: verdictSummary(verdict),
      reason: verdict?.reason ?? null,
      declared: (subject?.declared ?? null) as TextScanDeclared | null,
      promptIds: row.result.promptIds,
      model: row.result.model,
      text,
      // The row does not store `thinking`, so a config change marks every earlier row changed.
      textChangedSinceScan:
        text === null
          ? null
          : textScanContentHash({
              user: text,
              promptIds: row.result.promptIds,
              model: row.result.model,
              thinking: config.thinking,
            }) !== row.contentHash,
    };
  });

  return {
    entityType: input.entityType,
    label: input.label,
    verdict: input.verdict,
    promptScope: input.promptScope,
    requested: input.n,
    returned: items.length,
    items,
  };
}

const CSV_COLUMNS = [
  'entityType',
  'entityId',
  'userId',
  'scannedAt',
  'triggered',
  'verdict',
  'reason',
  'declared',
  'textChangedSinceScan',
  'text',
  'grade',
  'note',
] as const;

// Moderators open this in a spreadsheet; user text beginning with = + - @ would run as a formula.
function csvCell(value: unknown) {
  let s = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function toShadowCsv(sample: Awaited<ReturnType<typeof sampleShadow>>) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const item of sample.items) {
    const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      ...item,
      entityType: sample.entityType,
      grade: '',
      note: '',
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
  }
  return lines.join('\r\n');
}

function requireProfile(entityType: TextScanEntityType) {
  const profile = getTextScanProfile(entityType);
  if (!profile) throw throwBadRequestError(`no profile registered for ${entityType}`);
  return profile;
}

function requireModeratorId(id: number | undefined) {
  if (id === undefined) throw throwBadRequestError('a moderator id is required');
  return id;
}

/** `actor.moderatorId` (an authenticated session) wins over any id asserted in the body. */
export async function runTextScanHarnessAction(
  input: TextScanHarnessInput,
  actor: { moderatorId?: number }
): Promise<TextScanHarnessResult> {
  switch (input.action) {
    case 'getPrompts': {
      const [active, config, modes] = await Promise.all([
        getActiveTextScanPrompts(),
        getTextScanConfig(),
        readTextScanRollouts(),
      ]);
      const history = input.history
        ? await dbRead.textScanPrompt.findMany({
            where: { key: input.history },
            orderBy: { id: 'desc' },
            take: input.limit,
          })
        : undefined;
      return { kind: 'json', body: { active, config, modes, history } };
    }

    case 'putPrompt': {
      const { key, content, note } = input;
      const createdById = requireModeratorId(actor.moderatorId ?? input.createdById);
      return {
        kind: 'json',
        body: await insertTextScanPrompt({ key, content, note, createdById }),
      };
    }

    case 'putConfig': {
      const id = requireModeratorId(actor.moderatorId ?? input.moderatorId);
      return { kind: 'json', body: await setTextScanConfig(input.config, { moderatorId: id }) };
    }

    case 'putModes': {
      const id = requireModeratorId(actor.moderatorId ?? input.moderatorId);
      const modes = await setTextScanRollout(input.entityType, input.rollout, {
        moderatorId: id,
        allowActive: input.allowActive,
      });
      return { kind: 'json', body: { modes } };
    }

    case 'scanEntity': {
      requireProfile(input.entityType);
      return { kind: 'json', body: await scanEntitySync(input) };
    }

    case 'batchEntities': {
      requireProfile(input.entityType);
      const limit = pLimit(input.concurrency);
      const results = await Promise.all(
        input.entityIds.map((entityId) => limit(() => scanEntitySync({ ...input, entityId })))
      );
      return { kind: 'json', body: summarizeScans(input.entityType, results) };
    }

    case 'sampleShadow': {
      const sample = await sampleShadow(input);
      return input.format === 'csv'
        ? { kind: 'csv', body: toShadowCsv(sample) }
        : { kind: 'json', body: sample };
    }

    case 'quoteEntities': {
      requireProfile(input.entityType);
      const limit = pLimit(input.concurrency);
      const results = await Promise.all(
        input.entityIds.map((entityId) =>
          limit(async () => {
            const loaded = await loadSubject(input.entityType, entityId);
            if (!loaded.ok) return { entityId, ...loaded };
            return {
              entityId,
              ...(await quoteComposed({
                ...loaded,
                model: input.model,
                thinking: input.thinking,
              })),
            };
          })
        )
      );
      return { kind: 'json', body: summarizeQuotes(input.entityType, results) };
    }

    case 'composeEntities':
      return { kind: 'json', body: await composeEntities(input.entityType, input.entityIds) };

    case 'scanTexts': {
      const profile = requireProfile(input.entityType);
      const limit = pLimit(input.concurrency);
      const results = await Promise.all(
        input.texts.map(({ key, fields }) =>
          limit(async () => {
            const subject = freeTextSubject(fields);
            if (isTooShort(subject, profile))
              return { key, ok: false as const, error: 'too-short' };
            return { key, ...(await scanComposed({ ...input, subject, profile })) };
          })
        )
      );
      return { kind: 'json', body: summarizeScans(input.entityType, results) };
    }

    case 'quoteTexts': {
      const profile = requireProfile(input.entityType);
      const limit = pLimit(input.concurrency);
      const results = await Promise.all(
        input.texts.map(({ key, fields }) =>
          limit(async () => {
            const subject = freeTextSubject(fields);
            if (isTooShort(subject, profile))
              return { key, ok: false as const, error: 'too-short' };
            return { key, ...(await quoteComposed({ ...input, subject, profile })) };
          })
        )
      );
      return { kind: 'json', body: summarizeQuotes(input.entityType, results) };
    }
  }
}
