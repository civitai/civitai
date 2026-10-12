// App Blocks `kind:'workflow'` step graph: step names and the reference rules.
// Import-free: the wire schema imports this module's types.

/** Max steps in one `kind:'workflow'` body. */
export const WORKFLOW_MAX_STEPS = 8;

/** Max reference objects across every step input of one body. */
export const WORKFLOW_MAX_REFS = 64;

/**
 * Max nesting depth of a step `input`. The orchestrator stops looking for
 * references past its own recursion bound, so a deeper input is one this module
 * could not check; it is refused rather than forwarded unchecked.
 */
export const WORKFLOW_INPUT_DEPTH_MAX = 32;

/** The reference source that names the body's own `arguments`. */
export const WORKFLOW_ARGUMENTS_REF = '$arguments';

/**
 * The name the single-step arms stamp on their one step (`BLOCK_STEP_NAME` in
 * `workflow.service`). Reserved here so a workflow step can never be mistaken
 * for one of theirs. A literal, pinned equal to that constant by
 * `workflow-graph.test.ts`, to keep this module import-free.
 */
export const WORKFLOW_RESERVED_STEP_NAME = 'block-step';

/** A step name an app may choose. */
const STEP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** The only keys a reference object may carry — the orchestrator's own rule. */
const REF_KEYS: ReadonlySet<string> = new Set(['$ref', 'path', 'default', 'format']);

/**
 * How deep a `repeat` template may nest another `repeat`. Bounds the walk that
 * collects every `$type` a body can run.
 */
const REPEAT_NESTING_MAX = 4;

/** Machine-readable refusal codes a block can branch on. */
export const BLOCK_WORKFLOW_ERROR_CODES = [
  'workflow_step_denied',
  'workflow_ref_invalid',
  'workflow_too_many_steps',
] as const;
export type BlockWorkflowErrorCode = (typeof BLOCK_WORKFLOW_ERROR_CODES)[number];

export type BlockWorkflowStepInput = {
  name?: string;
  $type: string;
  input: Record<string, unknown>;
  suppressOutput?: boolean;
};

export type ResolvedBlockWorkflowStep = {
  /** The app's name, or the positional `$<index>` when it gave none. */
  name: string;
  $type: string;
  /** The app's own object, forwarded unmodified. */
  input: Record<string, unknown>;
  suppressOutput: boolean;
  /**
   * Every `$type` this step can run: its own, plus the template of a `repeat`
   * step (and of a `repeat` nested inside that template).
   */
  stepTypes: string[];
};

