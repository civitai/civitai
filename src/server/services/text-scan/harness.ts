import { submitWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import { findChatCompletionStep, parseTextScanStep } from '~/server/services/text-scan/parse';
import { textScanEmEntityType } from '~/server/services/text-scan/mode';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import {
  composeTextScanMessages,
  composeUserMessage,
  getActiveTextScanPrompts,
  getTextScanConfig,
  insertTextScanPrompt,
  setTextScanConfig,
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
} from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const TEXT_SCAN_HARNESS_ACTIONS = [
  'getPrompts',
  'putPrompt',
  'putConfig',
  'scanEntity',
  'batchEntities',
  'sampleShadow',
  'quoteEntities',
] as const;

export const isTextScanHarnessAction = (action: unknown) =>
  typeof action === 'string' && (TEXT_SCAN_HARNESS_ACTIONS as readonly string[]).includes(action);

const promptOverrides = z
  .record(z.string().regex(TEXT_SCAN_PROMPT_KEY), z.string().min(1))
  .optional();
const entityType = z
  .string()
  .refine(isTextScanEntityType, 'unknown text-scan entity type')
  .transform((value) => value as TextScanEntityType);
const moderatorId = z.number().int().positive();

export const textScanHarnessSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('getPrompts'),
    history: z.string().regex(TEXT_SCAN_PROMPT_KEY).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    action: z.literal('putPrompt'),
    key: z.string().regex(TEXT_SCAN_PROMPT_KEY),
    content: z.string().min(1),
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
    action: z.literal('scanEntity'),
    entityType,
    entityId: z.number().int().positive(),
    promptOverrides,
    model: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
    wait: z.number().int().min(1).max(120).default(90),
  }),
  z.object({
    action: z.literal('batchEntities'),
    entityType,
    entityIds: z.array(z.number().int().positive()).min(1).max(50),
    promptOverrides,
    model: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
    concurrency: z.number().int().min(1).max(8).default(3),
    wait: z.number().int().min(1).max(120).default(90),
  }),
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
]);

export type TextScanHarnessInput = z.infer<typeof textScanHarnessSchema>;
export type TextScanHarnessResult = { kind: 'json'; body: unknown } | { kind: 'csv'; body: string };

type ScanEntitySyncInput = Omit<Extract<TextScanHarnessInput, { action: 'scanEntity' }>, 'action'>;

async function composeForEntity(input: {
  entityType: TextScanEntityType;
  entityId: number;
  promptOverrides?: Record<string, string>;
  model?: string;
}) {
  const profile = getTextScanProfile(input.entityType);
  if (!profile) throw new Error(`no profile for ${input.entityType}`);
  const subject = (await profile.load([input.entityId])).get(input.entityId);
  if (!subject) return { ok: false as const, error: 'entity not found' };
  if (subjectTextLength(subject) < (profile.minChars ?? 1))
    return { ok: false as const, error: 'too-short' };

  const [config, active] = await Promise.all([getTextScanConfig(), getActiveTextScanPrompts()]);
  const prompts = { ...active };
  for (const [key, content] of Object.entries(input.promptOverrides ?? {}))
    prompts[key] = { id: 0, key, content };

  const composed = composeTextScanMessages({
    prompts,
    labels: profile.labels,
    subject,
    maxInputChars: config.maxInputChars,
  });
  return {
    ok: true as const,
    profile,
    subject,
    composed,
    config,
    model: input.model ?? config.model,
  };
}

async function scanEntitySync(input: ScanEntitySyncInput) {
  const ctx = await composeForEntity(input);
  if (!ctx.ok) return { entityId: input.entityId, ok: false as const, error: ctx.error };
  const { profile, subject, composed, config, model } = ctx;
  const thinking = input.thinking ?? config.thinking;
  const startedAt = Date.now();
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: input.wait },
    body: {
      currencies: [],
      steps: [
        buildTextScanStep({
          system: composed.system,
          user: composed.user,
          model,
          labels: profile.labels,
          thinking,
        }),
      ],
    },
  });
  if (!data?.id)
    return { entityId: input.entityId, ok: false as const, error: error ?? 'no workflow id' };

  const step = findChatCompletionStep((data as { steps?: unknown }).steps);
  const parse = parseTextScanStep(step, profile.labels);
  return {
    entityId: input.entityId,
    ok: true as const,
    workflowId: data.id,
    promptIds: composed.promptIds,
    thinking,
    parse,
    outcome: parse.ok ? evaluateTextScan(parse.output, subject.declared, profile.labels) : null,
    rawContent: parse.ok ? undefined : step?.output?.choices?.[0]?.message?.content,
    elapsedMs: Date.now() - startedAt,
  };
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

async function quoteEntity(input: {
  entityType: TextScanEntityType;
  entityId: number;
  model?: string;
  thinking?: boolean;
}) {
  const ctx = await composeForEntity(input);
  if (!ctx.ok) return { entityId: input.entityId, ok: false as const, error: ctx.error };
  const { profile, composed, config, model } = ctx;
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { whatif: true },
    body: {
      currencies: [],
      steps: [
        buildTextScanStep({
          system: composed.system,
          user: composed.user,
          model,
          labels: profile.labels,
          thinking: input.thinking ?? config.thinking,
        }),
      ],
    },
  });
  const costTotal = data?.cost?.total;
  if (typeof costTotal !== 'number')
    return {
      entityId: input.entityId,
      ok: false as const,
      error: error ?? 'no cost in whatif response',
    };
  return {
    entityId: input.entityId,
    ok: true as const,
    chars: composed.system.length + composed.user.length,
    costTotal,
  };
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
      const [active, config] = await Promise.all([getActiveTextScanPrompts(), getTextScanConfig()]);
      const history = input.history
        ? await dbRead.textScanPrompt.findMany({
            where: { key: input.history },
            orderBy: { id: 'desc' },
            take: input.limit,
          })
        : undefined;
      return { kind: 'json', body: { active, config, history } };
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
      const byOutcome: Record<string, number> = {};
      const firing: Record<string, number> = {};
      for (const r of results) {
        const key = r.ok
          ? r.parse.ok
            ? 'ok'
            : r.parse.reason
          : r.error === 'too-short'
          ? 'too_short'
          : 'submit_failed';
        byOutcome[key] = (byOutcome[key] ?? 0) + 1;
        for (const label of (r.ok && r.outcome?.triggeredLabels) || [])
          firing[label] = (firing[label] ?? 0) + 1;
      }
      return {
        kind: 'json',
        body: {
          entityType: input.entityType,
          count: results.length,
          byOutcome,
          refusalRate: (byOutcome.refused ?? 0) / results.length,
          firing,
          results,
        },
      };
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
          limit(() =>
            quoteEntity({
              entityType: input.entityType,
              entityId,
              model: input.model,
              thinking: input.thinking,
            })
          )
        )
      );
      const quoted = results.flatMap((r) => (r.ok ? [r] : []));
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      return {
        kind: 'json',
        body: {
          entityType: input.entityType,
          count: results.length,
          quoted: quoted.length,
          meanCostTotal: mean(quoted.map((q) => q.costTotal)),
          maxCostTotal: quoted.length ? Math.max(...quoted.map((q) => q.costTotal)) : null,
          meanChars: mean(quoted.map((q) => q.chars)),
          results,
        },
      };
    }
  }
}
