import { Air } from '@civitai/orchestration-client';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { isWorkflowOwnedBy } from '~/server/services/orchestrator/assert-workflow-owner';

// What an app-built step may put where. Only media positions (the keys below, and everything under
// them) take a reference to another step's output, a URL, or an orchestrator file; every other key
// takes literal values, so a key this list has not met yet is held to the stricter rule.
//
// The keys are the media input fields of the orchestrator's step inputs, as
// @civitai/orchestration-client's generated types name them, plus a training step's `trainingData`
// (its items are orchestrator blobs). Matched case-insensitively.
const MEDIA_KEYS: ReadonlySet<string> = new Set(
  [
    'image',
    'images',
    'imageUrl',
    'imageUrls',
    'sourceImage',
    'sourceImages',
    'sourceImageUrl',
    'startImage',
    'endImage',
    'endSourceImage',
    'firstFrame',
    'lastFrame',
    'firstFrameImage',
    'lastFrameImage',
    'middleImages',
    'middleFrameImage',
    'referenceImage',
    'referenceImages',
    'frontalImage',
    'markupImage',
    'textureImageUrl',
    'mask',
    'personMask',
    'subjectUrl',
    'subjectMaskUrl',
    'garmentUrl',
    'video',
    'videos',
    'videoUrl',
    'sourceVideo',
    'referenceVideos',
    'referenceVideoUrls',
    'additionalVideos',
    'audioUrl',
    'refAudioUrl',
    'sourceAudio',
    'targetAudio',
    'referenceAudios',
    'mediaUrl',
    'mediaUrls',
    'mesh',
    'sourceUrl',
    'trainingData',
  ].map((key) => key.toLowerCase())
);

// Chat text and tool schemas: free text by the generation input gate's own rule
// (`PASS_THROUGH_FREE_TEXT_PATHS` in blocks.router), so a URL there is text. A reference still is not.
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

const ARGUMENTS_REF = '$arguments';

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
  if (reference.$ref !== ARGUMENTS_REF || typeof reference.path !== 'string')
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

/**
 * The first value in `input` that sits outside a media position and is a reference, a URL, or an
 * orchestrator file the viewer does not own. Map keys count as values (LoRAs are keyed by AIR), and
 * a reference with no key above it (the whole input) is outside every media position.
 */
export function findStepPositionProblem(
  input: unknown,
  viewerId: number,
  workflowArguments?: unknown
): StepPositionProblem | null {
  const checkString = (raw: string, key: string): StepPositionProblem | null => {
    const value = raw.trim();
    if (URL_VALUE_RE.test(value)) return { form: 'url', key, host: hostOf(value) };
    if (!ORCHESTRATOR_SOURCE_RE.test(value)) return null;
    const parsed = Air.parseSafe(value);
    // A job file is `orchestrator:<jobId>@<file>`; a blob names no owner at all.
    const owned =
      parsed?.source.toLowerCase() === 'orchestrator' &&
      parsed.id.toLowerCase() !== 'blob' &&
      isWorkflowOwnedBy(parsed.id, viewerId);
    return owned ? null : { form: 'orchestrator-file', key };
  };

  // `key` is the nearest key above the value; below a media key everything is media, and below a
  // free-text key only references count.
  const visit = (
    value: unknown,
    key: string | undefined,
    inText = false
  ): StepPositionProblem | null => {
    if (isMediaKey(key)) return null;
    const text = inText || (key !== undefined && FREE_TEXT_KEYS.has(key.toLowerCase()));
    const at = key ?? '(input)';
    if (typeof value === 'string') return text ? null : checkString(value, at);
    if (Array.isArray(value)) {
      for (const item of value) {
        const problem = visit(item, key, text);
        if (problem) return problem;
      }
      return null;
    }
    if (!value || typeof value !== 'object') return null;
    const entries = Object.entries(value);
    const isReference = entries.some(([k]) => k.toLowerCase() === REF_KEY);
    // A repeat's `for` clause names the array it iterates; the items are placed by references
    // inside its template, which this walk checks where they land.
    const isRepeatClause =
      isReference && key?.toLowerCase() === 'for' && entries.some(([k]) => k === 'as');
    if (isReference && !isRepeatClause) {
      // A plain reference to the request's own `arguments` places a value this request carries,
      // so that value is checked where it lands. Any other reference is a value not known yet.
      const argument = argumentValue(value as Record<string, unknown>, workflowArguments);
      return argument.found ? visit(argument.value, key, text) : { form: 'reference', key: at };
    }
    for (const [childKey, child] of entries) {
      if (!isRepeatClause && !text) {
        const problem = checkString(childKey, at);
        if (problem) return problem;
      }
      const problem = visit(child, FIELD_KEY_RE.test(childKey) ? childKey : key, text);
      if (problem) return problem;
    }
    return null;
  };

  return visit(input, undefined);
}

export type StepPositionsMode = 'off' | 'log' | 'enforce';

/** `off` and `log` are the back-out; any other answer, a missing flag included, enforces. */
export async function getStepPositionsMode(): Promise<StepPositionsMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.APP_BLOCK_STEP_POSITIONS);
  return variant === 'off' || variant === 'log' ? variant : 'enforce';
}

/**
 * The refusal for the first step whose input breaks the position rule, or null. Each finding is
 * logged with the app, step type and key, never the value.
 */
export async function stepPositionsRefusal(opts: {
  appBlockId: string;
  viewerId: number;
  steps: ReadonlyArray<{ $type: string; input: unknown }>;
  workflowArguments?: unknown;
}): Promise<string | null> {
  for (const step of opts.steps) {
    const problem = findStepPositionProblem(step.input, opts.viewerId, opts.workflowArguments);
    if (!problem) continue;
    const mode = await getStepPositionsMode();
    if (mode === 'off') return null;
    logToAxiom({
      type: 'warning',
      name: 'app-step-position-refused',
      appBlockId: opts.appBlockId,
      stepType: step.$type,
      key: problem.key,
      form: problem.form,
      host: problem.host,
      mode,
    }).catch(() => undefined);
    if (mode === 'log') return null;
    return `step '${step.$type}' cannot take this value at '${problem.key}'; only media inputs take references, URLs or orchestrator files`;
  }
  return null;
}
