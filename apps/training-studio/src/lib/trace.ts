// Client side of the live training trace: tail the stream and hand each line to the caller. Works for both
// trace modes — `events` lines are NDJSON objects, `logs` lines are plain text (parseTraceLine falls back
// to raw text when a line isn't JSON).

import { isDev } from '$lib/host';

export const isAbort = (err: unknown) => (err as DOMException | undefined)?.name === 'AbortError';

/** One parsed `events`-mode line: a unix-ms `t`, a `type`, its `epoch`, and type-specific fields. */
export interface TraceEvent {
  t?: number;
  type?: string;
  epoch?: number;
  [key: string]: unknown;
}

/** Tail the trace stream, calling `onLine` with each complete line as it arrives. Resolves `{ready:false}`
 *  on a 404 (the worker hasn't written its first line yet — caller should retry), or `{ready:true}` once
 *  the stream opens and closes. Rejects only on abort or a hard error.
 *
 *  In PROD the browser tails the orchestrator's `streaming-blobs` URL DIRECTLY — Cloudflare buffers a
 *  proxied stream so it never arrives live, and the orchestrator's CORS allows the app's civitai.com
 *  origin. In DEV that same cross-origin fetch has no CORS grant for `localhost`, so the browser never
 *  gets response headers and hangs; there we route through the `/api/trace` proxy (Node isn't CORS-gated)
 *  purely so local testing works. The proxy must NOT be relied on in prod. */
