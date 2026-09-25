import { submitWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { dbRead } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { evaluateTextScan } from '~/server/services/text-scan/evaluate';
import { findChatCompletionStep, parseTextScanStep } from '~/server/services/text-scan/parse';
import { getTextScanProfile, isTextScanEntityType } from '~/server/services/text-scan/profiles';
import '~/server/services/text-scan/profiles/index';
import {
  composeTextScanMessages,
  getActiveTextScanPrompts,
  getTextScanConfig,
  insertTextScanPrompt,
  setTextScanConfig,
  subjectTextLength,
  TEXT_SCAN_PROMPT_KEY,
} from '~/server/services/text-scan/prompt';
import { buildTextScanStep } from '~/server/services/text-scan/submit';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const TEXT_SCAN_HARNESS_ACTIONS = [
  'getPrompts',
  'putPrompt',
  'putConfig',
  'scanEntity',
  'batchEntities',
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
]);

export type TextScanHarnessInput = z.infer<typeof textScanHarnessSchema>;
export type TextScanHarnessResult = { kind: 'json'; body: unknown } | { kind: 'csv'; body: string };

type ScanEntitySyncInput = {
  entityType: TextScanEntityType;
  entityId: number;
  promptOverrides?: Record<string, string>;
  model?: string;
  thinking?: boolean;
  wait: number;
};

async function scanEntitySync(input: ScanEntitySyncInput) {
  const profile = getTextScanProfile(input.entityType);
  if (!profile) throw new Error(`no profile for ${input.entityType}`);
  const subject = (await profile.load([input.entityId])).get(input.entityId);
  if (!subject) return { entityId: input.entityId, ok: false as const, error: 'entity not found' };
  if (subjectTextLength(subject) < (profile.minChars ?? 1))
    return { entityId: input.entityId, ok: false as const, error: 'too-short' };

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
  const model = input.model ?? config.model;
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

function requireProfile(entityType: TextScanEntityType) {
  if (!getTextScanProfile(entityType))
    throwBadRequestError(`no profile registered for ${entityType}`);
}

function requireModeratorId(id: number | undefined) {
  if (id === undefined) return throwBadRequestError('a moderator id is required');
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
  }
}
