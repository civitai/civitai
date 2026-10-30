import { PROVIDER_OPTIONS } from '@civitai/components-chat/core';
import { streamText, type ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { savedTurn, startTurn, withEnd } from '../core/head';
import { MemoryConversationStore } from '../core/memory-store';
import { ProgressWriter } from '../core/progress';
import { OrchestrationClient } from '../orchestration';
import { OrchestrationModels } from '../orchestration-model';

/**
 * The chat's "About N Buzz spent" sums each saved reply's `assistant.buzz`, and falls back to one
 * Buzz per step for a reply without it. A reply the runner ran must carry what orchestration
 * charged for it, or the readout counts every step at 1 Buzz whatever it cost.
 */

const BASE = 'https://orchestration.example';
const MODEL = 'openai/gpt-6-luna';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A streamed chat completion whose closing usage chunk says it cost `cost` Buzz. */
function streamedReply(cost: number): Response {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      ...body,
    })}\n\n`;
  const text =
    chunk({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi.' }, finish_reason: null }],
    }) +
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost },
    }) +
    'data: [DONE]\n\n';
  // Cut mid-line, as a network delivers it.
  const bytes = new TextEncoder().encode(text);
  const cut = text.indexOf('"cost"') + 3;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function orchestration(cost: number): typeof fetch {
  return async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/consumer/free-tier') return Response.json({ enabled: false, models: [] });
    if (path === '/v1/chat/completions') return streamedReply(cost);
    return new Response('', { status: 404 });
  };
}

describe('the runner reads what each model call was charged', () => {
  it('reports the usage chunk’s cost of a streamed reply', async () => {
    const doFetch = orchestration(37);
    const charges: number[] = [];
    const model = new OrchestrationModels({
      baseUrl: BASE,
      orchestration: new OrchestrationClient(BASE, doFetch),
      tokens: () => async (purpose) => `test-token-${purpose}`,
      fetch: doFetch,
    }).languageModel({
      userId: 'u1',
      runId: 'r1',
      conversationId: 'c1',
      model: MODEL,
      tier: 'paid',
      onCharge: (buzz) => charges.push(buzz),
    });
    const result = streamText({
      model,
      prompt: 'hi',
      maxRetries: 0,
      providerOptions: PROVIDER_OPTIONS,
    });
    expect(await result.text).toBe('Hi.');
    expect(charges).toEqual([37]);
  });
});

async function seeded() {
  const store = new MemoryConversationStore();
  await store.update('u1', 'c1', () =>
    startTurn(null, {
      conversationId: 'c1',
      seq: 1,
      user: { content: 'go', attachments: [] },
      now: new Date(),
    })
  );
  return store;
}

const step = (text: string): ModelMessage[] => [{ role: 'assistant', content: text }];
const buzzOf = async (store: MemoryConversationStore) =>
  (savedTurn(await store.load('u1', 'c1'), 1)?.assistant as { buzz?: unknown } | undefined)?.buzz;

describe('a reply’s charges are saved with it', () => {
  it('sums every call’s charge into the ended reply, across progress saves', async () => {
    const store = await seeded();
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    writer.charged(13);
    writer.save(step('one'));
    await writer.idle();
    expect(await buzzOf(store)).toBe(13);
    writer.charged(21);
    writer.charged(8);
    expect(await writer.end({ messages: step('two'), status: 'done' })).toBe(true);
    expect(await buzzOf(store)).toBe(42);
  });

  it('a free reply is saved as charged 0, not as unknown', async () => {
    const store = await seeded();
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    writer.charged(0);
    await writer.end({ messages: step('done'), status: 'done' });
    expect(await buzzOf(store)).toBe(0);
  });

  it('a reply nothing was charged for has no charge', async () => {
    const store = await seeded();
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    await writer.end({ messages: step('done'), status: 'done' });
    expect(await buzzOf(store)).toBeUndefined();
  });

  it('a reply carried on from its saved steps keeps what they were charged', async () => {
    const store = await seeded();
    const first = new ProgressWriter(store, 'u1', 'c1', 1, log);
    first.charged(30);
    first.save(step('one'));
    await first.idle();
    // The retry carries on from the saved step, as `#begin` starts it.
    await store.update('u1', 'c1', (head) =>
      startTurn(head, {
        conversationId: 'c1',
        seq: 1,
        user: { content: 'go', attachments: [] },
        now: new Date(),
        from: { messages: step('one'), steps: 1, at: Date.now() },
      })
    );
    const retry = new ProgressWriter(store, 'u1', 'c1', 1, log);
    retry.charged(5);
    await retry.end({ messages: step('two'), status: 'done' });
    expect(await buzzOf(store)).toBe(35);
  });

  it('an end written outside the reply’s own writer (a cancel) keeps the charge saved', async () => {
    const store = await seeded();
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    writer.charged(9);
    writer.save(step('one'));
    await writer.idle();
    await store.update('u1', 'c1', (head) =>
      withEnd(head!, 1, { messages: step('one'), status: 'aborted' }, new Date())
    );
    expect(await buzzOf(store)).toBe(9);
  });
});
