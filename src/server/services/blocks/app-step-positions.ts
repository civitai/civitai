import { Air } from '@civitai/orchestration-client';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { STEP_MEDIA_INPUT_KEYS } from '~/server/services/blocks/step-media-keys';
import { WORKFLOW_ARGUMENTS_REF } from '~/server/services/blocks/workflow-graph';
import { isWorkflowOwnedBy } from '~/server/services/orchestrator/assert-workflow-owner';

// What an app-built step may put where. Only media positions (the shared media input keys, and
// everything under them) take a reference to another step's output or a URL; every other key takes
// literal values, so a key the list has not met yet is held to the stricter rule. An orchestrator
// file is an owner check, not a position one: the viewer's own job file is accepted at any key,
// and off media keys another user's file, a blob or a file whose owner cannot be read is refused.
// `trainingData` is added here only: its items are orchestrator blobs, but it also
// carries captions, which the prompt audit must keep reading as text.
const MEDIA_KEYS: ReadonlySet<string> = new Set([...STEP_MEDIA_INPUT_KEYS, 'trainingdata']);

// Chat messages and tool schemas: text, as the generation input gate reads a chat step's, but
// held here at any step. A URL there is text; a reference or another user's file is not.
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set(['messages', 'tools']);

const REF_KEY = '$ref';
// A value that starts as a URL is one: the orchestrator reads a URL with spaces in it too.
const URL_VALUE_RE = /^([a-z][a-z0-9+.-]*:\/\/|https?:)/i;
// An orchestrator AIR the AIR grammar cannot read is still one to the orchestrator.
const ORCHESTRATOR_SOURCE_RE = /(^|:)orchestrator:/i;
// A key that names a field. Anything else is a map key the app chose (LoRAs are keyed by AIR):
// it is reported as the field that holds the map, so a log never carries it.
const FIELD_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

export type StepPositionProblem = {
  form: 'reference' | 'url' | 'orchestrator-file';
  /** The key the value sits under; never the value. */
  key: string;
  /** A URL's host, never its path. */
  host?: string;
};

function isMediaKey(key: string | undefined): boolean {
  return key !== undefined && MEDIA_KEYS.has(key.toLowerCase());
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The value a `{ $ref: '$arguments', path }` reference places, read from `workflowArguments`. Not
 * found for any other reference, one with a `format`, or a path that does not resolve: the
 * orchestrator would then use a `default` or fail, and neither is checked here.
 */
function argumentValue(
  reference: Record<string, unknown>,
  workflowArguments: unknown
): { found: true; value: unknown } | { found: false } {
  const keys = Object.keys(reference);
  if (keys.some((k) => k !== '$ref' && k !== 'path')) return { found: false };
  if (reference.$ref !== WORKFLOW_ARGUMENTS_REF || typeof reference.path !== 'string')
    return { found: false };
  let current: unknown = workflowArguments;
  // The orchestrator splits a path on dots; a segment with no matching key (an index) is not found.
  for (const segment of reference.path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current))
      return { found: false };
    // The orchestrator matches names ignoring case, so exactly one key may match.
    const matches = Object.keys(current).filter((k) => k.toLowerCase() === segment.toLowerCase());
    if (matches.length !== 1) return { found: false };
    current = (current as Record<string, unknown>)[matches[0]];
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

const MAX_DEPTH = 64;
// An orchestrator AIR is short; a longer token naming one is refused unread.
const TOKEN_LENGTH_MAX = 512;
const TOKEN_PUNCTUATION = new Set([
  '"',
  "'",
  '`',
  '(',
  ')',
  '<',
  '>',
  '[',
  ']',
  '{',
  '}',
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
]);

/** The token without quotes, brackets and punctuation around it. Linear: no regex. */
function stripTokenPunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && TOKEN_PUNCTUATION.has(token[start])) start++;
  while (end > start && TOKEN_PUNCTUATION.has(token[end - 1])) end--;
  return token.slice(start, end);
}

function isRepeatStepType(stepType: string): boolean {
  return stepType.toLowerCase() === 'repeat';
}

