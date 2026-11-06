import { PROVIDER_OPTIONS } from '@civitai/components-chat/core';
import { jsonSchema, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';

import type { Logger, ModelContext, ModelProvider } from '../core/interfaces';
import type { TokenSource } from '../minter';
import { OrchestrationClient } from '../orchestration';
import { OrchestrationModels } from '../orchestration-model';
import { carriesOnSteps } from '../core/runner';
import { callKey } from '../model-calls';
import { FakeChatOrchestration } from '../test-support/fake-chat-orchestration';
import { MemoryModelCalls } from '../test-support/memory-model-calls';

const BASE = 'https://orchestration.example';
// Workflow ids: distinct from each other and from anything the runner's code names.
const FIRST = 'wf-0e41c7-first';
const SECOND = 'wf-7b93d2-second';
const OTHER = 'wf-c51a08-other';

interface Logged {
  level: 'info' | 'warn' | 'error';
  object: Record<string, unknown>;
  message?: string;
}

function logger() {
  const lines: Logged[] = [];
  const log: Logger = {
    info: (object, message) => lines.push({ level: 'info', object: { ...object }, message }),
    warn: (object, message) => lines.push({ level: 'warn', object: { ...object }, message }),
    error: (object, message) => lines.push({ level: 'error', object: { ...object }, message }),
  };
  return { log, lines, calls: () => lines.map((line) => line.object.modelCall).filter(Boolean) };
}

const tokens: TokenSource = async (purpose) => `${purpose}-token`;

/**
 * One runner process's model provider. A test that makes a second one with the same ledger and
 * orchestration plays a process that came back after the first one died.
 */
function runnerProcess(
  orchestration: FakeChatOrchestration,
  ledger: MemoryModelCalls,
  options: { log?: Logger } = {}
) {
  return new OrchestrationModels({
    baseUrl: BASE,
    orchestration: new OrchestrationClient(BASE, orchestration.fetch),
    tokens: () => tokens,
    fetch: orchestration.fetch,
    calls: ledger,
    pollIntervalMs: 5,
    ...options,
  } as ConstructorParameters<typeof OrchestrationModels>[0]);
}

const context = (overrides: Partial<ModelContext> = {}): ModelContext =>
  ({
    userId: 'u-7',
    runId: 'run-a',
    conversationId: 'c-3',
    model: 'openai/gpt-6-luna',
    tier: 'paid',
    seq: 2,
    ...overrides,
  } as ModelContext);

function ask(
  provider: ModelProvider,
  options: { context?: Partial<ModelContext>; prompt?: string; signal?: AbortSignal } = {}
) {
  const result = streamText({
    model: provider.languageModel(context(options.context)),
    prompt: options.prompt ?? 'Build the app.',
    tools: {
      record: tool({
        description: 'record',
        inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
      }),
    },
    maxRetries: 0,
    providerOptions: PROVIDER_OPTIONS,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
  // Read to its end (or its failure) whether or not the test looks.
  const text = Promise.resolve(result.text).catch((error: unknown) => error);
  return { result, text };
}

async function until(what: string, probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A first process sends the request and dies while its answer streams: nothing is read, nothing aborted. */
async function crashMidStream(
  orchestration: FakeChatOrchestration,
  ledger: MemoryModelCalls,
  id: string,
  answer: Parameters<FakeChatOrchestration['next']>[1],
  overrides: Partial<ModelContext> = {}
) {
  orchestration.next(id, answer, { hold: true });
  ask(runnerProcess(orchestration, ledger), { context: overrides });
  await until('the first request to be sent', () => orchestration.posts.length === 1);
  await until('its answer to be read', () => orchestration.order.includes(`read ${id}`));
}

describe('model calls kept across a crash', () => {
  it('keeps the workflow id orchestration names before the answer is read', async () => {
    const order: string[] = [];
    const orchestration = new FakeChatOrchestration(order);
    const ledger = new MemoryModelCalls(order);
    orchestration.next(FIRST, { text: 'Kept first.' }, { hold: true });
    const { text } = ask(runnerProcess(orchestration, ledger));

    await until('the answer to be read', () => order.includes(`read ${FIRST}`));
    // Saved before the stream was read from at all: a crash mid-stream leaves the id behind.
    expect(order).toContain(`saved ${FIRST}`);
    expect(order.indexOf(`saved ${FIRST}`)).toBeLessThan(order.indexOf(`read ${FIRST}`));
    expect(ledger.rows).toEqual([
      {
        runId: 'run-a',
        userId: 'u-7',
        conversationId: 'c-3',
        seq: 2,
        key: expect.stringMatching(/^[0-9a-f]{64}$/),
        workflowId: FIRST,
      },
    ]);
    // Ids only: no token went into the ledger.
    expect(JSON.stringify(ledger.rows)).not.toContain('token');

    orchestration.release(FIRST);
    expect(await text).toBe('Kept first.');
  });

  it('answers a request asked again after a crash from its finished workflow, with no new request', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, {
      text: 'Recording that. ',
      toolCalls: [{ id: 'call-5f2e', name: 'record', arguments: '{"note":"kept"}' }],
    });
    // Orchestration finished it after the process died.
    orchestration.succeed(FIRST);

    const { log, calls } = logger();
    const recovered = ask(runnerProcess(orchestration, ledger, { log }));
    expect(await recovered.text).toBe('Recording that. ');
    expect(await recovered.result.toolCalls).toMatchObject([
      { toolCallId: 'call-5f2e', toolName: 'record', input: { note: 'kept' } },
    ]);
    expect(await recovered.result.finishReason).toBe('tool-calls');
    expect(await recovered.result.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
    // The one request the first process sent: none from the second.
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST]);
    expect(orchestration.gets).toEqual([FIRST]);
    expect(orchestration.puts).toEqual([]);
    expect(calls()).toEqual(['reused']);
  });

  it('waits for a workflow still running and takes its answer, with no new request', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, { text: 'Worth the wait.' });
    orchestration.script(FIRST, ['processing', 'scheduled', 'processing', 'succeeded']);

    const { log, calls, lines } = logger();
    const recovered = ask(runnerProcess(orchestration, ledger, { log }));
    expect(await recovered.text).toBe('Worth the wait.');
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST]);
    expect(orchestration.gets).toEqual([FIRST, FIRST, FIRST, FIRST]);
    expect(orchestration.puts).toEqual([]);
    expect(calls()).toEqual(['waiting', 'reused']);
    expect(lines.at(-1)!.object).toMatchObject({ workflowId: FIRST, waited: true });
  });

  it('sends a request again when its workflow ended without an answer, cancelling nothing', async () => {
    for (const status of ['failed', 'expired', 'canceled']) {
      const orchestration = new FakeChatOrchestration();
      const ledger = new MemoryModelCalls();
      await crashMidStream(orchestration, ledger, FIRST, { text: 'Never seen.' });
      orchestration.script(FIRST, [status]);

      const { log, lines } = logger();
      orchestration.next(SECOND, { text: 'Asked again.' });
      const recovered = ask(runnerProcess(orchestration, ledger, { log }));
      expect(await recovered.text, status).toBe('Asked again.');
      expect(
        orchestration.posts.map((post) => post.id),
        status
      ).toEqual([FIRST, SECOND]);
      expect(orchestration.puts, status).toEqual([]);
      expect(lines.find((line) => line.object.modelCall)?.object, status).toMatchObject({
        modelCall: 'asked-again',
        reason: status,
        workflowId: FIRST,
      });
      // The request is kept as the workflow it was sent as now.
      expect(
        ledger.rows.map((row) => row.workflowId),
        status
      ).toEqual([SECOND]);
    }
  });

  it('cancels a workflow whose state cannot be read, then sends the request again', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, { text: 'Unreadable.' });
    orchestration.failReads(FIRST);

    const { log, calls } = logger();
    orchestration.next(SECOND, { text: 'Asked again.' });
    const recovered = ask(runnerProcess(orchestration, ledger, { log }));
    expect(await recovered.text).toBe('Asked again.');
    expect(orchestration.puts).toEqual([{ id: FIRST, body: { status: 'canceled' } }]);
    // Cancelled before the request went again.
    const { order } = orchestration;
    expect(order.indexOf(`put ${FIRST}`)).toBeGreaterThan(-1);
    expect(order.indexOf(`put ${FIRST}`)).toBeLessThan(order.indexOf(`post ${SECOND}`));
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST, SECOND]);
    expect(calls()).toEqual(['cancelled', 'asked-again']);
  });

  it('reads a workflow again through a few failed reads, and neither cancels nor pays again', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, { text: 'Read on the fourth try.' });
    orchestration.succeed(FIRST);
    // Orchestration restarting: three reads in a row answer 500, then it answers again.
    orchestration.failReads(FIRST, 3);

    const { log, calls } = logger();
    const recovered = ask(runnerProcess(orchestration, ledger, { log }));
    expect(await recovered.text).toBe('Read on the fourth try.');
    expect(orchestration.gets).toEqual([FIRST, FIRST, FIRST, FIRST]);
    expect(orchestration.puts).toEqual([]);
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST]);
    expect(calls()).toEqual(['reused']);
  });

  it('waits for a workflow still running until the run stops, then cancels it', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, { text: 'Never needed.' });
    orchestration.script(FIRST, ['processing']);

    const { log, calls } = logger();
    const models = runnerProcess(orchestration, ledger, { log });
    const stop = new AbortController();
    const { text } = ask(models, { signal: stop.signal });
    // No wait of its own runs out: it reads again and again until the run's signal ends it.
    await until('several status reads', () => orchestration.gets.length >= 3);
    stop.abort();
    await text;
    await (models as ModelProvider).settle?.('run-a');
    expect(orchestration.puts).toEqual([{ id: FIRST, body: { status: 'canceled' } }]);
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST]);
    expect(calls()).toEqual(['waiting', 'cancelled']);
  });

  it('sends a request again when its finished workflow holds nothing a step can be rebuilt from', async () => {
    const unusable = [
      { choices: [] },
      {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: '', type: 'function', function: { name: 'record', arguments: '{}' } },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      },
    ];
    for (const output of unusable) {
      const orchestration = new FakeChatOrchestration();
      const ledger = new MemoryModelCalls();
      await crashMidStream(orchestration, ledger, FIRST, { text: 'Never seen.' });
      orchestration.setOutput(FIRST, output);

      const { log, lines } = logger();
      orchestration.next(SECOND, { text: 'Asked again.' });
      const recovered = ask(runnerProcess(orchestration, ledger, { log }));
      expect(await recovered.text).toBe('Asked again.');
      expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST, SECOND]);
      expect(orchestration.puts).toEqual([]);
      expect(lines.find((line) => line.object.modelCall)?.object).toMatchObject({
        modelCall: 'asked-again',
        reason: 'unusable-output',
      });
    }
  });

  it('never answers a request with the workflow another request of the run was sent as', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    orchestration.next(FIRST, { text: 'About foxes.' });
    expect(await ask(runnerProcess(orchestration, ledger), { prompt: 'Foxes?' }).text).toBe(
      'About foxes.'
    );

    orchestration.next(OTHER, { text: 'About owls.' });
    expect(await ask(runnerProcess(orchestration, ledger), { prompt: 'Owls?' }).text).toBe(
      'About owls.'
    );
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST, OTHER]);
    expect(orchestration.gets).toEqual([]);
  });

  it('a retry carrying on from an earlier run’s steps takes that run’s answer; any other run asks', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    await crashMidStream(orchestration, ledger, FIRST, { text: 'From the first run.' });
    orchestration.succeed(FIRST);

    const carried = ask(runnerProcess(orchestration, ledger), {
      context: { runId: 'run-b', carriesOn: true },
    });
    expect(await carried.text).toBe('From the first run.');
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST]);

    // A new reply to the turn (no saved steps carried on) asks the model again.
    orchestration.next(SECOND, { text: 'A new answer.' });
    const fresh = ask(runnerProcess(orchestration, ledger), { context: { runId: 'run-c' } });
    expect(await fresh.text).toBe('A new answer.');
    expect(orchestration.posts.map((post) => post.id)).toEqual([FIRST, SECOND]);
  });
});

