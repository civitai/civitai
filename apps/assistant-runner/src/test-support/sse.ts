import type { RunEvent } from '@civitai/components-chat/runner-protocol';

export interface ReadEntry {
  id: number;
  event: RunEvent;
}

/**
 * Reads a run's event stream as a client does, until `run-ended` (or `stopWhen` says so, or
 * `timeoutMs` passes, which throws). Returns the events with their ids.
 */
export async function readEvents(
  url: string,
  headers: Record<string, string>,
  options: {
    lastEventId?: number;
    stopWhen?: (entry: ReadEntry) => boolean;
    timeoutMs?: number;
  } = {}
): Promise<ReadEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`no run-ended within ${options.timeoutMs ?? 30_000} ms`)),
    options.timeoutMs ?? 30_000
  );
  const entries: ReadEntry[] = [];
  try {
    const response = await fetch(url, {
      headers: {
        ...headers,
        accept: 'text/event-stream',
        ...(options.lastEventId !== undefined
          ? { 'last-event-id': String(options.lastEventId) }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id === undefined || data === undefined) continue;
        const entry = { id: Number(id), event: JSON.parse(data) as RunEvent };
        entries.push(entry);
        if (entry.event.type === 'run-ended' || options.stopWhen?.(entry)) {
          controller.abort();
          return entries;
        }
      }
    }
    return entries;
  } catch (error) {
    if (
      controller.signal.aborted &&
      entries.at(-1) &&
      (entries.at(-1)!.event.type === 'run-ended' || options.stopWhen?.(entries.at(-1)!))
    )
      return entries;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
