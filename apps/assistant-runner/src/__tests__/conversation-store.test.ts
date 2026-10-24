import { ThreadStore, type StoredConversationMetadata } from '@civitai/components-chat/core';
import { describe, expect, it } from 'vitest';

import { OrchestrationConversationStore, type ConversationLock } from '../conversation-store';
import { startTurn, withEnd, withPatch } from '../head';
import { MintRefusedError } from '../minter';
import { OrchestrationClient } from '../orchestration';
import { FakeOrchestration } from '../test-support/fake-orchestration';

const BASE = 'https://orchestration.example';
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const noLock: ConversationLock = { run: (_key, fn) => fn() };

function setup() {
  const orchestration = new FakeOrchestration();
  const minted: string[] = [];
  const store = new OrchestrationConversationStore({
    orchestration: new OrchestrationClient(BASE, orchestration.fetch),
    // The token a real deployment mints from the user's grant: here, the fake's token for that user.
    tokens: (userId) => async (purpose) => {
      minted.push(`${purpose}:${userId}`);
      return FakeOrchestration.tokenFor(userId);
    },
    lock: noLock,
    log: quiet,
  });
  /** The chat's own `ThreadStore`, as the browser runs it for `user`, over the same workflows. */
  const browser = (user: string, scope?: string) =>
    new ThreadStore({
      ...orchestration.browser(user),
      hideMatureContent: () => true,
      ownReplies: null,
      locks: null,
      ...(scope ? { scope } : {}),
    } as unknown as ConstructorParameters<typeof ThreadStore>[0]);
  return { orchestration, store, browser, minted };
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 12, minute));
const reply = (text: string) => [
  { role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
];

/** The user's turn `seq` saved and its reply ended `done` with `text`, as a run does it. */
async function runTurn(
  store: OrchestrationConversationStore,
  user: string,
  conversationId: string,
  seq: number,
  content: string,
  text: string,
  scope?: string
) {
  await store.update(user, conversationId, (head) =>
    startTurn(head, {
      conversationId,
      ...(scope ? { scope } : {}),
      seq,
      user: { content, attachments: [] },
      now: at(seq),
    })
  );
  return store.update(user, conversationId, (head) =>
    withEnd(head!, seq, { messages: reply(text), status: 'done' }, at(seq))
  );
}

describe('OrchestrationConversationStore', () => {
  it('saves a turn as a cvt:head echo workflow the browser’s ThreadStore opens, with every request as the viewer', async () => {
    const { orchestration, store, browser, minted } = setup();
    await runTurn(store, 'u1', 'c-remote', 1, 'Build me a timer app', 'Here is your timer.');

    expect(orchestration.workflows).toHaveLength(1);
    expect(orchestration.workflows[0]).toMatchObject({
      owner: 'u1',
      externalId: 'cvt-head-c-remote-1',
      tags: ['chat-cvt', 'cvt:turn', 'cvt:head', 'cvt:conv:c-remote'],
      steps: [{ $type: 'echo', name: 'turn', input: { message: 'chat-cvt turn' } }],
    });
    expect(new Set(minted)).toEqual(new Set(['chat:u1']));

    const opened = await browser('u1').open('c-remote');
    expect(opened.conversation).toMatchObject({
      id: 'c-remote',
      title: 'Build me a timer app',
      titleSource: 'first-message',
    });
    expect(opened.conversation.turns).toEqual([
      expect.objectContaining({
        seq: 1,
        user: expect.objectContaining({ content: 'Build me a timer app' }),
        assistant: expect.objectContaining({
          status: 'done',
          messages: reply('Here is your timer.'),
        }),
      }),
    ]);
  });

  it('carries on a conversation the browser started, and the browser then sees both turns', async () => {
    const { orchestration, store, browser } = setup();
    const page = browser('u1');
    const conversation = page.startNew();
    const turn = page.appendUserTurn('Hello from the page', []);
    turn.assistant = { messages: reply('Hello from the browser runner.'), status: 'done' };
    await page.completeTurn(turn);

    const head = (await store.load('u1', conversation.id)) as StoredConversationMetadata;
    expect(head).toMatchObject({ v: 2, app: 'chat-cvt', conversationId: conversation.id });
    expect(head.turns.map((t) => t.seq)).toEqual([1]);

    await runTurn(store, 'u1', conversation.id, 2, 'And now from the runner', 'Runner reply.');
    // A new turn is a new head; the old one is no longer tagged as the head.
    const heads = orchestration.workflows.filter((w) => w.tags.includes('cvt:head'));
    expect(heads.map((w) => w.externalId)).toEqual([`cvt-head-${conversation.id}-2`]);

    const reopened = await browser('u1').open(conversation.id);
    expect(
      reopened.conversation.turns.map((t) => [t.seq, t.user.content, t.assistant.status])
    ).toEqual([
      [1, 'Hello from the page', 'done'],
      [2, 'And now from the runner', 'done'],
    ]);
  });

  it('replaces the current head for anything but a new turn', async () => {
    const { orchestration, store } = setup();
    await runTurn(store, 'u1', 'c1', 1, 'hi', 'hello');
    await store.update('u1', 'c1', (head) =>
      head ? withPatch(head, { v: 1, title: 'Renamed', titleSource: 'user' }, at(30)) : null
    );
    expect(orchestration.workflows).toHaveLength(1);
    expect(orchestration.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(await store.load('u1', 'c1')).toMatchObject({ title: 'Renamed', titleSource: 'user' });
  });

  it('leaves the head as it is when the change returns nothing', async () => {
    const { orchestration, store } = setup();
    expect(await store.update('u1', 'missing', () => null)).toBeNull();
    expect(orchestration.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('tags a scoped chat with its scope, so the scoped browser list shows it', async () => {
    const { orchestration, store, browser } = setup();
    await runTurn(store, 'u1', 'c-scoped', 1, 'hi', 'hello', 'app-assistant');
    expect(orchestration.workflows[0]!.tags).toContain('cvt:scope:app-assistant');
    const page = browser('u1', 'app-assistant');
    await page.refreshList();
    expect(page.summaries.map((s) => s.id)).toEqual(['c-scoped']);
  });

  it('asks again with a freshly minted token when orchestration refuses a cached one', async () => {
    const orchestration = new FakeOrchestration();
    const asked: boolean[] = [];
    const store = new OrchestrationConversationStore({
      orchestration: new OrchestrationClient(BASE, orchestration.fetch),
      // The cached token has gone stale; only a fresh mint is accepted.
      tokens: (userId) => async (_purpose, options) => {
        asked.push(options?.fresh === true);
        return options?.fresh ? FakeOrchestration.tokenFor(userId) : 'stale-token';
      },
      lock: noLock,
      log: quiet,
    });
    await runTurn(store, 'u1', 'c-stale-token', 1, 'hi', 'hello');
    expect((await store.load('u1', 'c-stale-token'))!.turns).toHaveLength(1);
    expect(asked).toContain(true);
  });

  it('fails a write with the mint’s own refusal when there is no grant to act with', async () => {
    const orchestration = new FakeOrchestration();
    const refusal = new MintRefusedError('invalid_grant', 'no grant', 401);
    const store = new OrchestrationConversationStore({
      orchestration: new OrchestrationClient(BASE, orchestration.fetch),
      tokens: () => async () => {
        throw refusal;
      },
      lock: noLock,
      log: quiet,
    });
    // The patch route answers 403 on exactly this error, so it must reach the caller as it is.
    await expect(store.update('u1', 'c1', (head) => head)).rejects.toBe(refusal);
    expect(orchestration.requests).toEqual([]);
  });

  it('never reads another user’s conversation', async () => {
    const { store } = setup();
    await runTurn(store, 'u1', 'c-private', 1, 'secret plans', 'ok');
    expect(await store.load('u2', 'c-private')).toBeNull();
  });

  it('finds the head a crashed save left, by its externalId, and brings it up to date', async () => {
    const { orchestration, store } = setup();
    await runTurn(store, 'u1', 'c1', 1, 'hi', 'hello');
    // A save of turn 2 that landed, with metadata the change since has outdated, before its process died.
    orchestration.submit('u1', {
      steps: [],
      tags: ['chat-cvt', 'cvt:turn', 'cvt:head', 'cvt:conv:c1'],
      metadata: { stale: true },
      externalId: 'cvt-head-c1-2',
    });
    await runTurn(store, 'u1', 'c1', 2, 'again', 'hello again');
    const saved = orchestration.workflows.find((w) => w.externalId === 'cvt-head-c1-2')!;
    expect(saved.metadata).toMatchObject({ conversationId: 'c1' });
    expect((await store.load('u1', 'c1'))!.turns.map((t) => t.seq)).toEqual([1, 2]);
  });
});
