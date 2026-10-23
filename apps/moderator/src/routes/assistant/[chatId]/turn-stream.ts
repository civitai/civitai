import type { TurnEvent } from '$lib/assistant/types';

/**
 * Posts one question and hands each streamed event to `onEvent` as it arrives. Resolves when the
 * stream ends; a refusal before the stream opens (no grant, a busy chat, the daily allowance) comes
 * back as an `error` event rather than a throw, so the page has one path for every failure.
 */
export async function streamTurn(
  chatId: number,
  body: { prompt: string; playbook: string | null; model: string },
  onEvent: (event: TurnEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/assistant/${chatId}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    onEvent({ type: 'error', error: 'Could not reach the server.' });
    return;
  }
  if (!res.ok || !res.body) {
    const payload = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    onEvent({
      type: 'error',
      error: payload?.error ?? payload?.message ?? `The request failed (${res.status}).`,
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const event = parseEvent(line);
        if (event) {
          if (event.type === 'done' || event.type === 'error') ended = true;
          onEvent(event);
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  // The connection dropped before the turn reported an outcome. It may still be running server-side
  // and will land in the transcript; say so rather than leaving the spinner.
  if (!ended && !signal?.aborted)
    onEvent({
      type: 'error',
      error: 'The connection closed before the answer arrived. Reload in a moment to see it.',
    });
}

function parseEvent(line: string): TurnEvent | null {
  try {
    return JSON.parse(line) as TurnEvent;
  } catch {
    return null;
  }
}