export type BlockWorkflowGraphResult =
  | { ok: true; steps: ResolvedBlockWorkflowStep[] }
  | {
      ok: false;
      errorCode: Extract<
        BlockWorkflowErrorCode,
        'workflow_ref_invalid' | 'workflow_too_many_steps'
      >;
      error: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for the one step type that runs ANOTHER step: `repeat` executes
 * `input.template` once per item of an array.
 *
 * Case-folded for the same reason the denylist is: the value is a caller-supplied
 * string forwarded to a service this repo does not own.
 */
export function isRepeatStepType(stepType: unknown): boolean {
  return typeof stepType === 'string' && stepType.toLowerCase() === 'repeat';
}

/** True when `object` spells one of `names` in any casing other than its own. */
function hasRecasedKey(object: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(object).some(
    (key) => !names.includes(key) && names.includes(key.toLowerCase())
  );
}

type RepeatInput = {
  forClause: Record<string, unknown>;
  template: Record<string, unknown> & { $type: string };
};

/**
 * A `repeat` step's input, or `null` when this cannot say for certain which step
 * it runs and what it iterates.
 *
 * FAIL-CLOSED ON SHAPE: the input must hold exactly `for` and `template`, the
 * template must name a string `$type`, and none of the keys this module reads may
 * appear under another casing. Whether the orchestrator would bind a re-cased key
 * is not something this repo can know, so a body that relies on it is refused.
 */
function readRepeatInput(input: unknown): RepeatInput | null {
  if (!isPlainObject(input)) return null;
  if (Object.keys(input).some((key) => key !== 'for' && key !== 'template')) return null;
  const { for: forClause, template } = input;
  if (!isPlainObject(forClause) || hasRecasedKey(forClause, ['$ref', 'path', 'as'])) return null;
  if (!isPlainObject(template) || hasRecasedKey(template, ['$type', 'input'])) return null;
  if (typeof template.$type !== 'string') return null;
  return { forClause, template: template as RepeatInput['template'] };
}

/** The refusal for a `repeat` step `readRepeatInput` or the nesting bound turns away. */
export const REPEAT_SHAPE_ERROR =
  `a repeat step needs exactly { for, template } with a template "$type", keys spelled in ` +
  `lower case, nested at most ${REPEAT_NESTING_MAX} deep`;

/**
 * Every `$type` a step can run — its own and, for a `repeat`, its template's.
 *
 * Returns `null` for a `repeat` it cannot follow (see `readRepeatInput`) or one
 * nested deeper than `REPEAT_NESTING_MAX`, so a caller refuses the body instead
 * of checking only part of it.
 */
export function collectBlockStepTypes(stepType: string, input: unknown): string[] | null {
  const types: string[] = [];
  let currentType = stepType;
  let currentInput = input;
  for (let depth = 0; depth <= REPEAT_NESTING_MAX; depth += 1) {
    types.push(currentType);
    if (!isRepeatStepType(currentType)) return types;
    const repeat = readRepeatInput(currentInput);
    if (!repeat) return null;
    currentType = repeat.template.$type;
    currentInput = repeat.template.input;
  }
  return null;
}

/** The orchestrator's reference predicate: `$ref` and `path`, and no other key but `default`/`format`. */
function isRefObject(value: Record<string, unknown>): boolean {
  if (!('$ref' in value) || !('path' in value)) return false;
  for (const key of Object.keys(value)) if (!REF_KEYS.has(key)) return false;
  return true;
}

type WalkState = { refs: number };

/** A refusal message, or `null` when `value` is fine. */
function checkValue(
  value: unknown,
  depth: number,
  sources: ReadonlySet<string>,
  state: WalkState
): string | null {
  if (typeof value !== 'object' || value === null) return null;
  if (depth > WORKFLOW_INPUT_DEPTH_MAX) {
    return `input is nested deeper than ${WORKFLOW_INPUT_DEPTH_MAX} levels`;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const problem = checkValue(entry, depth + 1, sources, state);
      if (problem) return problem;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  if (isRefObject(object)) {
    if (typeof object.$ref !== 'string' || typeof object.path !== 'string') {
      return 'a reference needs a string "$ref" and a string "path"';
    }
    if (
      object.format !== undefined &&
      object.format !== null &&
      typeof object.format !== 'string'
    ) {
      return 'a reference "format" must be a string';
    }
    return checkSource(object.$ref, sources, state);
  }
  for (const entry of Object.values(object)) {
    const problem = checkValue(entry, depth + 1, sources, state);
    if (problem) return problem;
  }
  return null;
}

function checkSource(
  source: string,
  sources: ReadonlySet<string>,
  state: WalkState
): string | null {
  state.refs += 1;
  if (state.refs > WORKFLOW_MAX_REFS) {
    return `a workflow may hold at most ${WORKFLOW_MAX_REFS} references`;
  }
  if (!sources.has(source)) {
    return (
      `"$ref": ${JSON.stringify(source)} does not name "${WORKFLOW_ARGUMENTS_REF}" or an ` +
      'earlier step'
    );
  }
  return null;
}

/**
 * Check one step's input. A `repeat` step is the one shape with structure this
 * has to know: its `for` clause names what to iterate (a step or the arguments,
 * with an extra `as` key, so it is not a reference object), and inside its
 * `template` the `as` name is a legal reference source.
 */
function checkStepInput(
  stepType: unknown,
  input: unknown,
  depth: number,
  sources: ReadonlySet<string>,
  state: WalkState
): string | null {
  if (!isRepeatStepType(stepType)) return checkValue(input, depth, sources, state);
  const repeat = readRepeatInput(input);
  if (!repeat) return REPEAT_SHAPE_ERROR;
  const { forClause, template } = repeat;
  if (typeof forClause.$ref === 'string') {
    const problem = checkSource(forClause.$ref, sources, state);
    if (problem) return problem;
  }
  for (const entry of Object.values(forClause)) {
    const problem = checkValue(entry, depth + 2, sources, state);
    if (problem) return problem;
  }
  const templateSources =
    typeof forClause.as === 'string' ? new Set([...sources, forClause.as]) : sources;
  for (const [key, entry] of Object.entries(template)) {
    const problem =
      key === 'input'
        ? checkStepInput(template.$type, entry, depth + 2, templateSources, state)
        : checkValue(entry, depth + 2, templateSources, state);
    if (problem) return problem;
  }
  return null;
}

/**
 * Resolve a `kind:'workflow'` body's step names and check its reference graph.
 *
 * The rules (every refusal but the first names the step index):
 *  - at most `WORKFLOW_MAX_STEPS` steps;
 *  - a name is `[a-z][a-z0-9_-]{0,31}`, or exactly the step's own positional
 *    `$<index>`; names are unique; `block-step` is reserved. A step given no
 *    name is named `$<index>`;
 *  - every reference names `$arguments` or an EARLIER step, so the graph has no
 *    cycle and no self-reference by construction. Inside a `repeat` template
 *    the loop variable (`for.as`) is a source too;
 *  - at most `WORKFLOW_MAX_REFS` references, and no input nested deeper than
 *    `WORKFLOW_INPUT_DEPTH_MAX`.
 *
 * `input` is never copied or rewritten: each resolved step carries the caller's
 * own object.
 */
export function resolveBlockWorkflowGraph(body: {
  steps: readonly BlockWorkflowStepInput[];
}): BlockWorkflowGraphResult {
  if (body.steps.length > WORKFLOW_MAX_STEPS) {
    return {
      ok: false,
      errorCode: 'workflow_too_many_steps',
      error: `a workflow may have at most ${WORKFLOW_MAX_STEPS} steps (got ${body.steps.length})`,
    };
  }
  const invalid = (index: number, problem: string): BlockWorkflowGraphResult => ({
    ok: false,
    errorCode: 'workflow_ref_invalid',
    error: `workflow step ${index}: ${problem}`,
  });

  const steps: ResolvedBlockWorkflowStep[] = [];
  const earlier = new Set<string>([WORKFLOW_ARGUMENTS_REF]);
  const taken = new Set<string>();
  const state: WalkState = { refs: 0 };

  for (let index = 0; index < body.steps.length; index += 1) {
    const step = body.steps[index];
    const positional = `$${index}`;
    const name = step.name ?? positional;
    if (name !== positional && !STEP_NAME_PATTERN.test(name)) {
      return invalid(
        index,
        `name ${JSON.stringify(name)} must match ${STEP_NAME_PATTERN.source} or be "${positional}"`
      );
    }
    if (name === WORKFLOW_RESERVED_STEP_NAME) {
      return invalid(index, `name "${WORKFLOW_RESERVED_STEP_NAME}" is reserved`);
    }
    if (taken.has(name)) return invalid(index, `name ${JSON.stringify(name)} is used twice`);

    const stepTypes = collectBlockStepTypes(step.$type, step.input);
    if (stepTypes === null) return invalid(index, REPEAT_SHAPE_ERROR);
    const problem = checkStepInput(step.$type, step.input, 0, earlier, state);
    if (problem) return invalid(index, problem);

    taken.add(name);
    earlier.add(name);
    steps.push({
      name,
      $type: step.$type,
      input: step.input,
      suppressOutput: step.suppressOutput === true,
      stepTypes,
    });
  }
  return { ok: true, steps };
}
