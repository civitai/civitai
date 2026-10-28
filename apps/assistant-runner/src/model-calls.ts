import { createHash } from 'node:crypto';

import type pg from 'pg';

import { RUNNER_SCHEMA } from './grants';
import type { Logger } from './core/interfaces';
import type { TokenSource } from './minter';
import {
  FINAL_STATUSES,
  OrchestrationError,
  type OrchestrationClient,
  type WorkflowState,
} from './orchestration';

/** The model requests one stored orchestration workflow may answer. */
export interface ModelCallScope {
  runId: string;
  userId: string;
  conversationId: string;
  seq: number;
  /** Also a workflow an earlier run of the same turn sent (`ModelContext.carriesOn`). */
  carriesOn?: boolean;
}

/**
 * Which orchestration workflow each model request was sent as, kept the moment orchestration names
 * it (before its answer is read), so a request asked again after a crash finds it. Keyed by run and
 * by a hash of what the request asks (`callKey`). Holds ids only: never a token.
 */
export interface ModelCallLedger {
  /** The workflow the latest request with this key in `scope` was sent as, else `null`. */
  find(scope: ModelCallScope, key: string): Promise<string | null>;
  save(scope: ModelCallScope, key: string, workflowId: string): Promise<void>;
}

/**
 * The response header orchestration names a chat completion's workflow in, set once the workflow is
 * made, before its answer streams (civitai-orchestration `ChatCompletionsController.WorkflowIdHeader`).
 */
export const WORKFLOW_ID_HEADER = 'X-Civitai-Workflow-Id';

/** How long one status read asks orchestration to hold its answer until the workflow ends. */
const POLL_SECONDS = 20;
/** The least time between two status reads of a workflow still running. */
const POLL_INTERVAL_MS = 1000;
/**
 * How many status reads in a row may fail (a 5xx while orchestration restarts, a read that timed
 * out) before the workflow counts as unreadable and is cancelled: a passing error must not cancel a
 * live, already-paid workflow and pay for it again.
 */
const UNREADABLE_AFTER = 4;
/**
 * The longest a pass's end waits for its cancels: well inside `RUN_STOP_GRACE_MS` (5 s by default),
 * so a Stop that cancels a model call still ends the run itself rather than being forced. A cancel
 * not done by then goes on by itself (its mint, if any, has started).
 */
const SETTLE_MS = 2000;

const COMPLETIONS_PATH = /\/v1\/chat\/completions$/;
const TABLE = `"${RUNNER_SCHEMA}".model_calls`;

/**
 * What a chat completion request asks, as a key: the model and every message but the system prompt
 * (which names today's date), each by role, content, tool calls and the call it answers. A request
 * asked again from the same saved steps gets the same key; any other request, another. `undefined`
 * for a body that is not a chat completion request.
 *
 * Tool images are left out: `AgentCore` (components-chat 0.28+) shows a tool's image once, in a user
 * message after that step's tool results, and saves only a note in its place. The same step asked
 * again after a crash is rebuilt from the saved steps without it, so with the image in the key it
 * would miss the workflow it was first sent as and be paid for twice.
 */
export function callKey(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  const asked = body.messages
    .filter((message) => isRecord(message) && message.role !== 'system' && !isToolImages(message))
    .map((message: Record<string, unknown>) => [
      message.role,
      message.content ?? null,
      Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call: unknown) => {
            const fn = isRecord(call) && isRecord(call.function) ? call.function : {};
            return [isRecord(call) ? call.id ?? null : null, fn.name ?? null, fn.arguments ?? null];
          })
        : [],
      message.tool_call_id ?? null,
    ]);
  if (asked.length === 0) return undefined;
  return createHash('sha256')
    .update(JSON.stringify([body.model ?? null, asked]))
    .digest('hex');
}

/**
 * The message `AgentCore` adds to show a step's tool images (`ToolImages.withImages`): a user message
 * of `Returned by <tool> (<call id>):` lines, each followed by that call's images, as the
 * OpenAI-compatible provider sends it. A viewer's own message has this shape only when its every
 * text part starts with `Returned by ` and it carries an image.
 */
