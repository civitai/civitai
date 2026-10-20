import { conversationMetadataOf, HEAD_TAG, turnFrom } from '@civitai/components-chat/core';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  acceptsTurn,
  firstMessageTitle,
  resumeOf,
  startTurn,
  withEnd,
  withPatch,
  withProgress,
} from '../head';

const now = new Date('2026-10-20T10:00:00Z');
const later = new Date('2026-10-20T10:01:00Z');
const user = { content: 'Make me an app that tracks my plants', attachments: [] };

const stepOne: ModelMessage[] = [
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'record', input: {} }],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'a',
        toolName: 'record',
        output: { type: 'text', value: 'ok' },
      },
    ],
  },
];
const stepTwoStarted: ModelMessage[] = [
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'b', toolName: 'slow', input: {} }],
  },
];

/** The head as the chat package reads it back from a saved workflow. */
const read = (metadata: unknown) => conversationMetadataOf({ metadata, tags: [HEAD_TAG] } as never);

describe('the head the runner saves, read by the chat package', () => {
  it('is a v2 head the chat lists, with the first message as its title, once a turn starts', () => {
    const head = startTurn(null, { conversationId: 'c1', scope: 'apps', seq: 1, user, now });
    expect(read(head)).toMatchObject({
      v: 2,
      app: 'chat-cvt',
      conversationId: 'c1',
      scope: 'apps',
      title: 'Make me an app that tracks my plants',
      titleSource: 'first-message',
    });
    // Saved before any progress, the reply reads as cut off at the turn's start, as the browser's own save does.
    expect(turnFrom(head.turns[0]!).assistant).toMatchObject({
      status: 'error',
      error: 'cut-off',
      savedAt: now.toISOString(),
    });
  });

  it('saves progress as v3 running, which the chat carries on from without running a started call again', () => {
    const head = withProgress(
      startTurn(null, { conversationId: 'c1', seq: 1, user, now }),
      1,
      [...stepOne, ...stepTwoStarted],
      later
    );
    expect(read(head)?.v).toBe(3);
    const resume = resumeOf(head.turns[0]!);
    expect(resume?.steps).toBe(2);
    // The call that started and did not finish goes back as an error result, so it is not run again.
    expect(resume?.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'b', output: { type: 'error-text' } }],
    });
  });

  it('goes back to v2 when the reply ends, keeping how it ended', () => {
    const running = withProgress(
      startTurn(null, { conversationId: 'c1', seq: 1, user, now }),
      1,
      stepOne,
      later
    );
    const head = withEnd(running, 1, { messages: stepOne, status: 'done', ranOut: true }, later);
    expect(read(head)?.v).toBe(2);
    expect(turnFrom(head.turns[0]!).assistant).toMatchObject({
      status: 'done',
      ranOut: true,
      messages: stepOne,
    });
  });

  it('a retry replaces the turn’s reply and keeps the user’s message and the turns before it', () => {
    let head = withEnd(
      startTurn(null, { conversationId: 'c1', seq: 1, user, now }),
      1,
      { messages: stepOne, status: 'done' },
      now
    );
    head = startTurn(head, {
      conversationId: 'c1',
      seq: 2,
      user: { content: 'again', attachments: [] },
      now,
    });
    head = withEnd(head, 2, { messages: [], status: 'error', error: 'boom' }, now);
    const retried = startTurn(head, {
      conversationId: 'c1',
      seq: 2,
      user: { content: 'ignored', attachments: [] },
      now: later,
      from: { messages: stepOne, steps: 1, at: 0 },
    });
    expect(retried.turns.map((turn) => turn.seq)).toEqual([1, 2]);
    expect(retried.turns[1]).toMatchObject({
      user: { content: 'again' },
      assistant: { status: 'running', messages: stepOne },
    });
    expect(retried.turns[0]!.assistant).toMatchObject({ status: 'done' });
  });

  it('applies a patch, and `model: null` clears the chat’s model', () => {
    const head = startTurn(null, { conversationId: 'c1', seq: 1, user, now });
    const titled = withPatch(head, { v: 1, title: 'Plants', model: 'm1' }, later);
    expect(titled).toMatchObject({ title: 'Plants', titleSource: 'user', model: 'm1' });
    expect(withPatch(titled, { v: 1, model: null }, later)).not.toHaveProperty('model');
  });
});

describe('acceptsTurn', () => {
  const head = startTurn(null, { conversationId: 'c1', seq: 1, user, now });
  it('takes the next turn, or the latest again on retry, and nothing else', () => {
    expect(acceptsTurn(null, 1, false)).toBe(true);
    expect(acceptsTurn(head, 2, false)).toBe(true);
    expect(acceptsTurn(head, 1, false)).toBe(false);
    expect(acceptsTurn(head, 3, false)).toBe(false);
    expect(acceptsTurn(head, 1, true)).toBe(true);
    expect(acceptsTurn(head, 2, true)).toBe(true);
    expect(acceptsTurn(head, 3, true)).toBe(false);
  });
});

describe('firstMessageTitle', () => {
  it('cuts a long first message at a word', () => {
    expect(firstMessageTitle('   ')).toBe('New chat');
    expect(firstMessageTitle('a'.repeat(50))).toBe(`${'a'.repeat(40)}…`);
    expect(firstMessageTitle('one two three four five six seven eight nine ten')).toBe(
      'one two three four five six seven eight…'
    );
  });
});
