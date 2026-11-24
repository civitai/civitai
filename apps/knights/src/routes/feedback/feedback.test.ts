import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitFeedback = vi.hoisted(() => vi.fn());
const feedbackEnabled = vi.hoisted(() => vi.fn());
const getPlayerStatus = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/player-status', () => ({ getPlayerStatus }));
vi.mock('$lib/server/feedback/enabled', () => ({ feedbackEnabled }));
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/feedback/feedback.service', async (original) => ({
  ...(await original<typeof import('$lib/server/feedback/feedback.service')>()),
  submitFeedback,
}));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2027-01-10T12:00:00Z') },
}));

const { POST } = await import('./+server');

const user = { id: 7, username: 'ana' };
const post = async (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const response = await POST({
    request: new Request('http://knights.test/feedback', {
      method: 'POST',
      body,
      headers: { 'user-agent': 'UA/1' },
    }),
    locals: { user },
  } as never);
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  submitFeedback.mockReset().mockResolvedValue({ ok: true });
  feedbackEnabled.mockReset().mockResolvedValue(true);
  getPlayerStatus.mockReset().mockResolvedValue({ rank: 'Knight', level: 12 });
  getStanding.mockReset().mockResolvedValue({ banned: false, muted: false });
});

describe('POST /feedback', () => {
  it('files the message with where the player was and how they play', async () => {
    expect(await post({ message: 'hello', path: '/play' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(feedbackEnabled).toHaveBeenCalledWith(user);
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 7,
        message: 'hello',
        context: { path: '/play', userAgent: 'UA/1', rank: 'Knight', level: 12 },
      })
    );
  });

  it('still files it when the player status cannot be read', async () => {
    getPlayerStatus.mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await post({ message: 'hello', path: '/codex' })).toMatchObject({ status: 200 });
    expect(submitFeedback.mock.calls[0][1].context).toEqual({ path: '/codex', userAgent: 'UA/1' });
  });

  it('refuses, and writes nothing, when the flag is off for the player', async () => {
    feedbackEnabled.mockResolvedValue(false);
    expect(await post({ message: 'hello' })).toMatchObject({ status: 403, body: { ok: false } });
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('refuses, and writes nothing, when the player is muted', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
    expect(await post({ message: 'hello' })).toMatchObject({ status: 403, body: { ok: false } });
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 400],
    ['rate-limited', 429],
  ])('answers a %s submission with %i and a message to show', async (reason, status) => {
    submitFeedback.mockResolvedValue({ ok: false, reason });
    expect(await post({ message: 'hello' })).toMatchObject({
      status,
      body: { ok: false, message: expect.any(String) },
    });
  });

  it('answers 500 when the write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    submitFeedback.mockRejectedValue(new Error('db down'));
    expect(await post({ message: 'hello' })).toMatchObject({ status: 500, body: { ok: false } });
  });
});
