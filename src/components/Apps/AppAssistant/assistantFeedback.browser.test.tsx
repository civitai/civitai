import { describe, expect, test, vi } from 'vitest';
import type { ChatToolCall } from '@civitai/components-chat/civitai-chat';
import {
  GET_USER_FEEDBACK,
  SET_FEEDBACK_STATUS,
  createAppFeedbackSource,
  feedbackNotRead,
  type AuthorReads,
} from '@civitai/app-assistant';
import { createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import {
  FEEDBACK_NOTIFIES_TEXT,
  FEEDBACK_OFFER_NOT_LIVE,
  feedbackWhatText,
  feedbackButtonText,
  feedbackChangedText,
  feedbackDoneText,
  feedbackFailedText,
  type SetFeedbackStatus,
} from '~/components/Apps/AppAssistant/assistantFeedback';

/**
 * The feedback status card: a `set_feedback_status` call offers, and only the user's press on its
 * card writes — each item only if its status is still what the assistant read.
 */

const APP = 'tip-calc';
const LISTING = 'lst_own_71';
const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };
const conv = { conversationId: 'c', reply: 1 };

const READS: AuthorReads = {
  listMine: async () => [
    { appListingId: LISTING, slug: APP, status: 'approved', role: 'owner', problems: [] },
  ],
  listingHistory: async () => [],
  listFeedback: async () => ({
    items: [
      {
        id: 4417,
        message: 'wrong total',
        createdAt: '2026-10-22T08:30:00.000Z',
        appBlockVersion: null,
        ownerStatus: null,
      },
      {
        id: 5528,
        message: 'add dark mode',
        createdAt: '2026-10-23T08:30:00.000Z',
        appBlockVersion: null,
        ownerStatus: 'acknowledged',
      },
    ],
  }),
};

function setup(setStatus: SetFeedbackStatus = vi.fn<SetFeedbackStatus>(async () => 'ok')) {
  const gate = createAssistantGate({
    openApp: () => APP,
    feedback: { source: createAppFeedbackSource(READS), setStatus },
  });
  /** Runs a call through the gate as the chat does, and tells the gate of its result. */
  const call = async (name: string, input: Record<string, unknown>) => {
    await gate.beforeToolCall(name, input, conv);
    const output = await gate.tools[name]!.execute(input, ctx);
    gate.onToolResult({ name, input, output, isError: false });
    return output;
  };
  const render = (output: unknown) =>
    gate.tools[SET_FEEDBACK_STATUS]!.render!({
      id: 'call-1',
      name: SET_FEEDBACK_STATUS,
      input: {},
      output,
      state: 'done',
    } as ChatToolCall) as HTMLElement | undefined;
  return { gate, call, render, setStatus };
}

async function offer(s: ReturnType<typeof setup>, status = 'resolved', ids = [4417, 5528]) {
  await s.call(GET_USER_FEEDBACK, { status: 'all' });
  return s.call(SET_FEEDBACK_STATUS, { ids, status });
}

const button = (card: HTMLElement) => card.querySelector('button');

describe('the feedback status card', () => {
  test('offers a button for a live offer, and writes nothing until it is pressed', async () => {
    const s = setup();
    const output = await offer(s);
    const card = s.render(output)!;
    // The user sees the app and what each item says, not bare ids.
    expect(card.textContent).toContain(feedbackWhatText(APP, 'resolved'));
    const rows = [
      ...card.querySelectorAll('[data-testid="app-assistant-feedback-status-items"] li'),
    ];
    expect(rows.map((row) => row.textContent)).toEqual([
      '#4417: “wrong total”',
      '#5528: “add dark mode”',
    ]);
    expect(card.textContent).toContain(FEEDBACK_NOTIFIES_TEXT);
    expect(button(card)?.textContent).toBe(
      feedbackButtonText({
        items: [
          { id: 1, from: 'new', excerpt: '' },
          { id: 2, from: 'new', excerpt: '' },
        ],
        status: 'resolved',
      })
    );
    expect(s.setStatus).not.toHaveBeenCalled();

    button(card)!.click();
    await vi.waitFor(() => expect(card.textContent).toContain(feedbackDoneText(2, 'resolved')));
    // Each item with the status it was read with: a new item as null.
    expect(vi.mocked(s.setStatus).mock.calls.map(([input]) => input)).toEqual([
      { id: 4417, appListingId: LISTING, ownerStatus: 'resolved', expectedOwnerStatus: null },
      {
        id: 5528,
        appListingId: LISTING,
        ownerStatus: 'resolved',
        expectedOwnerStatus: 'acknowledged',
      },
    ]);
    expect(button(card)).toBeNull();
  });

  test('an excerpt is shown as text, never as markup', async () => {
    const s = setup();
    const card = s.render({
      awaitsUser: true,
      feedbackStatus: 'earlier-visit-2',
      app: APP,
      appListingId: LISTING,
      status: 'resolved',
      items: [{ id: 4417, from: 'new', excerpt: '<img src=x onerror=alert(1)>' }],
      note: '',
    })!;
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test('a new reply forgets what the last one read: no offer for those items', async () => {
    const s = setup();
    await s.call(GET_USER_FEEDBACK, { status: 'all' });
    // The next reply's first call resets what was read (the gate's onReply).
    await s.gate.beforeToolCall(SET_FEEDBACK_STATUS, {}, { conversationId: 'c', reply: 2 });
    await expect(
      Promise.resolve().then(() =>
        s.gate.tools[SET_FEEDBACK_STATUS]!.execute({ ids: [4417], status: 'resolved' }, ctx)
      )
    ).rejects.toThrow(feedbackNotRead([4417]));
  });

  test('acknowledged does not say the writers are told', async () => {
    const s = setup();
    const card = s.render(await offer(s, 'acknowledged', [4417]))!;
    expect(card.textContent).not.toContain(FEEDBACK_NOTIFIES_TEXT);
  });

  test('an offer from a saved chat shows no button', () => {
    const s = setup();
    const card = s.render({
      awaitsUser: true,
      feedbackStatus: 'earlier-visit-1',
      app: APP,
      appListingId: LISTING,
      status: 'resolved',
      items: [{ id: 4417, from: 'new', excerpt: 'wrong total' }],
      note: '',
    })!;
    expect(button(card)).toBeNull();
    expect(card.textContent).toContain(FEEDBACK_OFFER_NOT_LIVE);
  });

  test('an item that changed since it was read is left alone, and said so', async () => {
    const s = setup(vi.fn<SetFeedbackStatus>(async ({ id }) => (id === 5528 ? 'changed' : 'ok')));
    const card = s.render(await offer(s))!;
    button(card)!.click();
    await vi.waitFor(() => expect(card.textContent).toContain(feedbackChangedText([5528])));
    expect(card.textContent).toContain(feedbackDoneText(1, 'resolved'));
    expect(button(card)).toBeNull();
  });

  test('a failed write offers the button again for the failed items only', async () => {
    const setStatus = vi
      .fn<SetFeedbackStatus>()
      .mockResolvedValueOnce('ok')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('ok');
    const s = setup(setStatus);
    const card = s.render(await offer(s))!;
    button(card)!.click();
    await vi.waitFor(() => expect(card.textContent).toContain(feedbackFailedText([5528])));
    button(card)!.click();
    await vi.waitFor(() => expect(button(card)).toBeNull());
    expect(setStatus.mock.calls.map(([input]) => input.id)).toEqual([4417, 5528, 5528]);
  });
});