describe('model calls cut off by the run', () => {
  it('Stop cancels the workflow of the request in flight', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    const { log, calls } = logger();
    const models = runnerProcess(orchestration, ledger, { log });
    orchestration.next(FIRST, { text: 'Never finished.' }, { hold: true });
    const stop = new AbortController();
    const { text } = ask(models, { signal: stop.signal });
    await until('the answer to be read', () => orchestration.order.includes(`read ${FIRST}`));

    stop.abort();
    await text;
    await (models as ModelProvider).settle?.('run-a');
    await until('the workflow to be cancelled', () => orchestration.puts.length > 0);
    expect(orchestration.puts).toEqual([{ id: FIRST, body: { status: 'canceled' } }]);
    expect(orchestration.workflows.get(FIRST)!.status).toBe('canceled');
    // Kept: read again later it answers `canceled`, and the request is sent again.
    expect(ledger.rows.map((row) => row.workflowId)).toEqual([FIRST]);
    expect(calls()).toEqual(['cancelled']);
  });

  it('a request that finished is not cancelled when the run stops later', async () => {
    const orchestration = new FakeChatOrchestration();
    const ledger = new MemoryModelCalls();
    const models = runnerProcess(orchestration, ledger);
    orchestration.next(FIRST, { text: 'Done in time.' });
    const stop = new AbortController();
    expect(await ask(models, { signal: stop.signal }).text).toBe('Done in time.');
    stop.abort();
    await (models as ModelProvider).settle?.('run-a');
    expect(orchestration.puts).toEqual([]);
    expect(ledger.rows.map((row) => row.workflowId)).toEqual([FIRST]);
  });
});

