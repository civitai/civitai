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

/**
 * Case-fold for comparing keys and `$type`s: upper-casing first maps `ı` and `ſ`
 * onto I and S, so a key the orchestrator may bind ignoring case cannot hide.
 */
function fold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

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
  return typeof stepType === 'string' && fold(stepType) === 'repeat';
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
  return typeof stepType === 'string' && fold(stepType) === 'merge';
}

/** A merge input with `reduce` taken off each field, so each field reads as its reference. */
function withoutMergeReduce(input: unknown): unknown {
  if (!isPlainObject(input) || !isPlainObject(input.fields)) return input;
  const fields = Object.fromEntries(
    Object.entries(input.fields).map(([name, field]) => {
      if (!isPlainObject(field)) return [name, field];
      const { reduce: _reduce, ...ref } = field;
      return [name, ref];
    })
  );
  return { ...input, fields };
}

/** The refusal for a `merge` step whose sources cannot be read for certain. */
export const MERGE_SHAPE_ERROR =
  'a merge step needs a "fields" object whose entries each carry a string "$ref" and a "reduce"';

/**
 * The step or `$arguments` each field of a `merge` reads, or `null` when that
 * cannot be read for certain (same fail-closed rule as `readRepeatInput`).
 */
function readMergeSources(input: unknown): Array<{ source: string; path: unknown }> | null {
  if (!isPlainObject(input)) return null;
  if (Object.keys(input).some((key) => key !== 'fields' && fold(key) === 'fields')) {
    return null;
  }
  const { fields } = input;
  if (!isPlainObject(fields)) return null;
  const sources: Array<{ source: string; path: unknown }> = [];
  for (const field of Object.values(fields)) {
    if (!isPlainObject(field)) return null;
    if (Object.keys(field).some((key) => key !== '$ref' && fold(key) === '$ref')) {
      return null;
    }
    // Without `reduce` the entry is a plain reference object, which the
    // orchestrator replaces with whatever it points at before reading the field.
    if (typeof field.$ref !== 'string' || !('reduce' in field)) return null;
    sources.push({ source: field.$ref, path: field.path });
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

/**
 * Analysers: they read media and answer with text and labels only. A test walks
 * each one's declared output type at every depth and fails on any url-, blob- or
 * id-like field, so one that starts returning media cannot stay here.
 */
export const MEDIA_REF_ANALYSERS: readonly string[] = [
  'wdTagging',
  'mediaCaptioning',
  'mediaRating',
  'ageClassification',
  'audioCaptioning',
  'mediaHash',
  'videoMetadata',
];

const ANALYSER_TYPES: ReadonlySet<string> = new Set(
  MEDIA_REF_ANALYSERS.map((type) => type.toLowerCase())
);
/** The analysers' media inputs, from their declared input types. */
const ANALYSER_MEDIA_KEYS: ReadonlySet<string> = new Set(['mediaUrl', 'image', 'video']);

/**
 * Step `$type`s (lowercased) whose input can name an output destination. They take
 * literal input only: a referenced value could carry a destination key the
 * destination check never sees.
 */
const DESTINATION_STEP_TYPES: ReadonlySet<string> = new Set(['transcode']);
const DESTINATION_STEP_REF_ERROR = 'a transcode step takes literal input only, no references';
const WHOLE_INPUT_REF_ERROR = 'a step input must be an object, not a reference';

/**
 * Step `$type`s (lowercased) that may take a reference into media: generators
 * whose own output the platform scans before it is served, so what they make
 * from an earlier output carries a fresh verdict, plus `MEDIA_REF_ANALYSERS`.
 * Every other consumer may only reference text (`TEXT_REF_LEAVES`). 🔴 An
 * allow-list: a new `$type` starts refused.
 */
const MEDIA_REF_CONSUMERS: ReadonlySet<string> = new Set([
  ...MEDIA_REF_ANALYSERS.map((type) => type.toLowerCase()),
  'imagegen',
  'texttoimage',
  'imageupscaler',
  'imagebackgroundremoval',
  'videoenhancement',
  'videobackgroundremoval',
  'preprocessvideo',
  'videoupscaler',
  'videointerpolation',
]);

/**
 * `videoGen` engines whose output the platform scans itself. Other engines hand
 * moderation to their provider, so a reference would send an earlier output out
 * with no verdict of ours. 🔴 An allow-list: a new engine starts refused, and an
 * engine that is not a literal string (a reference, `$arguments`) fails closed.
 */
export const SCANNED_VIDEO_GEN_ENGINES: ReadonlySet<string> = new Set([
  'wan',
  'ltx2',
  'ltx2.3',
  'ltx2.5',
  'hunyuan',
  'mochi',
  'lightricks',
]);

/**
 * `provider` values whose output the platform scans. Any other value, or one that
 * is not a literal string, refuses.
 */
export const SCANNED_VIDEO_GEN_PROVIDERS: ReadonlySet<string> = new Set(['comfy', 'civitai']);

/**
 * Engines whose default route differs by version, so `provider` must be given and
 * scanned. The other scanned engines take media with no `provider`.
 */
export const VIDEO_GEN_ENGINES_NEEDING_PROVIDER: ReadonlySet<string> = new Set(['wan']);

const CHAT_IMAGE_MODALITY_ERROR = 'a chat step may not generate images';
/** The chat output modalities a block may ask for: an allow-list, so anything else refuses. */
const CHAT_OUTPUT_MODALITIES: ReadonlySet<string> = new Set(['text', 'audio']);

/** A chatCompletion input that asks for image output, or whose modalities cannot be read. */
export function chatImageModalityProblem(stepType: unknown, input: unknown): string | null {
  if (lowerType(stepType) !== 'chatcompletion' || !isPlainObject(input)) return null;
  if (hasRecasedTwin(input, 'modalities')) return CHAT_IMAGE_MODALITY_ERROR;
  if (!('modalities' in input)) return null;
  const { modalities } = input;
  if (!Array.isArray(modalities)) return CHAT_IMAGE_MODALITY_ERROR;
  return modalities.every(
    (m) => typeof m === 'string' && CHAT_OUTPUT_MODALITIES.has(m.toLowerCase())
  )
    ? null
    : CHAT_IMAGE_MODALITY_ERROR;
}

/**
 * The last path segments a non-media consumer may reference: text and scalar
 * fields that cannot carry a url, a blob id or a blob. Anything else fails closed.
 */
const TEXT_REF_LEAVES: ReadonlySet<string> = new Set(
  [
    'text',
    'content',
    'prompt',
    'negativePrompt',
    'enhancedPrompt',
    'caption',
    'captions',
    'summary',
    'title',
    'description',
    'lyrics',
    'transcript',
    'language',
    'tags',
    'tag',
    'labels',
    'label',
    'score',
    'scores',
    'nsfwLevel',
    'seed',
    'width',
    'height',
    'duration',
    'count',
    'status',
  ].map((leaf) => leaf.toLowerCase())
);

export const MEDIA_REF_ERROR =
  'this step may only reference text fields of other steps (a prompt, a caption, tags…), not ' +
  'their media, urls or ids';

export const WRITE_TARGET_ERROR =
  'a step input may not name an output destination or make its output public';

function lowerType(stepType: unknown) {
  return typeof stepType === 'string' ? fold(stepType) : '';
}

/** Whether `stepType` (with this literal `input`) may take a reference into media. */
export function acceptsMediaRefs(stepType: unknown, input: unknown): boolean {
  const type = lowerType(stepType);
  if (MEDIA_REF_CONSUMERS.has(type)) return true;
  if (!isPlainObject(input)) return false;
  if (type === 'videogen') {
    if (hasRecasedTwin(input, 'engine') || hasRecasedTwin(input, 'provider')) return false;
    if (typeof input.engine !== 'string' || !SCANNED_VIDEO_GEN_ENGINES.has(input.engine)) {
      return false;
    }
    if (!('provider' in input)) return !VIDEO_GEN_ENGINES_NEEDING_PROVIDER.has(input.engine);
    // A value is matched as the orchestrator reads it: ASCII, case-insensitive.
    return (
      typeof input.provider === 'string' &&
      /^[\x20-\x7e]+$/.test(input.provider) &&
      SCANNED_VIDEO_GEN_PROVIDERS.has(input.provider.toLowerCase())
    );
  }
  if (type === 'composemedia') {
    if (hasRecasedTwin(input, 'output') || !isPlainObject(input.output)) return false;
    return !hasRecasedTwin(input.output, 'type') && input.output.type === 'video';
  }
  return false;
}

/**
 * Whether `object` also carries `key` under another casing. Which twin the
 * orchestrator binds is not something this repo can know, so the check refuses.
 */
function hasRecasedTwin(object: Record<string, unknown>, key: string): boolean {
  return Object.keys(object).some((k) => k !== key && fold(k) === key);
}

/** A reference path that ends on a text field (`TEXT_REF_LEAVES`), never on media. */
export function isTextRefPath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  return !!last && TEXT_REF_LEAVES.has(fold(last));
}

/**
 * A path segment or field name that may hold media: a url, a blob, an id or a
 * media container. `Id` and `Uri` are matched by case so `grid`, `paid` and
 * `security` stay plain names.
 */
export function isMediaLikeSegment(segment: string): boolean {
  return (
    /url|blob|^uri|uris?$|^ids?$|^(images?|videos?|frames|svg|audio|model|mesh|samples?|preview|thumbnail)$/i.test(
      segment
    ) || /Uri|(Id|ID)s?$/.test(segment)
  );
}

/**
 * Whether a reference may reach media. Another step's output (or a repeat
 * variable) must end on a known text leaf; `$arguments` are the app's own values,
 * so only a path that names a url, an id or a blob container is refused there.
 */
export function refMayReachMedia(source: string, path: unknown): boolean {
  if (source !== WORKFLOW_ARGUMENTS_REF) return !isTextRefPath(path);
  if (typeof path !== 'string') return true;
  return path
    .split(/[.[\]]+/)
    .filter(Boolean)
    .some(isMediaLikeSegment);
}

const TOO_DEEP = Symbol('too deep');

/**
 * The first key naming an output destination, at any depth, or `null`. Past
 * `WORKFLOW_INPUT_DEPTH_MAX` it returns `TOO_DEEP` rather than stop looking.
 */
function findWriteTargetKey(value: unknown): string | typeof TOO_DEEP | null {
  return findKey(value, (key) => fold(key).includes('destination') || fold(key) === 'public');
}

/** The first key at any depth that `matches`, `TOO_DEEP` past the depth limit, or `null`. */
function findKey(
  value: unknown,
  matches: (key: string) => boolean,
  depth = 0
): string | typeof TOO_DEEP | null {
  if (typeof value !== 'object' || value === null) return null;
  if (depth > WORKFLOW_INPUT_DEPTH_MAX) return TOO_DEEP;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findKey(entry, matches, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key)) return key;
    const found = findKey(entry, matches, depth + 1);
    if (found) return found;
  }
  return null;
}

