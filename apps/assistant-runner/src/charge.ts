/**
 * Passes a chat completion's response through untouched while reading what the call was charged:
 * orchestration's closing usage chunk carries it as `usage.cost`, in Buzz (0 for a free reply). The
 * same reading as `@civitai/components-chat`'s `chargeFetch`, which feeds the browser runner's spend
 * readout and which the package does not export. A response that is not a stream (a refusal, a
 * reused workflow's answer) carries no charge.
 */
export function chargeTap(inner: typeof fetch, onCharge: (buzz: number) => void): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      return response;
    const decoder = new TextDecoder();
    let partial = '';
    const read = (text: string) => {
      const lines = (partial + text).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ') || !line.includes('"cost"')) continue;
        try {
          const buzz = (JSON.parse(line.slice(6)) as { usage?: { cost?: unknown } | null }).usage
            ?.cost;
          if (typeof buzz === 'number' && Number.isFinite(buzz)) onCharge(buzz);
        } catch {
          // Not the usage chunk.
        }
      }
    };
    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          read(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          read(`${decoder.decode()}\n`);
        },
      })
    );
    return new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