describe('which retries may take an earlier run’s answer', () => {
  const step = { role: 'assistant', content: 'Recording.' } as const;
  it('only a retry carrying on from at least one saved step', () => {
    expect(carriesOnSteps(true, { messages: [step], steps: 1 } as never)).toBe(true);
    // A retry carrying no saved step asks what a fresh reply asks: a regenerate, or a retry of a
    // reply that failed before its first step. It must never get an earlier run's reply.
    expect(carriesOnSteps(true, { messages: [], steps: 0 } as never)).toBe(false);
    expect(carriesOnSteps(true, undefined)).toBe(false);
    expect(carriesOnSteps(false, { messages: [step], steps: 1 } as never)).toBe(false);
  });
});

describe('callKey and tool images', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const steps = [
    { role: 'system', content: 'Today is 2026-10-27.' },
    { role: 'user', content: 'What colour is the logo badge?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-9f2',
          type: 'function',
          function: { name: 'sandbox__preview_check', arguments: '{"screenshot":true}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-9f2', content: 'render: ok\n[image/png image: sent]' },
  ];
  const body = (...extra: object[]) => ({ model: 'm-1', messages: [...steps, ...extra] });

  it('keys a step shown its tool images like the same step rebuilt from saved steps without them', () => {
    const shown = {
      role: 'user',
      content: [
        { type: 'text', text: 'Returned by sandbox__preview_check (call-9f2):' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    };
    expect(callKey(body())).toBeDefined();
    expect(callKey(body(shown))).toBe(callKey(body()));
  });

  it('keeps a viewer message with an image in the key', () => {
    const attached = {
      role: 'user',
      content: [
        { type: 'text', text: 'Make it look like this' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    };
    expect(callKey(body(attached))).not.toBe(callKey(body()));
  });

  it('keeps a user message of only "Returned by" text in the key (no image, not a tool-image message)', () => {
    const words = {
      role: 'user',
      content: [{ type: 'text', text: 'Returned by sandbox__preview_check (call-9f2):' }],
    };
    expect(callKey(body(words))).not.toBe(callKey(body()));
  });
});