const isRefKey = (key: string) => fold(key) === '$ref';

/**
 * Why a step input may not be submitted as-is: it names an output destination,
 * or is too deep to check for one. `null` when neither.
 */
export function writeTargetProblem(input: unknown): string | null {
  const found = findWriteTargetKey(input);
  if (found === TOO_DEEP) return `input is nested deeper than ${WORKFLOW_INPUT_DEPTH_MAX} levels`;
  return found ? WRITE_TARGET_ERROR : null;
}

/** The orchestrator's reference predicate: `$ref` and `path`, and no other key but `default`/`format`. */
function isRefObject(value: Record<string, unknown>): boolean {
  if (!('$ref' in value) || !('path' in value)) return false;
  for (const key of Object.keys(value)) if (!REF_KEYS.has(key)) return false;
  return true;
}

const RECASED_REF_ERROR = 'a reference key must be spelled "$ref", "path", "default" or "format"';

/**
 * An object with `$ref` under any casing and a reference key spelled otherwise.
 * Whether the orchestrator binds a re-cased key is not something this repo can
 * know, so such an object is refused rather than walked as plain data.
 */
const MALFORMED_REF_ERROR = 'a reference may carry only "$ref", "path", "default" and "format"';

/** `$ref` and `path` with another key: not a reference here, and not plain data either. */
function isMalformedRef(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.some(isRefKey) &&
    keys.some((key) => fold(key) === 'path') &&
    keys.some((key) => !REF_KEYS.has(fold(key)))
  );
}