export async function tailTrace(
  traceUrl: string,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<{ ready: boolean }> {
  const url = isDev ? `/api/trace?url=${encodeURIComponent(traceUrl)}` : traceUrl;
  const res = await fetch(url, { signal });
  if (res.status === 404) return { ready: false };
  if (!res.ok || !res.body) throw new Error(`trace failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  const tail = buffer.trim();
  if (tail) onLine(tail);
  return { ready: true };
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/** A trace's identity across polls. Its presigned query is re-signed on every workflow poll while the
 *  path stays fixed per epoch, so keying on the full URL restarts the stream every ~5s. */
export const tracePath = (url: string) => url.split('?')[0];

/** How one tail attempt ended: the stream closed, it 404'd (not written yet), or it errored. */
export type TraceAttempt = 'complete' | 'missing' | 'failed';

/** Tail a trace until its stream closes, retrying while `keepTrying(attempt)` says so. `getUrl` is
 *  re-read on every attempt: the presigned URL is re-signed on each workflow poll, so a once-captured
 *  one expires mid-retry and 403/404-loops forever. Rejects only on abort. */
export async function followTrace(
  getUrl: () => string,
  onLine: (line: string) => void,
  signal: AbortSignal,
  keepTrying: (attempt: TraceAttempt) => boolean
): Promise<TraceAttempt> {
  for (;;) {
    let attempt: TraceAttempt;
    try {
      attempt = (await tailTrace(getUrl(), onLine, signal)).ready ? 'complete' : 'missing';
    } catch (err) {
      if (isAbort(err)) throw err;
      attempt = 'failed';
    }
    if (attempt === 'complete' || !keepTrying(attempt)) return attempt;
    await sleep(2000, signal);
  }
}

export type ParsedTraceLine = { kind: 'event'; event: TraceEvent } | { kind: 'text'; text: string };

/** Parse an `events`-mode NDJSON line to a `TraceEvent`; a non-JSON (`logs`-mode) line comes back as text. */
export function parseTraceLine(line: string): ParsedTraceLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === 'object') return { kind: 'event', event: parsed as TraceEvent };
  } catch {
    // plain-text log line
  }
  return { kind: 'text', text: line };
}

/** The ai-toolkit worker's per-epoch phases, plus a synthetic `generating_samples` we infer from the
 *  "Generating Images:" log line (the worker emits that as text, not a phase event). */
export type TrainingPhase =
  | 'loading_base_model'
  | 'copying_previous_epoch'
  | 'training'
  | 'uploading'
  | 'generating_samples';

export const PHASE_LABEL: Record<TrainingPhase, string> = {
  loading_base_model: 'Loading base model',
  copying_previous_epoch: 'Preparing epoch',
  training: 'Training',
  uploading: 'Saving checkpoint',
  generating_samples: 'Generating preview samples',
};

const WORKER_PHASES = new Set<string>([
  'loading_base_model',
  'copying_previous_epoch',
  'training',
  'uploading',
]);

/** The one signal a trace line carries for the friendly status view. `noise` = a line we keep in the raw
 *  log but that drives no status (timer blocks, "Saved optimizer", "Removing old save", unknown JSON);
 *  `loss` = a per-step loss reading, which only the loss graph shows. */
export type TraceSignal =
  | { kind: 'phase'; phase: TrainingPhase; epoch: number | null }
  | {
      kind: 'step';
      step: number;
      maxSteps: number;
      stepsRemaining: number | null;
      secondsPerStep: number | null;
    }
  | { kind: 'epoch-done'; epoch: number }
  | { kind: 'attempt'; epoch: number | null }
  | { kind: 'loss' }
  | { kind: 'noise' };

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Human-readable text for one trace line in the raw log — a `log` event shows just its message (not the
 *  raw JSON envelope), structured events render a compact summary, plain text passes through. Keeps the
 *  log legible instead of a wall of `{"type":"log","message":…}`. */
export function traceLineText(line: string): string {
  const parsed = parseTraceLine(line);
  if (parsed.kind === 'text') return parsed.text;
  const e = parsed.event;
  const message = e.message ?? e.msg ?? e.text ?? e.log;
  if (typeof message === 'string') return message;
  const step = finite(e.step);
  const maxSteps = finite(e.maxSteps);
  const epoch = finite(e.epoch);
  switch (e.type) {
    case 'step':
      return step !== null ? `step ${step}${maxSteps !== null ? ` / ${maxSteps}` : ''}` : line;
    case 'phase':
      return typeof e.phase === 'string' ? `phase: ${e.phase}` : line;
    case 'epoch':
      return epoch !== null ? `epoch ${epoch} checkpoint saved` : line;
    case 'attempt':
      return epoch !== null ? `epoch ${epoch} starting` : 'epoch starting';
    default:
      return line;
  }
}

/** Interpret one trace line into a structured status signal. The `step` event's own `epoch` field is the
 *  worker's internal dataset-epoch counter (44, 49, …), which differs from the checkpoint epoch the user
 *  sees (10); only `attempt`/`phase`/`epoch` events carry the checkpoint epoch, so step signals don't. */
export function interpretTraceLine(line: string): TraceSignal {
  const parsed = parseTraceLine(line);
  if (parsed.kind === 'text') {
    if (/^Generating Images:/i.test(parsed.text)) {
      return { kind: 'phase', phase: 'generating_samples', epoch: null };
    }
    return { kind: 'noise' };
  }
  const e = parsed.event;
  const epoch = finite(e.epoch);
  switch (e.type) {
    case 'phase': {
      const p =
        typeof e.phase === 'string' && WORKER_PHASES.has(e.phase)
          ? (e.phase as TrainingPhase)
          : null;
      return p ? { kind: 'phase', phase: p, epoch } : { kind: 'noise' };
    }
    case 'step': {
      const step = finite(e.step);
      const maxSteps = finite(e.maxSteps);
      if (step === null || maxSteps === null || maxSteps <= 0) return { kind: 'noise' };
      return {
        kind: 'step',
        step,
        maxSteps,
        stepsRemaining: finite(e.epochStepsRemaining),
        secondsPerStep: finite(e.secondsPerStep),
      };
    }
    case 'epoch':
      return epoch !== null ? { kind: 'epoch-done', epoch } : { kind: 'noise' };
    case 'attempt':
      return { kind: 'attempt', epoch };
    case 'loss':
      return { kind: 'loss' };
    default:
      return { kind: 'noise' };
  }
}

/** One training step's loss reading(s), keyed by the trainer's own loss names (`loss`, `fft_loss`, …). */
export interface LossPoint {
  step: number;
  losses: Record<string, number>;
  lr: number | null;
}

// ai-toolkit reports loss only in its tqdm postfix — `… 20/200 [00:08<01:12, 2.48it/s, lr: 1.0e-04 loss: 3.213e-01]`.
// The worker's log capture strips `\r`, so a run of redraws arrives concatenated on ONE line: match globally.
const TQDM_REDRAW = /(\d+)\/\d+ \[([^\]]*)\]/g;
const POSTFIX_PAIR = /([A-Za-z_][\w/.-]*): ([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;

function lossPointsFromText(text: string): LossPoint[] {
  const points: LossPoint[] = [];
  for (const [, step, postfix] of text.matchAll(TQDM_REDRAW)) {
    const losses: Record<string, number> = {};
    let lr: number | null = null;
    for (const [, key, raw] of postfix.matchAll(POSTFIX_PAIR)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (key === 'lr') lr = value;
      else losses[key] = value;
    }
    if (Object.keys(losses).length) points.push({ step: Number(step), losses, lr });
  }
  return points;
}

function lossFields(value: unknown): Record<string, number> {
  const single = finite(value);
  if (single !== null) return { loss: single };
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      const n = finite(v);
      if (n !== null && key !== 'lr') out[key] = n;
    }
  }
  return out;
}

/** The loss readings one trace line carries: a structured event with `step` + `loss` (a number or a
 *  `{name: value}` map) and an optional `lr`, or tqdm redraws inside a `log` message / plain-text line. */
export function traceLossPoints(line: string): LossPoint[] {
  const parsed = parseTraceLine(line);
  if (parsed.kind === 'text') return lossPointsFromText(parsed.text);
  const e = parsed.event;
  const step = finite(e.step);
  const losses = lossFields(e.loss);
  if (step !== null && Object.keys(losses).length) return [{ step, losses, lr: finite(e.lr) }];
  return typeof e.message === 'string' ? lossPointsFromText(e.message) : [];
}
