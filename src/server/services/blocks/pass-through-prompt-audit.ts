import { TRPCError } from '@trpc/server';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { foldStepTypeCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import { collectBlockStepTemplates } from '~/server/services/blocks/workflow-graph';
import {
  auditPromptServer,
  classifyPromptServer,
} from '~/server/services/orchestrator/promptAuditing';

/**
 * Orchestrator `$type`s that generate media from caller text, enumerated from the
 * `@civitai/orchestration-client` step templates whose input carries a prompt, lyrics or
 * text field, plus the two comfy types, whose prompts sit in graph leaves.
 */
export const PROMPT_AUDITED_STEP_TYPES = [
  'textToImage',
  'imageGen',
  'videoGen',
  'polyGen',
  'imageToSvg',
  'aceStepAudio',
  'miniMaxMusic3',
  'soniloAudioGen',
  'yuE2',
  'textToSpeech',
  'liveTextToSpeech',
  'comfy',
  'customComfy',
] as const;

const AUDITED_TYPE_LOOKUP: ReadonlySet<string> = new Set(
  PROMPT_AUDITED_STEP_TYPES.map(foldStepTypeCase)
);

/** Same bound as the inline-comfy sweep. */
export const PASS_THROUGH_AUDIT_TEXT_MAX = 20_000;

const WALK_DEPTH_MAX = 64;
const TEXT_KEY = /prompt|lyric|text|message|style|caption|instruction/i;
const NEGATIVE_KEY = /negative/i;
const URL_OR_AIR = /^\s*(https?:\/\/\S+|urn:air:\S+)\s*$/i;

export type PromptRefSource = 'argument' | 'step';

export type PassThroughAuditText = {
  /** The audited `$type`s found, case-folded, repeat templates included. */
  auditedTypes: string[];
  prompt: string;
  negativePrompt: string;
  /** Where a reference stands in for prompt text; empty when every prompt is literal. */
  promptRefs: PromptRefSource[];
  tooLarge: boolean;
};

export const NON_LITERAL_PROMPT_MESSAGE =
  'a generation step’s prompt must be a literal string so it can be moderated before submit';
export const PROMPT_TOO_LARGE_MESSAGE = `generation step prompts exceed the ${PASS_THROUGH_AUDIT_TEXT_MAX}-character moderation limit`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refSource(value: Record<string, unknown>): PromptRefSource | null {
  for (const [key, target] of Object.entries(value)) {
    if (key.toLowerCase() !== '$ref') continue;
    return typeof target === 'string' && target.toLowerCase() === '$arguments'
      ? 'argument'
      : 'step';
  }
  return null;
}

/**
 * The text an audited step's input would generate from. Every string leaf is read, not a
 * declared field: engine inputs nest prompts (`multiPrompt[].prompt`), and whether the
 * orchestrator binds a re-cased key is not something this repo can know.
 */
export function collectPassThroughAuditText(
  steps: ReadonlyArray<{ $type: string; input: unknown }>
): PassThroughAuditText {
  const auditedTypes: string[] = [];
  const prompt = new Set<string>();
  const negative = new Set<string>();
  const promptRefs: PromptRefSource[] = [];
  let tooDeep = false;

  const walk = (value: unknown, inText: boolean, inNegative: boolean, depth: number) => {
    if (depth > WALK_DEPTH_MAX) {
      tooDeep = true;
      return;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || (!inText && URL_OR_AIR.test(text))) return;
      (inNegative ? negative : prompt).add(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inText, inNegative, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    const ref = refSource(value);
    if (ref) {
      if (inText) promptRefs.push(ref);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, inText || TEXT_KEY.test(key), inNegative || NEGATIVE_KEY.test(key), depth + 1);
    }
  };

  for (const step of steps) {
    const templates = collectBlockStepTemplates(step.$type, step.input) ?? [step];
    for (const template of templates) {
      if (!AUDITED_TYPE_LOOKUP.has(foldStepTypeCase(template.$type))) continue;
      auditedTypes.push(foldStepTypeCase(template.$type));
      // A whole input that is a reference resolves to text nothing here can read.
      const inputRef = isPlainObject(template.input) ? refSource(template.input) : null;
      if (inputRef) promptRefs.push(inputRef);
      else walk(template.input, false, false, 0);
    }
  }

  const promptText = [...prompt].join('\n');
  const negativeText = [...negative].join('\n');
  return {
    auditedTypes,
    prompt: promptText,
    negativePrompt: negativeText,
    promptRefs,
    tooLarge: tooDeep || promptText.length + negativeText.length > PASS_THROUGH_AUDIT_TEXT_MAX,
  };
}

export type PassThroughPromptAuditMode = 'off' | 'log' | 'enforce';

export async function getPassThroughPromptAuditMode(): Promise<PassThroughPromptAuditMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCK_PASS_THROUGH_PROMPT_AUDIT);
  return variant === 'log' || variant === 'enforce' ? variant : 'off';
}

