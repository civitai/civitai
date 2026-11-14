import { TRPCError } from '@trpc/server';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  foldStepTypeCase,
  isTrainingStepTypeIgnoringCase,
} from '~/server/services/blocks/steps/orchestrator-denylist';
import { collectBlockStepTemplates, foldCase } from '~/server/services/blocks/workflow-graph';
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
// Marks literal text that a url-shaped string still counts in; references never rely on it.
const TEXT_KEY = /prompt|lyric|text|message|style|caption|instruction/i;
const NEGATIVE_KEY = /negative/i;
const URL_OR_AIR = /^\s*(https?:\/\/\S+|urn:air:\S+)\s*$/i;
/**
 * Step input fields that take media or a url, from the `@civitai/orchestration-client` input
 * types (lower-cased). A reference is readable as non-prompt only under one of these; under
 * any other key it may bind text, so it counts as an unreadable prompt.
 */
const MEDIA_KEYS: ReadonlySet<string> = new Set([
  'additionalvideos',
  'audioblob',
  'audiourl',
  'blob',
  'blobkey',
  'bloburl',
  'endimage',
  'endsourceimage',
  'firstframe',
  'firstframeimage',
  'frames',
  'frontalimage',
  'garmenturl',
  'image',
  'image_url',
  'images',
  'imagestylereferences',
  'imageurl',
  'imageurls',
  'inputurl',
  'keyframes',
  'lastframe',
  'lastframeimage',
  'mask',
  'mediaurl',
  'mediaurls',
  'middleframeimage',
  'middleimages',
  'personmask',
  'refaudiourl',
  'referenceaudios',
  'referenceimage',
  'referenceimages',
  'referencevideos',
  'referencevideourls',
  'sampleinputimages',
  'sourceaudio',
  'sourceimage',
  'sourceimages',
  'sourceimageurl',
  'sourceurl',
  'sourcevideo',
  'startimage',
  'subjectmaskurl',
  'subjecturl',
  'targetaudio',
  'textureimageurl',
  'url',
  'video',
  'videoblob',
  'videos',
  'videourl',
]);

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

/**
 * `null` from Flipt is an unreachable client or a failed evaluation as often as a missing flag,
 * so it keeps the last mode this process read rather than dropping an enforced gate to off.
 */
export async function getPassThroughPromptAuditMode(): Promise<PassThroughPromptAuditMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCK_PASS_THROUGH_PROMPT_AUDIT);
  if (variant === null) return lastKnownMode ?? 'off';
  lastKnownMode = variant === 'log' || variant === 'enforce' ? variant : 'off';
  return lastKnownMode;
}

type AuditContext = {
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
  ctx: AuditContext & { steps: ReadonlyArray<{ $type: string; input: unknown }> },
  mode?: PassThroughPromptAuditMode
): Promise<void> {
  const resolved = mode ?? (await getPassThroughPromptAuditMode());
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
  const resolved = mode ?? (await getPassThroughPromptAuditMode());
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
  await auditPromptServer({
    prompt: collected.prompt,
    negativePrompt: collected.negativePrompt || undefined,
    userId: ctx.userId,
    isGreen: ctx.isGreen,
    isModerator: await ctx.loadIsModerator(),
  });
}