/** Each field is `{ $ref, path, reduce }`, exactly, reading an earlier step of this workflow. */
function areMergeSources(fields: unknown, earlierSteps: ReadonlySet<string>): boolean {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  return Object.values(fields).every((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
    const { $ref, path, reduce, ...rest } = field as Record<string, unknown>;
    return (
      Object.keys(rest).length === 0 &&
      typeof $ref === 'string' &&
      earlierSteps.has($ref) &&
      typeof path === 'string' &&
      typeof reduce === 'string'
    );
  });
}

/** `{ $ref, path, as }`, exactly: the orchestrator's RepeatForClause. */
function isRepeatForClause(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3 && keys[0] === '$ref' && keys[1] === 'as' && keys[2] === 'path';
}

/** An orchestrator file the viewer does not own. A job file is `orchestrator:<jobId>@<file>`; a
 *  blob names no owner at all. */
function orchestratorFileProblemFor(
  value: string,
  key: string,
  viewerId: number
): StepPositionProblem | null {
  if (!ORCHESTRATOR_SOURCE_RE.test(value)) return null;
  const parsed = Air.parseSafe(value);
  const owned =
    parsed?.source.toLowerCase() === 'orchestrator' &&
    parsed.id.toLowerCase() !== 'blob' &&
    isWorkflowOwnedBy(parsed.id, viewerId);
  return owned ? null : { form: 'orchestrator-file', key };
}

/**
 * The first value in `input` that sits outside a media position and is a reference, a URL, or an
 * orchestrator file the viewer does not own. Map keys count as values (LoRAs are keyed by AIR)
 * outside free text, and a reference with no key above it (the whole input) is outside every media
 * position.
 */