function isToolImages(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (message.role !== 'user' || !Array.isArray(content) || content.length === 0) return false;
  return (
    content.some((part) => isRecord(part) && part.type === 'image_url') &&
    content.every(
      (part) =>
        isRecord(part) &&
        (part.type === 'image_url' ||
          (part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.startsWith('Returned by ')))
    )
  );
}

/** One answer of a chat completion, as the step that reuses it rebuilds it. */
export interface Completion {
  id: string;
  created: number;
  model: string;
  content: string | null;
  reasoning?: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
  usage?: { prompt: number; completion: number; total: number; reasoning?: number };
}

/**
 * The answer a succeeded workflow holds, from its `chatCompletion` step's output (orchestration's
 * `ChatCompletionOutput`, assembled from the streamed chunks when the request streamed). `undefined`
 * when there is nothing a step can be rebuilt from: no output, not exactly one choice, a tool call
 * without an id or a name, or neither words nor calls.
 */
export function completionOf(workflow: WorkflowState): Completion | undefined {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const step = steps.find((candidate) => candidate?.$type === 'chatCompletion');
  const output = step?.output;
  if (!isRecord(output) || !Array.isArray(output.choices) || output.choices.length !== 1)
    return undefined;
  const choice: unknown = output.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  const message = choice.message;
  if (message.content != null && typeof message.content !== 'string') return undefined;
  const content = typeof message.content === 'string' ? message.content : null;
  const reasoning = [message.reasoning_content, message.reasoning].find(
    (text): text is string => typeof text === 'string' && text.length > 0
  );
  const toolCalls: Completion['toolCalls'] = [];
  if (message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls)) return undefined;
    for (const call of message.tool_calls) {
      const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
      if (
        !isRecord(call) ||
        !fn ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof fn.name !== 'string' ||
        !fn.name ||
        typeof fn.arguments !== 'string'
      )
        return undefined;
      toolCalls.push({ id: call.id, name: fn.name, arguments: fn.arguments });
    }
  }
  if (!content && toolCalls.length === 0) return undefined;
  const finish = choice.finishReason ?? choice.finish_reason;
  const usage = isRecord(output.usage) ? output.usage : undefined;
  const count = (camel: string, snake: string) => {
    const value = usage?.[camel] ?? usage?.[snake];
    return typeof value === 'number' ? value : undefined;
  };
  const details = usage
    ? usage.completionTokensDetails ?? usage.completion_tokens_details
    : undefined;
  const reasoningTokens = isRecord(details)
    ? details.reasoningTokens ?? details.reasoning_tokens
    : undefined;
  const prompt = count('promptTokens', 'prompt_tokens');
  const completion = count('completionTokens', 'completion_tokens');
  return {
    id: typeof output.id === 'string' ? output.id : String(workflow.id ?? ''),
    created: typeof output.created === 'number' ? output.created : 0,
    model: typeof output.model === 'string' ? output.model : '',
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    finishReason:
      typeof finish === 'string' && finish ? finish : toolCalls.length ? 'tool_calls' : 'stop',
    ...(prompt !== undefined && completion !== undefined
      ? {
          usage: {
            prompt,
            completion,
            total: count('totalTokens', 'total_tokens') ?? prompt + completion,
            ...(typeof reasoningTokens === 'number' ? { reasoning: reasoningTokens } : {}),
          },
        }
      : {}),
  };
}

/**
 * The answer orchestration's `/v1/chat/completions` would have sent for `completion`: an SSE stream
 * of one chunk with the whole message and one with the finish reason and usage (as orchestration
 * itself replays a stored output), or one JSON body when the request did not stream.
 */
