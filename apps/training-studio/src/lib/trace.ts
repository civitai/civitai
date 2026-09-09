// Client side of the live training trace: tail the proxied stream and hand each line to the caller. Works
// for both trace modes — `events` lines are NDJSON objects, `logs` lines are plain text (parseTraceLine
// falls back to raw text when a line isn't JSON).

export const isAbort = (err: unknown) => (err as DOMException | undefined)?.name === 'AbortError';

/** One parsed `events`-mode line: a unix-ms `t`, a `type`, its `epoch`, and type-specific fields. */
export interface TraceEvent {
  t?: number;
  type?: string;
  epoch?: number;
  [key: string]: unknown;
}

/** Open the trace stream. Prefer the orchestrator URL DIRECTLY — no backend hop, and a directly-consumed
 *  stream survives Cloudflare (which buffers a proxied stream, so live trace never arrives behind it). Falls
 *  back to the server proxy only when the browser can't read the orch response cross-origin (no CORS
 *  headers) — that path throws, and we retry through `/api/trace`. The traceUrl is presigned, so a direct
 *  fetch needs no credentials. */
async function openTraceStream(traceUrl: string, signal: AbortSignal): Promise<Response> {
  try {
    const direct = await fetch(traceUrl, { signal });
    // 404 = not written yet (caller retries); a readable 2xx = the orch permits cross-origin reads.
    if (direct.status === 404 || (direct.ok && direct.body)) return direct;
  } catch (err) {
    if (isAbort(err)) throw err;
    // Opaque cross-origin (CORS) or network failure — fall back to the proxy below.
  }
  return fetch(`/api/trace?url=${encodeURIComponent(traceUrl)}`, { signal });
}

/** Tail the trace stream, calling `onLine` with each complete line as it arrives. Resolves `{ready:false}`
 *  on a 404 (the worker hasn't written its first line yet — caller should retry), or `{ready:true}` once
 *  the stream opens and closes. Rejects only on abort or a hard error. */
export async function tailTrace(
  traceUrl: string,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<{ ready: boolean }> {
  const res = await openTraceStream(traceUrl, signal);
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
 *  log but that drives no status (timer blocks, "Saved optimizer", "Removing old save", unknown JSON). */
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
    default:
      return { kind: 'noise' };
  }
}
