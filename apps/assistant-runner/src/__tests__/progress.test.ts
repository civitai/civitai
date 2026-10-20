import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import { jsonSchema, tool, type ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { startTurn } from '../head';
import type { ConversationStore } from '../interfaces';
import { MemoryConversationStore } from '../memory-store';
import { ProgressWriter, runAfterSaved } from '../progress';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const callStarted = (toolCallId: string): ModelMessage[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'run', input: {} }] },
];

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

/** A store whose writes wait until `release()`, or fail when `fail` is set. */
function gated(inner: ConversationStore) {
  let release: () => void = () => {};
  let gate = new Promise<void>((resolve) => (release = resolve));
  const state = { fail: false, writes: 0 };
  const store: ConversationStore = {
    load: (userId, conversationId) => inner.load(userId, conversationId),
    update: async (userId, conversationId, change) => {
      await gate;
      if (state.fail) throw new Error('store down');
      state.writes++;
      return inner.update(userId, conversationId, change);
    },
  };
  return {
    store,
    state,
    release: () => {
      release();
      gate = Promise.resolve();
    },
  };
}

function guardedTool(writer: ProgressWriter, body: () => Promise<string>) {
  const tools = runAfterSaved(
    {
      run: tool({
        description: 'run',
        inputSchema: jsonSchema<Record<string, unknown>>({ type: 'object' }),
        execute: body,
      }),
    },
    (toolCallId) => writer.callSaved(toolCallId, 200)
  );
  return (toolCallId: string) =>
    tools.run!.execute!({}, { toolCallId, messages: [] } as never) as Promise<string>;
}

describe('a tool call runs only once its start is saved', () => {
  it('waits for the save that names the call before running it', async () => {
    const { store, release } = gated(await seeded());
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    const body = vi.fn(async () => 'ran');
    const run = guardedTool(writer, body);

    writer.save(callStarted('call-1'));
    const result = run('call-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(body).not.toHaveBeenCalled();

    release();
    await expect(result).resolves.toBe('ran');
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('fails the call without running it when its start cannot be saved', async () => {
    const { store, state, release } = gated(await seeded());
    state.fail = true;
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    const body = vi.fn(async () => 'ran');
    const run = guardedTool(writer, body);

    writer.save(callStarted('call-2'));
    release();
    await expect(run('call-2')).rejects.toThrow('was not run');
    expect(body).not.toHaveBeenCalled();
  });

  it('saves the end after any progress still on its way, so a late save cannot reopen the reply', async () => {
    const memory = await seeded();
    const { store, release } = gated(memory);
    const writer = new ProgressWriter(store, 'u1', 'c1', 1, log);
    writer.save(callStarted('call-3'));
    const ended = writer.end({ messages: [], status: 'done' });
    release();
    await ended;
    const head = (await memory.load('u1', 'c1')) as StoredConversationMetadata;
    expect(head.v).toBe(2);
    expect(head.turns[0]!.assistant).toMatchObject({ status: 'done' });
  });
});
