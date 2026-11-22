import { describe, expect, it } from 'vitest';
import {
  chatChoseApp,
  conversationsChoosing,
  toolResultsOfChat,
} from '~/server/services/app-assistant/trace-backfill';

/** A saved chat whose one reply made `calls` ([toolName, output as saved]). */
function chat(conversationId: string, calls: Array<[string, unknown]>) {
  return {
    conversationId,
    turns: [
      {
        seq: 1,
        assistant: {
          messages: [
            {
              role: 'assistant',
              content: calls.map(([toolName], i) => ({
                type: 'tool-call',
                toolCallId: `${conversationId}-${i}`,
                toolName,
                input: {},
              })),
            },
            {
              role: 'tool',
              content: calls.map(([toolName, output], i) => ({
                type: 'tool-result',
                toolCallId: `${conversationId}-${i}`,
                toolName,
                output,
              })),
            },
          ],
        },
      },
    ],
  };
}
const json = (value: unknown) => ({ type: 'json', value });

describe('the backfill matcher', () => {
  it('a chat whose create_app made the app, or whose use_open_app / wake_app opened it, chose it', () => {
    expect(chatChoseApp(chat('a', [['create_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
    expect(chatChoseApp(chat('b', [['use_open_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
    expect(chatChoseApp(chat('c', [['wake_app', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      true
    );
  });

  it('a call that failed, a create_app that found the app existing, or another app does not count', () => {
    expect(
      chatChoseApp(
        chat('d', [['use_open_app', json({ app: 'slug-one', error: 'no' })]]),
        'slug-one'
      )
    ).toBe(false);
    expect(
      chatChoseApp(
        chat('e', [['create_app', json({ app: 'slug-one', existed: true })]]),
        'slug-one'
      )
    ).toBe(false);
    expect(
      chatChoseApp(
        chat('f', [['use_open_app', { type: 'error-text', value: 'slug-one' }]]),
        'slug-one'
      )
    ).toBe(false);
    expect(chatChoseApp(chat('g', [['create_app', json({ app: 'slug-two' })]]), 'slug-one')).toBe(
      false
    );
    expect(chatChoseApp(chat('h', [['read_docs', json({ app: 'slug-one' })]]), 'slug-one')).toBe(
      false
    );
  });

  it('a call with no result (cut off) is not read', () => {
    const cut = chat('i', [['use_open_app', json({ app: 'slug-one' })]]);
    cut.turns[0]!.assistant.messages.pop();
    expect(toolResultsOfChat(cut)).toEqual([]);
  });

  it('lists the matching chats in order, once each', () => {
    const chats = [
      chat('m1', [['create_app', json({ app: 'slug-one' })]]),
      chat('m2', [['create_app', json({ app: 'slug-two' })]]),
      chat('m3', [
        ['use_open_app', json({ app: 'slug-two' })],
        ['use_open_app', json({ app: 'slug-one' })],
      ]),
      chat('m1', [['create_app', json({ app: 'slug-one' })]]),
    ];
    expect(conversationsChoosing(chats, 'slug-one')).toEqual(['m1', 'm3']);
  });
});
