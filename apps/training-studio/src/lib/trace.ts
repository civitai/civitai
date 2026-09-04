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

/** Tail the trace stream, calling `onLine` with each complete line as it arrives. Resolves `{ready:false}`
 *  on a 404 (the worker hasn't written its first line yet — caller should retry), or `{ready:true}` once
 *  the stream opens and closes. Rejects only on abort or a hard error. */
export async function tailTrace(
  traceUrl: string,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<{ ready: boolean }> {
  const res = await fetch(`/api/trace?url=${encodeURIComponent(traceUrl)}`, { signal });
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