function hasRecasedRefKey(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!keys.some(isRefKey)) return false;
  return keys.some((key) => REF_KEYS.has(fold(key)) && !REF_KEYS.has(key));
}

type WalkState = { refs: number; loopVars: Set<string>; mediaRefsAllowed: boolean };

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
  if (hasRecasedRefKey(object)) return RECASED_REF_ERROR;
  if (isMalformedRef(object)) return MALFORMED_REF_ERROR;
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
    const sourceProblem = checkSource(object.$ref, sources, state);
    if (sourceProblem) return sourceProblem;
    if (!state.mediaRefsAllowed && refMayReachMedia(object.$ref, object.path)) {
      return MEDIA_REF_ERROR;
    }
    // A default stands in for the reference, so it is held to the same rules.
    return checkValue(object.default, depth + 1, sources, state);
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
  const writeTarget = writeTargetProblem(input);
  if (writeTarget) return writeTarget;
  const chatImages = chatImageModalityProblem(stepType, input);
  if (chatImages) return chatImages;
  if (isPlainObject(input) && findKey(input, isRefKey, 0) !== null) {
    if (isRefObject(input) || hasRecasedRefKey(input)) return WHOLE_INPUT_REF_ERROR;
    if (DESTINATION_STEP_TYPES.has(lowerType(stepType))) return DESTINATION_STEP_REF_ERROR;
  }
  state.mediaRefsAllowed = acceptsMediaRefs(stepType, input);
  if (ANALYSER_TYPES.has(lowerType(stepType))) {
    if (!isPlainObject(input)) state.mediaRefsAllowed = false;
  }
  if (ANALYSER_TYPES.has(lowerType(stepType)) && isPlainObject(input)) {
    // An analyser takes media on its media field only; its free-text fields are text.
    for (const [key, value] of Object.entries(input)) {
      state.mediaRefsAllowed = ANALYSER_MEDIA_KEYS.has(key);
      const problem = checkValue(value, depth + 1, sources, state);
      if (problem) return problem;
    }
    return null;
  }
  if (isMergeStepType(stepType)) {
    const mergeSources = readMergeSources(input);
    if (!mergeSources) return MERGE_SHAPE_ERROR;
    for (const { source, path } of mergeSources) {
      // A merge waits on its sources as STEPS, so a loop variable is not one.
      if (state.loopVars.has(source)) {
        return `a merge field cannot read the repeat variable ${JSON.stringify(source)}`;
      }
      if (refMayReachMedia(source, path)) return MEDIA_REF_ERROR;
    }
    // Each field is a reference plus `reduce`: walked as the reference it holds.
    return checkValue(withoutMergeReduce(input), depth, sources, state);
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
  // A `$arguments` reference resolves to whatever the arguments hold, so a
  // destination key there reaches a step input the per-step check never saw.
  const argumentsRef = findKey(body.arguments, isRefKey);
  if (argumentsRef !== null && argumentsRef !== TOO_DEEP) {
    return {
      ok: false,
      errorCode: 'workflow_ref_invalid',
      error: 'workflow arguments may not hold a reference',
    };
  }
  const argumentsTarget = findWriteTargetKey(body.arguments);
  if (argumentsTarget) {
    return {
      ok: false,
      errorCode: 'workflow_ref_invalid',
      error:
        argumentsTarget === TOO_DEEP
          ? `workflow arguments are nested deeper than ${WORKFLOW_INPUT_DEPTH_MAX} levels`
          : `workflow arguments: ${WRITE_TARGET_ERROR}`,
    };
  }

  const steps: ResolvedBlockWorkflowStep[] = [];
  const earlier = new Set<string>([WORKFLOW_ARGUMENTS_REF]);
  const taken = new Set<string>();
  const state: WalkState = { refs: 0, loopVars: new Set(), mediaRefsAllowed: false };

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
