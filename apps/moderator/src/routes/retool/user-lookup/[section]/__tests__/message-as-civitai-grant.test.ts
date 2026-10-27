import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Messaging as Civitai Moderation is bound to its own grant through the REAL `requiresGrant`: holding
 * `user.strike` (one-way notifications) does not open a thread the user can answer.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { sendAsCivitai } = vi.hoisted(() => ({
  sendAsCivitai: vi.fn(async () => ({
    ok: true as const,
    value: { chatId: 41, messageId: 7, deduped: false },
  })),
}));
vi.mock('$lib/server/message-as-civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/message-as-civitai')>()),
  sendAsCivitai,
}));

const { actions } = await import('../+page.server');

const TARGET = 8675309;
const KEY = 'compose-key-0001';

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['messageAsCivitai']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('messageAsCivitai action', () => {
  it('refuses a moderator holding only user.strike', async () => {
    const result = await actions.messageAsCivitai(
      formEvent({ 'user.strike': true }, { userId: String(TARGET), message: 'hi', idempotencyKey: KEY })
    );
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(sendAsCivitai).not.toHaveBeenCalled();
  });

  it('sends with the grant, passing the idempotency key through', async () => {
    const result = await actions.messageAsCivitai(
      formEvent(
        { 'user.message.asCivitai': true },
        { userId: String(TARGET), message: ' hi ', idempotencyKey: KEY }
      )
    );
    expect(result).toEqual({ success: true, chatId: 41 });
    expect(sendAsCivitai).toHaveBeenCalledWith({ userId: TARGET, message: 'hi', idempotencyKey: KEY });
  });

  it('shows the main app refusal instead of reporting success', async () => {
    sendAsCivitai.mockResolvedValueOnce({ ok: false, error: 'Another moderator is answering.' } as never);
    const result = await actions.messageAsCivitai(
      formEvent(
        { 'user.message.asCivitai': true },
        { userId: String(TARGET), message: 'hi', idempotencyKey: KEY }
      )
    );
    expect(result).toMatchObject({
      status: 400,
      data: { scope: 'message', error: 'Another moderator is answering.' },
    });
  });
});
