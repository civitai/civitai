/** What one chat completion answers: words, tool calls, or both. */
export interface FakeAnswer {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

interface FakeWorkflow {
  id: string;
  status: string;
  answer: FakeAnswer;
  /** The step output a status read shows; unset until the workflow succeeded. */
  output?: unknown;
  /** Statuses the next status reads answer, one each; the last one stays. */
  script: string[];
}

/**
 * Orchestration's chat completions as the runner's model sees them (civitai-orchestration
 * `ChatCompletionsController` and the consumer workflow routes): each `POST /v1/chat/completions`
 * makes a workflow, names it in `X-Civitai-Workflow-Id` and streams its answer as SSE; the workflow
 * runs to its end whether or not anyone reads the stream (a client going away does not cancel it);
 * `GET /v2/consumer/workflows/{id}` reads its status and, once it succeeded, its `chatCompletion`
 * step's output; `PUT` with `{"status":"canceled"}` cancels it. Every request lands in `order`.
 */
export class FakeChatOrchestration {
  readonly workflows = new Map<string, FakeWorkflow>();
  readonly posts: { id: string; body: Record<string, unknown> }[] = [];
  readonly gets: string[] = [];
  readonly puts: { id: string; body: unknown }[] = [];
  readonly #queued: { id: string; answer: FakeAnswer; hold: boolean }[] = [];
  readonly #gates = new Map<string, () => void>();
  readonly #unreadable = new Map<string, number>();

  constructor(readonly order: string[] = []) {}

  /** The next POST is answered as `id` with `answer`; with `hold`, its stream waits for `release`. */
  next(id: string, answer: FakeAnswer, options: { hold?: boolean } = {}): this {
    this.#queued.push({ id, answer, hold: options.hold === true });
    return this;
  }

  /** Lets a held stream go on. */
  release(id: string): void {
    this.#gates.get(id)?.();
  }

  /** Ends a workflow as orchestration would on its own, whether or not its stream was read. */
  succeed(id: string): void {
    const workflow = this.workflows.get(id)!;
    workflow.status = 'succeeded';
    workflow.output = outputOf(workflow);
  }

  /** The statuses the next reads of `id` answer, in order (the last one stays). */
  script(id: string, statuses: string[], answer?: FakeAnswer): void {
    const workflow = this.workflows.get(id) ?? {
      id,
      status: statuses[0]!,
      answer: answer ?? {},
      script: [],
    };
    if (answer) workflow.answer = answer;
    workflow.script = [...statuses];
    this.workflows.set(id, workflow);
  }

  /** The next `times` status reads of `id` fail (500); every one, unless `times` is given. */
  failReads(id: string, times = Infinity): void {
    this.#unreadable.set(id, times);
  }

  /** Replaces what a succeeded workflow's status read shows as its step output. */
  setOutput(id: string, output: unknown): void {
    const workflow = this.workflows.get(id)!;
    workflow.status = 'succeeded';
    workflow.output = output;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v2/consumer/free-tier') return Response.json({ enabled: false });
    if (method === 'POST' && url.pathname === '/v1/chat/completions')
      return this.#post(JSON.parse(String(init!.body)) as Record<string, unknown>, init?.signal);
    const match = /^\/v2\/consumer\/workflows\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('', { status: 404 });
    const id = decodeURIComponent(match[1]!);
    const workflow = this.workflows.get(id);
    if (method === 'PUT') {
      const body: unknown = JSON.parse(String(init!.body));
      this.puts.push({ id, body });
      this.order.push(`put ${id}`);
      if (!workflow) return new Response('', { status: 404 });
      if (!['succeeded', 'failed', 'expired', 'canceled'].includes(workflow.status))
        workflow.status = 'canceled';
      workflow.script = [];
      return Response.json({ id, status: workflow.status });
    }
    this.gets.push(id);
    this.order.push(`get ${id}`);
    if (!workflow) return new Response('', { status: 404 });
    const failing = this.#unreadable.get(id) ?? 0;
    if (failing > 0) {
      this.#unreadable.set(id, failing - 1);
      return new Response('', { status: 500 });
    }
    if (workflow.script.length) {
      workflow.status = workflow.script.length > 1 ? workflow.script.shift()! : workflow.script[0]!;
      if (workflow.status === 'succeeded') workflow.output ??= outputOf(workflow);
    }
    return Response.json({
      id,
      status: workflow.status,
      steps: [
        {
          $type: 'chatCompletion',
          name: '$0',
          status: workflow.status,
          ...(workflow.status === 'succeeded' && workflow.output !== undefined
            ? { output: workflow.output }
            : {}),
        },
      ],
    });
  };

  #post(body: Record<string, unknown>, signal: AbortSignal | null | undefined): Response {
    const queued = this.#queued.shift();
    if (!queued) return Response.json({ error: { message: 'no answer queued' } }, { status: 500 });
    const { id, answer, hold } = queued;
    this.posts.push({ id, body });
    this.order.push(`post ${id}`);
    const workflow: FakeWorkflow = { id, status: 'processing', answer, script: [] };
    this.workflows.set(id, workflow);
    const gate = hold
      ? new Promise<void>((resolve) => this.#gates.set(id, resolve))
      : Promise.resolve();
    const order = this.order;
    let read = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (read) return;
          read = true;
          order.push(`read ${id}`);
          const aborted = new Promise<never>((_, reject) => {
            if (signal?.aborted) reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          try {
            await Promise.race([gate, aborted]);
          } catch (error) {
            controller.error(error);
            return;
          }
          controller.enqueue(new TextEncoder().encode(sseOf(id, answer)));
          controller.close();
          if (workflow.status === 'processing') {
            workflow.status = 'succeeded';
            workflow.output = outputOf(workflow);
          }
        },
      },
      // No read-ahead: `pull` (and `read <id>` in `order`) happens only when someone reads the body.
      { highWaterMark: 0 }
    );
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'X-Civitai-Workflow-Id': id },
    });
  }
}

/** A `chatCompletion` step's output as the consumer API shows it (camelCase but for the message's own names). */
function outputOf(workflow: FakeWorkflow): unknown {
  const { text, toolCalls } = workflow.answer;
  return {
    id: `chatcmpl-${workflow.id}`,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'fake-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text ?? null,
          ...(toolCalls?.length
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  };
}

function sseOf(id: string, answer: FakeAnswer): string {
  const base = { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: 1, model: 'm' };
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(answer.text ? { content: answer.text } : {}),
            ...(answer.toolCalls?.length
              ? {
                  tool_calls: answer.toolCalls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }
              : {}),
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: answer.toolCalls?.length ? 'tool_calls' : 'stop' },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}
