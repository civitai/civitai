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
  'workflow_repeat_unbounded',
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
  /** How many generations this step runs: 1, or a `repeat`'s iteration count. */
  generations: number;
};

export type BlockWorkflowGraphResult =
  | { ok: true; steps: ResolvedBlockWorkflowStep[] }
  | {
      ok: false;
      errorCode: Exclude<BlockWorkflowErrorCode, 'workflow_step_denied'>;
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

/** True when every key of `object` is one of `allowed`, spelled exactly. */
function hasOnlyKeys(object: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(object).every((key) => allowed.includes(key));
}

type RepeatInput = {
  forClause: { $ref: string; path: string; as: string };
  template: { $type: string; name?: string; input?: unknown };
};

/**
 * A `repeat` step's input, or `null` when this cannot say for certain which step
 * it runs and what it iterates.
 *
 * FAIL-CLOSED ON SHAPE, every key spelled exactly: `{ for: { $ref, path, as },
 * template: { $type, name?, input? } }` and nothing else. A template is held to
 * what a top-level step may carry, so it cannot set a field the wire schema keeps
 * server-owned; and whether the orchestrator would bind a re-cased key is not
 * something this repo can know, so a body that relies on it is refused.
 */
function readRepeatInput(input: unknown): RepeatInput | null {
  if (!isPlainObject(input) || !hasOnlyKeys(input, ['for', 'template'])) return null;
  const { for: forClause, template } = input;
  if (!isPlainObject(forClause) || !hasOnlyKeys(forClause, ['$ref', 'path', 'as'])) return null;
  if (
    typeof forClause.$ref !== 'string' ||
    typeof forClause.path !== 'string' ||
    typeof forClause.as !== 'string'
  ) {
    return null;
  }
  if (!isPlainObject(template) || !hasOnlyKeys(template, ['$type', 'name', 'input'])) return null;
  if (typeof template.$type !== 'string') return null;
  if (template.name !== undefined && typeof template.name !== 'string') return null;
  return {
    forClause: forClause as RepeatInput['forClause'],
    template: template as RepeatInput['template'],
  };
}

/** The refusal for a `repeat` step `readRepeatInput` or the nesting bound turns away. */
export const REPEAT_SHAPE_ERROR =
  'a repeat step needs exactly { for: { $ref, path, as }, template: { $type, name?, input? } }, ' +
  `nested at most ${REPEAT_NESTING_MAX} deep`;

/**
 * Max iterations of one top-level `repeat` step, nested repeats multiplied
 * together. The same number as the batch-estimate cell cap.
 */
export const WORKFLOW_REPEAT_MAX_ITERATIONS = 16;

/** The array a `for` path names in `arguments`, by exact own keys, or `null`. */
function readArgumentsArray(args: unknown, path: string): unknown[] | null {
  let current: unknown = args;
  for (const part of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return null;
    }
    current = current[part];
  }
  return Array.isArray(current) ? current : null;
}

/**
 * THE ONE PLACE the "what may a `repeat` iterate" rule lives. A refusal message,
 * or `null` when the step is not a `repeat` or its loop is bounded.
 *
 * A `repeat` may iterate only an array the body's own `arguments` hold: its
 * length is then fixed in the submitted body, so the orchestrator's quote prices
 * every child. A loop over another step's output has no length until that step
 * has run, and is refused. The count, nested repeats multiplied, is capped.
 */
export function repeatUnboundedProblem(
  stepType: unknown,
  input: unknown,
  args: unknown,
  outerIterations = 1
): string | null {
  if (!isRepeatStepType(stepType)) return null;
  const repeat = readRepeatInput(input);
  if (!repeat) return REPEAT_SHAPE_ERROR;
  const { forClause, template } = repeat;
  if (forClause.$ref !== WORKFLOW_ARGUMENTS_REF) {
    return (
      `a repeat may only iterate over the workflow's own arguments ("$ref": ` +
      `"${WORKFLOW_ARGUMENTS_REF}"), not ${JSON.stringify(forClause.$ref)} — pass the list in ` +
      '"arguments" instead'
    );
  }
  const items = readArgumentsArray(args, forClause.path);
  if (!items) {
    return `repeat "for" path ${JSON.stringify(
      forClause.path
    )} does not name an array in "arguments"`;
  }
  const iterations = outerIterations * items.length;
  if (iterations > WORKFLOW_REPEAT_MAX_ITERATIONS) {
    return (
      `a repeat may run at most ${WORKFLOW_REPEAT_MAX_ITERATIONS} iterations, nested repeats ` +
      `multiplied (got ${iterations})`
    );
  }
  return repeatUnboundedProblem(template.$type, template.input, args, iterations);
}

/** `merge` reads other steps through `input.fields[*].$ref`, which is not a reference object. */
export function isMergeStepType(stepType: unknown): boolean {
  return typeof stepType === 'string' && stepType.toLowerCase() === 'merge';
}

/** The refusal for a `merge` step whose sources cannot be read for certain. */
export const MERGE_SHAPE_ERROR =
  'a merge step needs a "fields" object whose entries each carry a string "$ref" and a "reduce"';

/**
 * The step or `$arguments` each field of a `merge` reads, or `null` when that
 * cannot be read for certain (same fail-closed rule as `readRepeatInput`).
 */
function readMergeSources(input: unknown): string[] | null {
  if (!isPlainObject(input)) return null;
  if (Object.keys(input).some((key) => key !== 'fields' && key.toLowerCase() === 'fields')) {
    return null;
  }
  const { fields } = input;
  if (!isPlainObject(fields)) return null;
  const sources: string[] = [];
  for (const field of Object.values(fields)) {
    if (!isPlainObject(field)) return null;
    if (Object.keys(field).some((key) => key !== '$ref' && key.toLowerCase() === '$ref')) {
      return null;
    }
    // Without `reduce` the entry is a plain reference object, which the
    // orchestrator replaces with whatever it points at before reading the field.
    if (typeof field.$ref !== 'string' || !('reduce' in field)) return null;
    sources.push(field.$ref);
  }
  return sources;
}

