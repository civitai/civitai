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

  it('an edit replaces the turn’s message, drops its reply, and keeps the turns before it', () => {
    const second = { content: 'Water them on Sundays', attachments: [] };
    const edited = { content: 'Water them on Mondays', attachments: [] };
    let head = withEnd(
      startTurn(null, { conversationId: 'c1', seq: 1, user, now }),
      1,
      { messages: stepOne, status: 'done' },
      now
    );
    head = withEnd(
      startTurn(head, { conversationId: 'c1', seq: 2, user: second, now }),
      2,
      { messages: stepOne, status: 'done' },
      now
    );
    const next = startTurn(head, {
      conversationId: 'c1',
      seq: 2,
      user: edited,
      now: later,
      edit: true,
      runId: 'run-edit',
    });
    expect(next.turns).toEqual([
      head.turns[0],
      { seq: 2, createdAt: now.toISOString(), user: edited, runId: 'run-edit' },
    ]);
    expect(next).toMatchObject({ v: 2, title: user.content, updatedAt: later.toISOString() });
    // Read as the chat reads it: the edited message, no reply yet (cut off at the turn's start).
    expect(read(next)!.turns.map((turn) => turnFrom(turn).user.content)).toEqual([
      user.content,
      edited.content,
    ]);
    // Without `edit` the same start keeps the saved message (a retry): the flag is what replaces it.
    expect(
      startTurn(head, { conversationId: 'c1', seq: 2, user: edited, now: later }).turns[1]!.user
    ).toEqual(second);
  });

  it('an edit of the first message renames a chat named after it, and only such a chat', () => {
    const edited = { content: 'Make me an app that waters my cactus', attachments: [] };
    const head = withEnd(
      startTurn(null, { conversationId: 'c1', seq: 1, user, now }),
      1,
      { messages: stepOne, status: 'done' },
      now
    );
    expect(
      startTurn(head, { conversationId: 'c1', seq: 1, user: edited, now: later, edit: true })
    ).toMatchObject({ title: edited.content, titleSource: 'first-message' });
    const named = withPatch(head, { v: 1, title: 'Plants' }, now);
    expect(
      startTurn(named, { conversationId: 'c1', seq: 1, user: edited, now: later, edit: true })
    ).toMatchObject({ title: 'Plants', titleSource: 'user' });
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

  it('takes an edit of the latest turn, or of the next when nothing saved it, and nothing else', () => {
    expect(acceptsTurn(head, 1, false, true)).toBe(true);
    expect(acceptsTurn(head, 2, false, true)).toBe(true);
    expect(acceptsTurn(head, 3, false, true)).toBe(false);
    expect(acceptsTurn(null, 1, false, true)).toBe(true);
    expect(acceptsTurn(null, 2, false, true)).toBe(false);
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
