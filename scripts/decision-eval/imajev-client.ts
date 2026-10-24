import { assertPrivateHost } from './safety';
import type {
  DecisionQuestion,
  HostKind,
  DecisionResult,
  ImageDecisionModel,
  ImageDecisionRequest,
  NormalizedAnswer,
  TextDecisionRequest,
} from './types';

export class ImajevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImajevError';
  }
}

/**
 * How the server was started. Rotations and calibration are launch flags, not
 * request fields, so they change the outputs without changing any request —
 * the run key has to carry them.
 */
export type ImajevLaunch = {
  /** The `--model-name` the server reports in every response. */
  modelName: string;
  adapterSha256: string;
  rotations: number;
  calibrationSha256: string | null;
  /** The card it ran on, e.g. "RTX 3090 24GB". */
  hardware: string;
};

export type ImajevClientOptions = {
  baseUrl: string;
  allowedHosts?: readonly string[];
  launch: ImajevLaunch;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const PROBABILITY_SUM_TOLERANCE = 0.02;

type WireQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };

export function toImajevQuestions(
  questions: readonly DecisionQuestion[]
): Record<string, WireQuestion> {
  const wire: Record<string, WireQuestion> = {};
  for (const q of questions) {
    if (q.id in wire) throw new ImajevError(`duplicate question id "${q.id}"`);
    if (q.type === 'choice') {
      wire[q.id] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.key, o.description])),
      };
    } else if (q.type === 'score') {
      wire[q.id] = { type: 'score', instructions: q.instructions, criteria: [...q.criteria] };
    } else {
      wire[q.id] = { type: 'noul', instructions: q.instructions };
    }
  }
  return wire;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ImajevError(`${path} is not a finite number`);
  }
  return value;
}

function optionalNum(value: unknown, path: string): number | null {
  return value === undefined || value === null ? null : num(value, path);
}

function optionalBool(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new ImajevError(`${path} is not a boolean`);
  return value;
}

function parseProbabilities(
  value: unknown,
  keys: readonly string[],
  path: string
): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImajevError(`${path}.probabilities is not an object`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key))
      throw new ImajevError(`${path}.probabilities has unknown key "${key}"`);
    out[key] = num(record[key], `${path}.probabilities.${key}`);
    sum += out[key];
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new ImajevError(`${path}.probabilities sums to ${sum.toFixed(4)}, not 1`);
  }
  return out;
}

export function parseImajevAnswer(question: DecisionQuestion, raw: unknown): NormalizedAnswer {
  const path = `answers.${question.id}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ImajevError(`${path} is missing or not an object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.type !== question.type) {
    throw new ImajevError(`${path}.type is "${String(r.type)}", asked "${question.type}"`);
  }
  const unknown = optionalNum(r.unknown_probability, `${path}.unknown_probability`);
  const abstained = optionalBool(r.abstained, `${path}.abstained`);
  if (question.type === 'choice') {
    const keys = question.options.map((o) => o.key);
    if (typeof r.choice !== 'string' || !keys.includes(r.choice)) {
      throw new ImajevError(`${path}.choice is not one of the declared options`);
    }
    return {
      id: question.id,
      type: 'choice',
      value: r.choice,
      probabilities: parseProbabilities(r.probabilities, keys, path),
      confidence: optionalNum(r.confidence, `${path}.confidence`),
      unknown,
      abstained,
    };
  }
  if (question.type === 'noul') {
    const p = num(r.noul, `${path}.noul`);
    if (p < 0 || p > 1) throw new ImajevError(`${path}.noul ${p} is outside [0,1]`);
    return {
      id: question.id,
      type: 'noul',
      value: p,
      probabilities: { yes: p, no: 1 - p },
      confidence: optionalNum(r.confidence, `${path}.confidence`),
      unknown,
      abstained,
    };
  }
  const index = num(r.score, `${path}.score`);
  if (index < 0 || index > question.criteria.length - 1) {
    throw new ImajevError(`${path}.score ${index} is outside the rubric`);
  }
  return {
    id: question.id,
    type: 'score',
    value: index,
    probabilities: null,
    confidence: optionalNum(r.confidence, `${path}.confidence`),
    unknown,
    abstained,
  };
}

/**
 * Client for the self-hosted imajev playground server (`POST /v1/systemone`).
 * The server scores one request at a time behind a lock, so the runner calls it
 * serially; the URL must be one we control.
 */
export class ImajevModel implements ImageDecisionModel {
  readonly hosting = 'self-hosted' as const;
  readonly zeroDataRetention = true;
  readonly hostKind: HostKind;
  readonly configId: string;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly launch: ImajevLaunch;

  constructor(opts: ImajevClientOptions) {
    const { url, kind } = assertPrivateHost(opts.baseUrl, opts.allowedHosts);
    this.hostKind = kind;
    this.endpoint = new URL('/v1/systemone', url);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.launch = opts.launch;
    const l = opts.launch;
    this.configId = `imajev:${l.modelName}:adapter=${l.adapterSha256}:rot=${l.rotations}:cal=${
      l.calibrationSha256 ?? 'none'
    }`;
  }

  decide(request: TextDecisionRequest): Promise<DecisionResult> {
    return this.post(request, []);
  }

  decideWithImages(request: ImageDecisionRequest): Promise<DecisionResult> {
    if (request.images.length > 2) throw new ImajevError('imajev takes at most 2 images');
    return this.post(request, request.images);
  }

  private async post(
    request: TextDecisionRequest,
    images: ImageDecisionRequest['images']
  ): Promise<DecisionResult> {
    const form = new FormData();
    form.append(
      'request',
      JSON.stringify({ state: request.state, questions: toImajevQuestions(request.questions) })
    );
    images.forEach((image, i) => {
      form.append(
        'image',
        new Blob([new Uint8Array(image.bytes)], { type: image.contentType }),
        `image-${i}`
      );
    });
    const started = performance.now();
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      body: form,
      // A redirect would re-send the images to a host the allowlist never saw.
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const latencyMs = performance.now() - started;
    // The body can echo state, which is user content; report the status only.
    if (!response.ok) throw new ImajevError(`imajev returned HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ImajevError('imajev response is not JSON');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ImajevError('imajev response is not an object');
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope.model !== this.launch.modelName) {
      throw new ImajevError(
        `imajev answered as "${String(envelope.model).slice(0, 64)}", expected "${
          this.launch.modelName
        }"`
      );
    }
    const answers = envelope.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new ImajevError('imajev response has no answers object');
    }
    const ids = new Set(request.questions.map((q) => q.id));
    for (const key of Object.keys(answers)) {
      if (!ids.has(key)) throw new ImajevError(`unknown answer key "${key.slice(0, 64)}"`);
    }
    return {
      answers: request.questions.map((q) =>
        parseImajevAnswer(q, (answers as Record<string, unknown>)[q.id])
      ),
      build: this.configId,
      hardware: this.launch.hardware,
      latencyMs,
    };
  }
}