/**
 * How many generations a step runs: 1, or for a `repeat` its iteration count
 * with nested repeats multiplied (never less than 1). Only meaningful for an
 * input `repeatUnboundedProblem` accepted.
 */
export function blockStepGenerations(stepType: string, input: unknown, args: unknown): number {
  if (!isRepeatStepType(stepType)) return 1;
  const repeat = readRepeatInput(input);
  const items = repeat ? readArgumentsArray(args, repeat.forClause.path) : null;
  if (!repeat || !items) return 1;
  return Math.max(
    1,
    items.length * blockStepGenerations(repeat.template.$type, repeat.template.input, args)
  );
}

/**
 * Every `$type` a step can run — its own and, for a `repeat`, its template's.
 *
 * Returns `null` for a `repeat` it cannot follow (see `readRepeatInput`) or one
 * nested deeper than `REPEAT_NESTING_MAX`, so a caller refuses the body instead
 * of checking only part of it.
 */
export function collectBlockStepTypes(stepType: string, input: unknown): string[] | null {
  return collectBlockStepTemplates(stepType, input)?.map((step) => step.$type) ?? null;
}

/** `collectBlockStepTypes` with each step's input: the step itself, then each `repeat` template. */
export function collectBlockStepTemplates(
  stepType: string,
  input: unknown
): Array<{ $type: string; input: unknown }> | null {
  const steps: Array<{ $type: string; input: unknown }> = [];
  let currentType = stepType;
  let currentInput = input;
  for (let depth = 0; depth <= REPEAT_NESTING_MAX; depth += 1) {
    steps.push({ $type: currentType, input: currentInput });
    if (!isRepeatStepType(currentType)) return steps;
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

type WalkState = { refs: number; loopVars: Set<string> };

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
 * Check one step's input. Two step types name their sources outside a reference
 * object and are read by shape: `repeat` (its `for` clause, with the `as` name a
 * legal source inside its template) and `merge` (its fields).
 */
function checkStepInput(
  stepType: unknown,
  input: unknown,
  depth: number,
  sources: ReadonlySet<string>,
  state: WalkState
): string | null {
  if (isMergeStepType(stepType)) {
    const mergeSources = readMergeSources(input);
    if (!mergeSources) return MERGE_SHAPE_ERROR;
    for (const source of mergeSources) {
      // A merge waits on its sources as STEPS, so a loop variable is not one.
      if (state.loopVars.has(source)) {
        return `a merge field cannot read the repeat variable ${JSON.stringify(source)}`;
      }
      const problem = checkSource(source, sources, state);
      if (problem) return problem;
    }
    return checkValue(input, depth, sources, state);
  }
  if (!isRepeatStepType(stepType)) return checkValue(input, depth, sources, state);
  const repeat = readRepeatInput(input);
  if (!repeat) return REPEAT_SHAPE_ERROR;
  const { forClause, template } = repeat;
  const sourceProblem = checkSource(forClause.$ref, sources, state);
  if (sourceProblem) return sourceProblem;
  state.loopVars.add(forClause.as);
  return checkStepInput(
    template.$type,
    template.input,
    depth + 2,
    new Set([...sources, forClause.as]),
    state
  );
}

/**
 * Resolve a `kind:'workflow'` body's step names and check its reference graph.
 *
 * The rules (every refusal but the first and the repeat-variable one names the
 * step index):
 *  - at most `WORKFLOW_MAX_STEPS` steps;
 *  - a name is `[a-z][a-z0-9_-]{0,31}`, or exactly the step's own positional
 *    `$<index>`; names are unique; `block-step` is reserved. A step given no
 *    name is named `$<index>`;
 *  - every source a step reads — a reference, a `repeat`'s `for` clause, a
 *    `merge` field — names `$arguments` or an EARLIER step, so the graph has no
 *    cycle and no self-reference. Inside a `repeat` template the loop variable
 *    (`for.as`) is a source too;
 *  - a `repeat` iterates only an array in `arguments`, at most
 *    `WORKFLOW_REPEAT_MAX_ITERATIONS` times (`workflow_repeat_unbounded`);
 *  - at most `WORKFLOW_MAX_REFS` references, and no input nested deeper than
 *    `WORKFLOW_INPUT_DEPTH_MAX`.
 *
 * `input` is never copied or rewritten: each resolved step carries the caller's
 * own object.
 */
export function resolveBlockWorkflowGraph(body: {
  steps: readonly BlockWorkflowStepInput[];
  arguments?: Record<string, unknown>;
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
  const state: WalkState = { refs: 0, loopVars: new Set() };

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
    const unbounded = repeatUnboundedProblem(step.$type, step.input, body.arguments);
    if (unbounded) {
      return {
        ok: false,
        errorCode: 'workflow_repeat_unbounded',
        error: `workflow step ${index}: ${unbounded}`,
      };
    }
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
      generations: blockStepGenerations(step.$type, step.input, body.arguments),
    });
  }
  // A repeat variable that is also a step name (or `$arguments`) would make a
  // template reference ambiguous between the two.
  for (const loopVar of state.loopVars) {
    if (earlier.has(loopVar)) {
      return {
        ok: false,
        errorCode: 'workflow_ref_invalid',
        error: `a repeat "as" name ${JSON.stringify(
          loopVar
        )} is also a step name or "${WORKFLOW_ARGUMENTS_REF}"`,
      };
    }
  }
  return { ok: true, steps };
}
