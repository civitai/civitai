import { createHash } from 'crypto';

import { assertArmAllowed, EvalSafetyError, findPii } from './safety';
import type {
  DataClass,
  DecisionQuestion,
  DecisionResult,
  FormatSpec,
  ImageDecisionModel,
  ImageInput,
  ImageRef,
  ManifestItem,
  Prediction,
  TextDecisionModel,
} from './types';

export interface ImageSource {
  /** Resolves `'missing'` when the image has been deleted — an expected outcome, not an error. */
  fetch(ref: ImageRef): Promise<ImageInput | 'missing'>;
}

/** Holds bytes in memory only. Nothing here may write an image to disk. */
export class HttpImageSource implements ImageSource {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async fetch(ref: ImageRef): Promise<ImageInput | 'missing'> {
    const response = await this.fetchImpl(ref.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (response.status === 404 || response.status === 410) return 'missing';
    if (!response.ok) throw new Error(`image fetch returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (ref.sha256 && ref.sha256 !== sha256) {
      throw new Error('image bytes do not match the manifest sha256');
    }
    return { bytes, contentType: response.headers.get('content-type') ?? 'image/jpeg', sha256 };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function specHash(
  nodeId: string,
  specVersion: number,
  formatId: string,
  questions: readonly DecisionQuestion[]
): string {
  return createHash('sha256')
    .update(stableStringify({ nodeId, specVersion, formatId, questions }))
    .digest('hex')
    .slice(0, 16);
}

/** Predictions are reusable only under the same model configuration AND question spec. */
export function runKey(modelConfigId: string, spec: string): string {
  return createHash('sha256').update(`${modelConfigId}|${spec}`).digest('hex').slice(0, 16);
}

export type RunOptions = {
  items: readonly ManifestItem[];
  questions: readonly DecisionQuestion[];
  format: Pick<FormatSpec, 'mapAnswer'>;
  model: TextDecisionModel | ImageDecisionModel;
  dataClass: DataClass;
  runKey: string;
  imageSource?: ImageSource;
  /** Item ids already predicted under this run key; skipped, so a daily run only does new items. */
  done: ReadonlySet<string>;
  onPrediction(prediction: Prediction): void | Promise<void>;
};

export type RunSummary = {
  ran: number;
  skipped: number;
  missing: number;
  errors: number;
  refused: number;
};

function isImageModel(model: TextDecisionModel): model is ImageDecisionModel {
  return model.hosting === 'self-hosted' && 'decideWithImages' in model;
}

/**
 * Serial on purpose: the imajev server scores one request at a time, so
 * concurrency only lengthens latency. Safety failures abort the whole run;
 * a failed model call is recorded per item and retried on the next run.
 */
export async function runItems(opts: RunOptions): Promise<RunSummary> {
  assertArmAllowed(opts.dataClass, opts.model);
  const summary: RunSummary = { ran: 0, skipped: 0, missing: 0, errors: 0, refused: 0 };
  for (const item of opts.items) {
    if (opts.done.has(item.itemId)) {
      summary.skipped++;
      continue;
    }
    // Refused per item rather than halting the run: one false positive would
    // otherwise stop every later daily run at the same item.
    const pii = findPii(item.state);
    if (pii) {
      summary.refused++;
      await opts.onPrediction({
        itemId: item.itemId,
        runKey: opts.runKey,
        status: 'refused',
        error: `state.${pii.field} contains a ${pii.kind}-shaped string`,
      });
      continue;
    }
    const refs = item.imageRefs ?? [];
    if (refs.length > 0 && !isImageModel(opts.model)) {
      throw new EvalSafetyError(
        `item ${item.itemId} carries images; ${opts.model.configId} cannot take them`
      );
    }
    if (refs.length > 0 && !opts.imageSource) {
      throw new EvalSafetyError('items carry images but no imageSource was given');
    }
    const base = { itemId: item.itemId, runKey: opts.runKey };
    try {
      let result: DecisionResult;
      if (refs.length > 0) {
        const images: ImageInput[] = [];
        let missing = false;
        for (const ref of refs) {
          const image = await (opts.imageSource as ImageSource).fetch(ref);
          if (image === 'missing') {
            missing = true;
            break;
          }
          images.push(image);
        }
        if (missing) {
          summary.missing++;
          await opts.onPrediction({ ...base, status: 'missing' });
          continue;
        }
        result = await (opts.model as ImageDecisionModel).decideWithImages({
          state: item.state,
          questions: opts.questions,
          images,
        });
      } else {
        result = await opts.model.decide({ state: item.state, questions: opts.questions });
      }
      const mapped = opts.format.mapAnswer(result.answers);
      summary.ran++;
      await opts.onPrediction({
        ...base,
        status: 'ok',
        pred: mapped.pred,
        confidence: mapped.confidence,
        abstained: mapped.abstained,
        answers: result.answers,
        build: result.build,
        ...(result.hardware ? { hardware: result.hardware } : {}),
        latencyMs: Math.round(result.latencyMs),
      });
    } catch (error) {
      if (error instanceof EvalSafetyError) throw error;
      summary.errors++;
      await opts.onPrediction({
        ...base,
        status: 'error',
        error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
          0,
          200
        ),
      });
    }
  }
  return summary;
}

/** The default mapping for a single choice question; `abstainOptions` are content options meaning "cannot tell". */
export function choiceMapper(
  questionId: string,
  opts: { abstainOptions?: readonly string[] } = {}
): FormatSpec['mapAnswer'] {
  return (answers) => {
    const answer = answers.find((a) => a.id === questionId);
    if (!answer || answer.type !== 'choice') {
      throw new Error(`no choice answer for "${questionId}"`);
    }
    const pred = String(answer.value);
    const abstained = answer.abstained === true || (opts.abstainOptions ?? []).includes(pred);
    return {
      pred: abstained ? null : pred,
      confidence: answer.confidence ?? answer.probabilities?.[pred] ?? null,
      abstained,
    };
  };
}

/**
 * The inverse of `choiceMapper` where each class is an option key of the same name.
 * `unknownClasses` train as imajev's own unknown answer rather than as their option.
 */
export function choiceTargets(
  questionId: string,
  opts: { unknownClasses?: readonly string[] } = {}
): NonNullable<FormatSpec['trainTargets']> {
  return (gold) => ({
    [questionId]: (opts.unknownClasses ?? []).includes(gold) ? null : gold,
  });
}

/**
 * A failed call is retried on later runs, but only up to this many failures:
 * the server works one request at a time, so a permanently failing item would
 * otherwise spend a full timeout on every daily pass, forever.
 */
export const MAX_ATTEMPTS = 3;

/** Items not to send again: answered, missing, or out of attempts. */
export function doneItemIds(predictions: readonly Prediction[], key: string): Set<string> {
  const latest = new Map<string, Prediction>();
  const failures = new Map<string, number>();
  for (const p of predictions) {
    if (p.runKey !== key) continue;
    latest.set(p.itemId, p);
    if (p.status === 'error') failures.set(p.itemId, (failures.get(p.itemId) ?? 0) + 1);
  }
  return new Set(
    [...latest.values()]
      .filter((p) => p.status !== 'error' || (failures.get(p.itemId) ?? 0) >= MAX_ATTEMPTS)
      .map((p) => p.itemId)
  );
}
