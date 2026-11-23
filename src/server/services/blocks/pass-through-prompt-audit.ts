import { TRPCError } from '@trpc/server';
import { buildFliptContext } from '@civitai/flipt/context';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { isExternalModerationConfigured } from '~/server/integrations/moderation';
import { logToAxiom } from '~/server/logging/client';
import { STEP_MEDIA_INPUT_KEYS } from '~/server/services/blocks/step-media-keys';
import {
  foldStepTypeCase,
  isTrainingStepTypeIgnoringCase,
} from '~/server/services/blocks/steps/orchestrator-denylist';
import { collectBlockStepTemplates, foldCase } from '~/server/services/blocks/workflow-graph';
import { PromptCheckUnavailableError } from '~/server/services/orchestrator/prompt-check-unavailable';
import {
  auditPromptServer,
  classifyPromptServer,
  type AuditPromptOptions,
  type PromptRefusalCause,
} from '~/server/services/orchestrator/promptAuditing';
import { env } from '~/env/server';
import {
  PROMPT_CHECK_UNAVAILABLE_ERROR_CODE,
  PROMPT_POLICY_REFUSED_ERROR_CODE,
} from '~/shared/constants/block-scope.constants';

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
// Marks literal text that a url-shaped string still counts in; references never rely on it.
const TEXT_KEY = /prompt|lyric|text|message|style|caption|instruction/i;
const NEGATIVE_KEY = /negative/i;
const URL_OR_AIR = /^\s*(https?:\/\/\S+|urn:air:\S+)\s*$/i;
// A reference is readable as non-prompt only under a media key; elsewhere it may bind text.
const MEDIA_KEYS = STEP_MEDIA_INPUT_KEYS;
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

/**
 * The training-input fields the trainer renders sample images from (`samples`, `samplePrompts`,
 * `negativePrompt` in the `@civitai/orchestration-client` training inputs), lower-cased. Only
 * these are read on a training step: captions and settings are not generated from.
 */
const TRAINING_SAMPLE_KEYS: ReadonlySet<string> = new Set([
  'samples',
  'sampleprompts',
  'negativeprompt',
]);

const REF_KEYS: ReadonlySet<string> = new Set(['$ref', 'path', 'default', 'format']);
/** Steps whose input is a caller-authored graph: node ids and input names say nothing. */
const GRAPH_STEP_TYPES: ReadonlySet<string> = new Set(['customcomfy', 'comfy']);

/** The orchestrator's reference predicate (`$ref` and `path`, nothing else but `default`/`format`). */
function refSource(value: Record<string, unknown>): PromptRefSource | null {
  const keys = Object.keys(value).map((key) => foldCase(key));
  if (!keys.includes('$ref') || !keys.includes('path')) return null;
  if (keys.some((key) => !REF_KEYS.has(key))) return null;
  const target = Object.entries(value).find(([key]) => foldCase(key) === '$ref')?.[1];
  return typeof target === 'string' && foldCase(target) === '$arguments' ? 'argument' : 'step';
}

/**
 * The text an audited step's input would generate from. Every string leaf is read, not a
 * declared field: engine inputs nest prompts (`multiPrompt[].prompt`), and whether the
 * orchestrator binds a re-cased key is not something this repo can know. In a graph step every
 * leaf is prompt text and every reference is unreadable, since the caller names the keys.
 */