export function findStepPositionProblem(
  input: unknown,
  viewerId: number,
  workflowArguments?: unknown,
  stepType?: string,
  /** The names of the steps that run before this one in the same workflow. */
  earlierSteps: ReadonlySet<string> = new Set()
): StepPositionProblem | null {
  const orchestratorFileProblem = (value: string, key: string) =>
    orchestratorFileProblemFor(value, key, viewerId);
  const checkString = (raw: string, key: string): StepPositionProblem | null => {
    const value = raw.trim();
    if (URL_VALUE_RE.test(value)) return { form: 'url', key, host: hostOf(value) };
    return orchestratorFileProblem(value, key);
  };
  // Free text carries no file references either: each whitespace-separated token that names the
  // orchestrator source is held to the orchestrator-file rule.
  const checkText = (raw: string, key: string): StepPositionProblem | null => {
    for (const token of raw.split(/\s+/)) {
      if (!token.toLowerCase().includes('orchestrator:')) continue;
      if (token.length > TOKEN_LENGTH_MAX) return { form: 'orchestrator-file', key };
      const problem = orchestratorFileProblem(stripTokenPunctuation(token), key);
      if (problem) return problem;
    }
    return null;
  };

  type Where = {
    key: string | undefined;
    /** Below a free-text key a URL is text; references and orchestrator files still count. */
    text: boolean;
    /** The value is a repeat step's `input`, whose `for` clause names the array it iterates. */
    repeatInput: boolean;
    /** The value is a merge step's `input`, whose `fields` read earlier steps' outputs. */
    mergeInput: boolean;
    depth: number;
  };

  // `key` is the nearest key above the value; below a media key everything is media.
  const visit = (value: unknown, where: Where): StepPositionProblem | null => {
    const { key, repeatInput, mergeInput, depth } = where;
    if (isMediaKey(key)) return null;
    const at = key ?? '(input)';
    // An argument that places itself, or input nested past any real step, is refused, not walked.
    if (depth > MAX_DEPTH) return { form: 'reference', key: at };
    const text = where.text || (key !== undefined && FREE_TEXT_KEYS.has(key.toLowerCase()));
    const below = (
      childKey: string | undefined,
      nested: { repeat?: boolean; merge?: boolean } = {}
    ): Where => ({
      key: childKey,
      text,
      repeatInput: !!nested.repeat,
      mergeInput: !!nested.merge,
      depth: depth + 1,
    });
    if (typeof value === 'string') return text ? checkText(value, at) : checkString(value, at);
    if (Array.isArray(value)) {
      for (const item of value) {
        const problem = visit(item, below(key));
        if (problem) return problem;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.some(([k]) => k.toLowerCase() === REF_KEY)) {
      // A plain reference to the request's own `arguments` places a value this request carries,
      // so that value is checked where it lands. Any other reference is a value not known yet.
      const argument = argumentValue(record, workflowArguments);
      return argument.found ? visit(argument.value, below(key)) : { form: 'reference', key: at };
    }
    // A nested step (a repeat's template) names its own `$type`.
    const nestedType = typeof record.$type === 'string' ? record.$type.toLowerCase() : undefined;
    for (const [childKey, child] of entries) {
      if (!text) {
        const problem = checkString(childKey, at);
        if (problem) return problem;
      }
      // The items the clause iterates are placed by references inside the template, which this
      // walk checks where they land.
      if (repeatInput && childKey === 'for' && isRepeatForClause(child)) continue;
      // A merge collects earlier steps' outputs into its own; what reads the merge is checked
      // where it lands.
      if (mergeInput && childKey === 'fields' && areMergeSources(child, earlierSteps)) continue;
      const isInput = childKey === 'input';
      const childWhere = below(FIELD_KEY_RE.test(childKey) ? childKey : key, {
        repeat: isInput && nestedType === 'repeat',
        merge: isInput && nestedType === 'merge',
      });
      const problem = visit(child, childWhere);
      if (problem) return problem;
    }
    return null;
  };

  return visit(input, {
    key: undefined,
    text: false,
    repeatInput: stepType !== undefined && isRepeatStepType(stepType),
    mergeInput: stepType?.toLowerCase() === 'merge',
    depth: 0,
  });
}

/** The inline ComfyUI graph: one step with no `arguments`, so any reference is refused. */
export function findInlineGraphProblem(
  input: unknown,
  viewerId: number
): StepPositionProblem | null {
  const visit = (value: unknown, key: string): StepPositionProblem | null => {
    if (typeof value === 'string') return orchestratorFileProblemFor(value.trim(), key, viewerId);
    if (Array.isArray(value)) {
      for (const item of value) {
        const problem = visit(item, key);
        if (problem) return problem;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const entries = Object.entries(value);
    if (entries.some(([k]) => k.toLowerCase() === REF_KEY)) return { form: 'reference', key };
    for (const [childKey, child] of entries) {
      const problem = visit(child, FIELD_KEY_RE.test(childKey) ? childKey : key);
      if (problem) return problem;
    }
    return null;
  };
  return visit(input, '(input)');
}

export type StepPositionsMode = 'off' | 'log' | 'enforce';

/** `off` and `log` are the back-out; any other answer, a missing flag included, enforces. */
export async function getStepPositionsMode(): Promise<StepPositionsMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCK_STEP_POSITIONS);
  return variant === 'off' || variant === 'log' ? variant : 'enforce';
}

/**
 * The refusal for the first step whose input breaks the position rule; null when none does, or the
 * mode is log or off. Log mode records that finding (app, step type and key, never the value).
 */
export async function stepPositionsRefusal(opts: {
  appBlockId: string;
  viewerId: number;
  steps: ReadonlyArray<{ $type: string; name?: string; input: unknown }>;
  workflowArguments?: unknown;
  /** The step is an inline ComfyUI graph (`findInlineGraphProblem`). */
  inlineGraph?: boolean;
}): Promise<string | null> {
  const earlierSteps = new Set<string>();
  for (const step of opts.steps) {
    const problem = opts.inlineGraph
      ? findInlineGraphProblem(step.input, opts.viewerId)
      : findStepPositionProblem(
          step.input,
          opts.viewerId,
          opts.workflowArguments,
          step.$type,
          earlierSteps
        );
    if (step.name) earlierSteps.add(step.name);
    if (!problem) continue;
    const mode = await getStepPositionsMode();
    if (mode === 'off') return null;
    logToAxiom({
      type: 'warning',
      name: 'app-step-position-refused',
      appBlockId: opts.appBlockId,
      stepType: step.$type,
      key: problem.key,
      // Under payload: the main dataset is at its field limit (no-new-axiom-field.test.ts).
      payload: { form: problem.form },
      host: problem.host,
      mode,
    });
    if (mode === 'log') return null;
    return `step '${step.$type}' cannot take this value at '${problem.key}'; only media inputs take references or URLs, and an orchestrator file must be the viewer's own`;
  }
  return null;
}