type AuditContext = {
  steps: ReadonlyArray<{ $type: string; input: unknown }>;
  userId: number;
  appBlockId: string;
  isGreen: boolean;
  /** Read only in `enforce`, so the other modes cost no user lookup. */
  loadIsModerator: () => Promise<boolean>;
};

/**
 * Log-only: what enforce would have done, with no consequence for the user and no prompt
 * text in the log. Resolves after logging; never throws.
 */
export async function shadowPassThroughPromptAudit(
  ctx: AuditContext,
  collected: PassThroughAuditText
): Promise<void> {
  const base = {
    name: 'app-block-pass-through-prompt-audit',
    type: 'info' as const,
    appBlockId: ctx.appBlockId,
    stepTypes: collected.auditedTypes.join(','),
    literal: collected.promptRefs.length === 0,
    argumentRefs: collected.promptRefs.filter((r) => r === 'argument').length,
    stepRefs: collected.promptRefs.filter((r) => r === 'step').length,
    tooLarge: collected.tooLarge,
  };
  const started = performance.now();
  try {
    const verdict = collected.tooLarge
      ? null
      : await classifyPromptServer({
          prompt: collected.prompt,
          negativePrompt: collected.negativePrompt,
          isGreen: ctx.isGreen,
        });
    const wouldRefuse =
      !base.literal || collected.tooLarge || (verdict !== null && verdict.outcome !== 'pass');
    await logToAxiom({
      ...base,
      outcome: verdict?.outcome ?? null,
      source: verdict?.source ?? null,
      externalError: verdict?.externalError != null,
      wouldRefuse,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (e) {
    await logToAxiom({
      ...base,
      type: 'error',
      message: (e as Error).message,
      durationMs: Math.round(performance.now() - started),
    }).catch(() => undefined);
  }
}

/**
 * The prompt gate for App Blocks pass-through and multi-step submits, run before any quote
 * or reservation. `enforce` refuses what `auditPromptServer` refuses on the main generator,
 * and any prompt it cannot read as literal text; `log` refuses nothing and runs off the
 * request path.
 */
export async function auditPassThroughPrompts(
  ctx: AuditContext,
  mode?: PassThroughPromptAuditMode
): Promise<void> {
  const resolved = mode ?? (await getPassThroughPromptAuditMode());
  if (resolved === 'off') return;
  const collected = collectPassThroughAuditText(ctx.steps);
  if (collected.auditedTypes.length === 0) return;

  if (resolved === 'log') {
    void shadowPassThroughPromptAudit(ctx, collected);
    return;
  }

  if (collected.promptRefs.length > 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: NON_LITERAL_PROMPT_MESSAGE });
  }
  if (collected.tooLarge) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: PROMPT_TOO_LARGE_MESSAGE });
  }
  await auditPromptServer({
    prompt: collected.prompt,
    negativePrompt: collected.negativePrompt || undefined,
    userId: ctx.userId,
    isGreen: ctx.isGreen,
    isModerator: await ctx.loadIsModerator(),
  });
}