export function collectPassThroughAuditText(
  steps: ReadonlyArray<{ $type: string; input: unknown }>
): PassThroughAuditText {
  const auditedTypes: string[] = [];
  const prompt = new Set<string>();
  const negative = new Set<string>();
  const promptRefs: PromptRefSource[] = [];
  let tooDeep = false;

  const walk = (
    value: unknown,
    at: { text: boolean; negative: boolean; graph: boolean; media: boolean },
    depth: number
  ) => {
    if (depth > WALK_DEPTH_MAX) {
      tooDeep = true;
      return;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text || (!at.text && !at.graph && URL_OR_AIR.test(text))) return;
      (at.negative && !at.graph ? negative : prompt).add(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, at, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    const ref = refSource(value);
    if (ref) {
      if (at.text || at.graph || !at.media) promptRefs.push(ref);
      // A reference's `default` is literal text the step may use in its place.
      for (const [key, child] of Object.entries(value))
        if (foldCase(key) === 'default') walk(child, at, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(
        child,
        {
          text: at.text || TEXT_KEY.test(key),
          negative: at.negative || NEGATIVE_KEY.test(key),
          graph: at.graph,
          media: at.media || MEDIA_KEYS.has(foldCase(key)),
        },
        depth + 1
      );
    }
  };

  for (const step of steps) {
    const templates = collectBlockStepTemplates(step.$type, step.input) ?? [step];
    for (const template of templates) {
      const type = foldStepTypeCase(template.$type);
      const training = isTrainingStepTypeIgnoringCase(template.$type);
      if (!training && !AUDITED_TYPE_LOOKUP.has(type)) continue;
      auditedTypes.push(type);
      // A whole input that is a reference resolves to text nothing here can read.
      const inputRef = isPlainObject(template.input) ? refSource(template.input) : null;
      if (inputRef) promptRefs.push(inputRef);
      else if (training) {
        if (!isPlainObject(template.input)) continue;
        for (const [key, child] of Object.entries(template.input))
          if (TRAINING_SAMPLE_KEYS.has(foldCase(key)))
            walk(
              child,
              {
                text: TEXT_KEY.test(key),
                negative: NEGATIVE_KEY.test(key),
                graph: false,
                media: false,
              },
              1
            );
      } else
        walk(
          template.input,
          { text: false, negative: false, graph: GRAPH_STEP_TYPES.has(type), media: false },
          0
        );
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

let lastKnownMode: PassThroughPromptAuditMode | null = null;

function toMode(variant: string): PassThroughPromptAuditMode {
  return variant === 'log' || variant === 'enforce' ? variant : 'off';
}

/**
 * `null` from Flipt is an unreachable client or a failed evaluation as often as a missing flag,
 * so it keeps the last mode this process read rather than dropping an enforced gate to off.
 * With a user, the flag is also evaluated for that user id (so a segment can hold one account in
 * `enforce`); only the global read feeds the fallback, so one user's mode never becomes another's.
 * Only `userId` is known here without a user lookup, so a segment on this flag must key on it.
 */
export async function getPassThroughPromptAuditMode(
  userId?: number
): Promise<PassThroughPromptAuditMode> {
  const flag = FLIPT_FEATURE_FLAGS.APP_BLOCK_PASS_THROUGH_PROMPT_AUDIT;
  // The global read runs every time so the fallback stays current; both are in-process evaluations.
  const global = await getFliptVariant(flag);
  if (global !== null) lastKnownMode = toMode(global);
  const globalMode = lastKnownMode ?? 'off';
  if (userId === undefined) return globalMode;
  const variant = await getFliptVariant(flag, String(userId), buildFliptContext({ id: userId }));
  // A user's segment may only make the audit stricter than the global mode, never laxer.
  return variant === null ? globalMode : stricter(globalMode, toMode(variant));
}

const MODE_STRICTNESS: Record<PassThroughPromptAuditMode, number> = { off: 0, log: 1, enforce: 2 };

function stricter(
  a: PassThroughPromptAuditMode,
  b: PassThroughPromptAuditMode
): PassThroughPromptAuditMode {
  return MODE_STRICTNESS[b] > MODE_STRICTNESS[a] ? b : a;
}

type AuditContext = {
  userId: number;
  appBlockId: string;
  isGreen: boolean;
  /** Read only in `enforce`, so the other modes cost no user lookup. */
  loadIsModerator: () => Promise<boolean>;
};

/**
 * A prompt refusal on an App Block submit, carrying the code the submit returns as a failed
 * snapshot. `appError` is what the app may show: never the on-site account-status tail.
 */
export class AppBlockPromptRefusalError extends TRPCError {
  constructor(
    readonly errorCode:
      | typeof PROMPT_POLICY_REFUSED_ERROR_CODE
      | typeof PROMPT_CHECK_UNAVAILABLE_ERROR_CODE,
    readonly appError: string,
    cause: TRPCError
  ) {
    super({ code: cause.code, message: cause.message, cause });
  }
}

/**
 * `auditPromptServer` for an App Block submit, mapping its refusal to an App Block code.
 * `refuseUnconfigured` (pass-through enforce only) also refuses when the external classifier is
 * not configured.
 */
export async function auditAppBlockPrompt(
  options: AuditPromptOptions & { appBlockId: string; stepType: string },
  { refuseUnconfigured = false }: { refuseUnconfigured?: boolean } = {}
): Promise<void> {
  const { appBlockId, stepType, ...audit } = options;
  try {
    await auditPromptServer({ ...audit, appOrigin: { appBlockId, stepType } });
  } catch (e) {
    throw toAppBlockRefusal(e, { appBlockId, stepType });
  }
  if (refuseUnconfigured && options.prompt?.trim() && !isExternalModerationConfigured()) {
    logWithoutWaiting({
      name: 'prompt-check-unavailable',
      type: 'error',
      userId: options.userId,
      reason: 'unconfigured',
      appBlockId,
    });
    throw toAppBlockRefusal(new PromptCheckUnavailableError(), { appBlockId, stepType });
  }
}

function toAppBlockRefusal(
  e: unknown,
  { appBlockId, stepType }: { appBlockId: string; stepType: string }
): unknown {
  let refusal: AppBlockPromptRefusalError | null = null;
  if (e instanceof PromptCheckUnavailableError) {
    refusal = new AppBlockPromptRefusalError(PROMPT_CHECK_UNAVAILABLE_ERROR_CODE, e.message, e);
  } else if (e instanceof TRPCError && e.code === 'BAD_REQUEST') {
    const blockedFor = (e.cause as Partial<PromptRefusalCause> | undefined)?.blockedFor;
    if (Array.isArray(blockedFor)) {
      refusal = new AppBlockPromptRefusalError(
        PROMPT_POLICY_REFUSED_ERROR_CODE,
        `Your prompt was flagged: ${blockedFor.join(', ')}`,
        e
      );
    }
  }
  if (!refusal) return e;
  logWithoutWaiting({
    name: 'app-block-prompt-refusal',
    type: 'info',
    appBlockId,
    stepType,
    code: refusal.errorCode,
  });
  return refusal;
}

/** An ingest stall must not hold a submit. */
function logWithoutWaiting(data: Parameters<typeof logToAxiom>[0]) {
  void Promise.resolve()
    .then(() => logToAxiom(data))
    .catch(() => undefined);
}

/**
 * Log-only: what enforce would have done, with no consequence for the user and no prompt
 * text in the log. Resolves after logging; never throws.
 */
export async function shadowPassThroughPromptAudit(
  ctx: AuditContext,
  collected: PassThroughAuditText
): Promise<void> {
  const name = 'app-block-pass-through-prompt-audit';
  const { appBlockId } = ctx;
  const stepTypes = collected.auditedTypes.join(',');
  const literal = collected.promptRefs.length === 0;
  const argumentRefs = collected.promptRefs.filter((r) => r === 'argument').length;
  const stepRefs = collected.promptRefs.filter((r) => r === 'step').length;
  const { tooLarge } = collected;
  const started = performance.now();
  try {
    const verdict = collected.tooLarge
      ? null
      : await classifyPromptServer({
          prompt: collected.prompt,
          negativePrompt: collected.negativePrompt,
          isGreen: ctx.isGreen,
        });
    const externalError = verdict?.externalError != null;
    const externalSkipped =
      verdict !== null && !!collected.prompt.trim() && !isExternalModerationConfigured();
    const outcome = externalError
      ? 'error'
      : externalSkipped
      ? 'unconfigured'
      : verdict?.outcome ?? null;
    // Mirrors the refusals auditAppBlockPrompt makes in enforce.
    const checkUnavailable =
      verdict !== null &&
      verdict.outcome !== 'hard' &&
      ((externalError && env.PROMPT_CHECK_FAIL_CLOSED) || externalSkipped);
    const wouldRefuse =
      !literal ||
      collected.tooLarge ||
      (verdict !== null && verdict.outcome !== 'pass') ||
      checkUnavailable;
    logToAxiom({
      name,
      type: 'info',
      appBlockId,
      stepTypes,
      outcome,
      source: verdict?.source ?? null,
      wouldRefuse,
      durationMs: Math.round(performance.now() - started),
      // Not Axiom fields: the dataset is at its field limit (no-new-axiom-field.test.ts).
      payload: { literal, argumentRefs, stepRefs, tooLarge, externalError, externalSkipped },
    });
  } catch (e) {
    logToAxiom({
      name,
      type: 'error',
      appBlockId,
      stepTypes,
      message: (e as Error).message,
      durationMs: Math.round(performance.now() - started),
      payload: { literal, argumentRefs, stepRefs, tooLarge },
    });
  }
}

/**
 * The prompt gate for App Blocks pass-through and multi-step submits, run before any quote
 * or reservation. `enforce` refuses what `auditPromptServer` refuses on the main generator,
 * and any prompt it cannot read as literal text; `log` refuses nothing and runs off the
 * request path.
 */
export async function auditPassThroughPrompts(
  ctx: AuditContext & { steps: ReadonlyArray<{ $type: string; input: unknown }> },
  mode?: PassThroughPromptAuditMode
): Promise<void> {
  const resolved = mode ?? (await getPassThroughPromptAuditMode(ctx.userId));
  if (resolved === 'off') return;
  await runPromptAudit(ctx, collectPassThroughAuditText(ctx.steps), resolved);
}

/** Labels a training run's sample prompts in the audit log; not an orchestrator `$type`. */
export const TRAINING_SAMPLE_PROMPTS_AUDIT_TYPE = 'trainingsampleprompts';

/**
 * The same gate for a training run's sample prompts, which the trainer renders to images
 * during the run. Blank prompts are skipped: the quote substitutes three empty prompts when
 * none are given.
 */
export async function auditTrainingSamplePrompts(
  ctx: AuditContext & { samplePrompts: readonly string[] },
  mode?: PassThroughPromptAuditMode
): Promise<void> {
  const resolved = mode ?? (await getPassThroughPromptAuditMode(ctx.userId));
  if (resolved === 'off') return;
  const prompts = [...new Set(ctx.samplePrompts.map((p) => p.trim()).filter(Boolean))];
  if (prompts.length === 0) return;
  const prompt = prompts.join('\n');
  await runPromptAudit(
    ctx,
    {
      auditedTypes: [TRAINING_SAMPLE_PROMPTS_AUDIT_TYPE],
      prompt,
      negativePrompt: '',
      promptRefs: [],
      tooLarge: prompt.length > PASS_THROUGH_AUDIT_TEXT_MAX,
    },
    resolved
  );
}

async function runPromptAudit(
  ctx: AuditContext,
  collected: PassThroughAuditText,
  resolved: Exclude<PassThroughPromptAuditMode, 'off'>
): Promise<void> {
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
  await auditAppBlockPrompt(
    {
      prompt: collected.prompt,
      negativePrompt: collected.negativePrompt || undefined,
      userId: ctx.userId,
      isGreen: ctx.isGreen,
      isModerator: await ctx.loadIsModerator(),
      appBlockId: ctx.appBlockId,
      stepType: collected.auditedTypes.join(','),
    },
    { refuseUnconfigured: true }
  );
}
