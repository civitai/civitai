import { beforeEach, describe, expect, it, vi } from 'vitest';

const castVote = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: {} }));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));

const { actions } = await import('./+page.server');

const submit = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.vote({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(() => {
  castVote.mockReset();
});

describe('vote action', () => {
  it('turns a failed vote into a player-facing message and logs the cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    castVote.mockImplementation(async () => {
      throw new Error('connection reset');
    });

    const result = await submit({ itemId: '3', answer: '4' });

    expect(result).toMatchObject({
      status: 500,
      data: { message: expect.stringMatching(/try again/i) },
    });
    expect(log).toHaveBeenCalled();
  });

  it('reports a rejected vote with its own message', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });
    expect(await submit({ itemId: '3', answer: '4' })).toMatchObject({
      status: 409,
      data: { message: expect.stringMatching(/already judged/i) },
    });
  });

  it('tells a player whose vote would weigh nothing why it was not counted', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'no-weight' });
    expect(await submit({ itemId: '3', answer: '4' })).toMatchObject({
      status: 409,
      data: { message: expect.stringMatching(/standing/i) },
    });
  });

  it('asks for an answer when the form is incomplete', async () => {
    expect(await submit({ itemId: 'x' })).toMatchObject({ status: 400 });
    expect(castVote).not.toHaveBeenCalled();
  });
});