export function completionResponse(
  completion: Completion,
  stream: boolean,
  workflowId: string
): Response {
  const { id, created, model } = completion;
  const toolCalls = completion.toolCalls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
  const usage = completion.usage
    ? {
        prompt_tokens: completion.usage.prompt,
        completion_tokens: completion.usage.completion,
        total_tokens: completion.usage.total,
        ...(completion.usage.reasoning !== undefined
          ? { completion_tokens_details: { reasoning_tokens: completion.usage.reasoning } }
          : {}),
      }
    : undefined;
  const message = {
    role: 'assistant',
    content: completion.content,
    ...(completion.reasoning ? { reasoning_content: completion.reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  const headers = { [WORKFLOW_ID_HEADER]: workflowId };
  if (!stream) {
    return Response.json(
      {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: completion.finishReason }],
        ...(usage ? { usage } : {}),
      },
      { headers }
    );
  }
  const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, ...choice }],
      ...extra,
    })}\n\n`;
  const body =
    chunk({ delta: message, finish_reason: null }) +
    chunk({ delta: {}, finish_reason: completion.finishReason }, usage ? { usage } : {}) +
    'data: [DONE]\n\n';
  return new Response(body, {
    headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

export interface ModelCallsOptions {
  ledger: ModelCallLedger;
  orchestration: OrchestrationClient;
  log?: Logger;
  /** The least time between two status reads of a workflow still running; 1 s unless set. */
  pollIntervalMs?: number;
}

/** What one run's requests did in this process. */
interface RunCalls {
  /**
   * Workflows a request of this run was sent as or answered from here, or cancelled: never answer
   * another request here (two subagents asking the same, or a request whose answer was rejected).
   * One whose answer broke off on its own (not aborted) is taken out, so a request asked again here
   * waits for it. (`AgentCore` retries only a browser's dropped connection, so in this process
   * that is rare.)
   */
  used: Set<string>;
  /** Each workflow cancelled here, once, and the cancel's own promise, which `settle` waits for. */
  cancels: Map<string, Promise<void>>;
}

/**
 * Makes a model request survive the process that sent it. Each chat completion request's
 * orchestration workflow is kept in the ledger as soon as orchestration names it, before its answer
 * is read. A request asked again later (the reply's step recovered after a crash, or a Continue)
 * with the same key first reads that workflow: succeeded, its answer is the request's, with no new
 * request (and no new charge); still running, it is waited for, as long as the request's own signal
 * lets it (the run's wall clock or a Stop ends the wait, and cancels it); ended without an answer
 * it can use, it is asked again (cancelling it first when its state cannot be read). A request cut off by its own
 * signal (Stop, the wall clock, a hard cancel) cancels its workflow, so the model stops billing.
 */
export class ModelCalls {
  readonly #ledger: ModelCallLedger;
  readonly #orchestration: OrchestrationClient;
  readonly #log: Logger | undefined;
  readonly #pollIntervalMs: number;
  readonly #runs = new Map<string, RunCalls>();

  constructor(options: ModelCallsOptions) {
    this.#ledger = options.ledger;
    this.#orchestration = options.orchestration;
    this.#log = options.log;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  /** `inner`, for one run's model: chat completion requests go through the ledger, anything else as is. */
  fetch(inner: typeof fetch, scope: ModelCallScope, tokens: TokenSource): typeof fetch {
    return async (input, init) => {
      const body = completionBody(input, init);
      const key = body === undefined ? undefined : callKey(body);
      if (!body || !key) return inner(input, init);
      const signal = init?.signal ?? undefined;
      const run = this.#run(scope.runId);
      const call: Call = { scope, key, tokens, run };

      const found = await this.#ledger.find(scope, key).catch((error) => {
        this.#log?.warn(
          { err: error, runId: scope.runId },
          'reading a model call from the ledger failed'
        );
        return null;
      });
      if (found && !run.used.has(found)) {
        run.used.add(found);
        const answer = await this.#answerFrom(call, found, body.stream === true, signal);
        if (answer) return answer;
      }

      const response = await inner(input, init);
      const workflowId = response.headers.get(WORKFLOW_ID_HEADER);
      if (!workflowId) return response;
      run.used.add(workflowId);
      // Kept before the answer is read: a process that dies from here on leaves it for the next.
      await this.#ledger
        .save(scope, key, workflowId)
        .catch((error) =>
          this.#log?.warn(
            { err: error, runId: scope.runId, workflowId },
            'keeping a model call in the ledger failed'
          )
        );
      return this.#watched(call, workflowId, response, signal);
    };
  }

  /** Waits (at most `SETTLE_MS`) for the run's cancels to land, and forgets the run. */
  async settle(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#runs.delete(runId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...run.cancels.values()]),
      new Promise((resolve) => (timer = setTimeout(resolve, SETTLE_MS))),
    ]);
    clearTimeout(timer);
  }

  #run(runId: string): RunCalls {
    let run = this.#runs.get(runId);
    if (!run) this.#runs.set(runId, (run = { used: new Set(), cancels: new Map() }));
    return run;
  }

  /**
   * The answer the workflow a request was first sent as holds, waiting while it runs; `undefined`
   * when the request has to be sent again (after cancelling the workflow, if it may still run).
   */
  async #answerFrom(
    call: Call,
    workflowId: string,
    stream: boolean,
    signal: AbortSignal | undefined
  ): Promise<Response | undefined> {
    const { runId } = call.scope;
    const askAgain = (reason: string, extra: object = {}) => {
      this.#log?.info(
        { modelCall: 'asked-again', reason, runId, workflowId, ...extra },
        'model request sent again: its earlier orchestration workflow has no answer to reuse'
      );
      return undefined;
    };
    let waiting = false;
    let failedReads = 0;
    for (;;) {
      const asked = Date.now();
      let workflow: WorkflowState;
      try {
        workflow = await this.#orchestration.getWorkflow(call.tokens, workflowId, {
          ...(waiting ? { waitSeconds: POLL_SECONDS } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) {
          void this.#cancel(call, workflowId, 'stopped while waiting');
          throw abortReason(signal);
        }
        if (error instanceof OrchestrationError && error.status === 404)
          return askAgain('not-found');
        if (++failedReads < UNREADABLE_AFTER) {
          this.#log?.warn(
            { err: error, runId, workflowId, failedReads },
            'reading the orchestration workflow of a model request failed; reading it again'
          );
          await pause(this.#pollIntervalMs, signal).catch((stopped: unknown) => {
            void this.#cancel(call, workflowId, 'stopped while waiting');
            throw stopped;
          });
          continue;
        }
        // Its state could not be read, so it may still run: cancelled before the request goes again.
        await this.#cancel(call, workflowId, 'unreadable');
        return askAgain('unreadable', { err: error });
      }
      failedReads = 0;
      const status = String(workflow.status ?? '');
      if (status === 'succeeded') {
        const completion = completionOf(workflow);
        if (!completion) return askAgain('unusable-output');
        this.#log?.info(
          { modelCall: 'reused', runId, workflowId, waited: waiting },
          'model request answered by the orchestration workflow it was first sent as'
        );
        return completionResponse(completion, stream, workflowId);
      }
      if (FINAL_STATUSES.includes(status)) return askAgain(status);
      if (!waiting)
        this.#log?.info(
          { modelCall: 'waiting', runId, workflowId, status },
          'model request waiting for the orchestration workflow it was first sent as'
        );
      waiting = true;
      const wait = this.#pollIntervalMs - (Date.now() - asked);
      if (wait > 0)
        await pause(wait, signal).catch((error: unknown) => {
          // Stopped while waiting: the workflow is not wanted any more.
          void this.#cancel(call, workflowId, 'stopped while waiting');
          throw error;
        });
    }
  }

  /**
   * The response, its body passed through as read: the request's signal aborting, or its reader
   * cancelling the body, before the body ends cancels the workflow; the body breaking off by itself
   * leaves the workflow for a request asked again to wait for.
   */
  #watched(
    call: Call,
    workflowId: string,
    response: Response,
    signal: AbortSignal | undefined
  ): Response {
    const cutOff = () => void this.#cancel(call, workflowId, 'stopped');
    if (!response.body || !response.ok) return response;
    if (signal?.aborted) {
      cutOff();
      return response;
    }
    signal?.addEventListener('abort', cutOff, { once: true });
    const finished = (broke: boolean) => {
      signal?.removeEventListener('abort', cutOff);
      if (broke && !signal?.aborted) call.run.used.delete(workflowId);
    };
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finished(false);
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          finished(true);
          controller.error(error);
        }
      },
      cancel(reason) {
        signal?.removeEventListener('abort', cutOff);
        cutOff();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Cancels a workflow, once per run here; a failure is logged. Its ledger row stays: read again
   * later it answers `canceled` (the request is sent again), or, when the cancel did not land, it is
   * read as it stands.
   */
  #cancel(call: Call, workflowId: string, why: string): Promise<void> {
    const { scope, tokens, run } = call;
    run.used.add(workflowId);
    const cancelling = run.cancels.get(workflowId);
    if (cancelling) return cancelling;
    const task = (async () => {
      try {
        await this.#orchestration.cancelWorkflow(tokens, workflowId);
        this.#log?.info(
          { modelCall: 'cancelled', why, runId: scope.runId, workflowId },
          'cancelled the orchestration workflow of a model request'
        );
      } catch (error) {
        this.#log?.warn(
          { err: error, why, runId: scope.runId, workflowId },
          'cancelling the orchestration workflow of a model request failed'
        );
      }
    })();
    run.cancels.set(workflowId, task);
    return task;
  }
}

interface Call {
  scope: ModelCallScope;
  key: string;
  tokens: TokenSource;
  run: RunCalls;
}

/**
 * The ledger in the runner's database (`assistant_runner.model_calls`): one row per run and request
 * key, holding the orchestration workflow id the request was last sent as. Ids only, no credential.
 * Rows outlive their run only until `sweep` (the runs' retention).
 */
export class PgModelCalls implements ModelCallLedger {
  readonly #pool: pg.Pool;
  #ready: Promise<void> | undefined;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  /** Creates the table. Safe to call on every replica at every start. */
  init(): Promise<void> {
    this.#ready ??= this.#pool
      .query(
        `create schema if not exists "${RUNNER_SCHEMA}";
         create table if not exists ${TABLE} (
           run_id text not null,
           call_key text not null,
           user_id text not null,
           conversation_id text not null,
           seq integer not null,
           workflow_id text not null,
           created_at timestamptz not null default now(),
           primary key (run_id, call_key)
         );
         create index if not exists model_calls_turn on ${TABLE} (user_id, conversation_id, seq, call_key);
         create index if not exists model_calls_created on ${TABLE} (created_at);`
      )
      .then(() => undefined);
    return this.#ready;
  }

  async find(scope: ModelCallScope, key: string): Promise<string | null> {
    // The run's own row first; with `carriesOn`, else the latest an earlier run of the turn left.
    const { rows } = await this.#pool.query<{ workflow_id: string }>(
      `select workflow_id from ${TABLE}
       where call_key = $2
         and (run_id = $1 or ($6 and user_id = $3 and conversation_id = $4 and seq = $5))
       order by (run_id = $1) desc, created_at desc
       limit 1`,
      [scope.runId, key, scope.userId, scope.conversationId, scope.seq, scope.carriesOn === true]
    );
    return rows[0]?.workflow_id ?? null;
  }

  async save(scope: ModelCallScope, key: string, workflowId: string): Promise<void> {
    await this.#pool.query(
      `insert into ${TABLE} (run_id, call_key, user_id, conversation_id, seq, workflow_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (run_id, call_key) do update set workflow_id = excluded.workflow_id, created_at = now()`,
      [scope.runId, key, scope.userId, scope.conversationId, scope.seq, workflowId]
    );
  }

  /** Deletes rows older than `olderThanMs`. Returns how many. */
  async sweep(olderThanMs: number): Promise<number> {
    const { rowCount } = await this.#pool.query(
      `delete from ${TABLE} where created_at < now() - make_interval(secs => $1::double precision / 1000)`,
      [olderThanMs]
    );
    return rowCount ?? 0;
  }
}

/** The JSON body of a chat completion POST, else `undefined`. */
function completionBody(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): Record<string, unknown> | undefined {
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || typeof init?.body !== 'string')
    return undefined;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (!COMPLETIONS_PATH.test(path)) return undefined;
  try {
    const body: unknown = JSON.parse(init.body);
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Waits `ms`, or until `signal` aborts (then throws its reason). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, Math.max(0, ms));
    const aborted = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
