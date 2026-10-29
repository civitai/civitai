import { beforeEach, describe, expect, it, vi } from 'vitest';

const castVote = vi.hoisted(() => vi.fn());
const feedSecretMock = vi.hoisted(() => vi.fn(() => 'secret'));
const answerHiddenCheck = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: feedSecretMock, resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  answerHiddenCheck,
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));

const { sealItem } = await import('$lib/server/feed-token');
const { actions } = await import('./+page.server');

const queueItem = (id: number) => sealItem('secret', 7, { kind: 'queue', id });
const hiddenItem = (id: number) => sealItem('secret', 7, { kind: 'hidden', id });

const submit = (fields: Record<string, string>, user: Record<string, unknown> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.vote({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: 7, ...user } },
  } as never);
};

beforeEach(() => {
  castVote.mockReset();
  answerHiddenCheck.mockReset();
});

describe('vote action', () => {
  it('turns a failed vote into a player-facing message and logs the cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    castVote.mockImplementation(async () => {
      throw new Error('connection reset');
    });

    const result = await submit({ item: queueItem(3), answer: '4' });

    expect(result).toMatchObject({
      status: 500,
      data: { message: expect.stringMatching(/try again/i) },
    });
    expect(log).toHaveBeenCalled();
  });

  it('acknowledges a counted vote', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toEqual({ success: true });
  });

  it('reports a rejected vote with its own message', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 409,
      data: { message: expect.stringMatching(/already judged/i) },
    });
  });

  it('tells a player whose vote would weigh nothing why it was not counted', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'no-weight' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 409,
      data: { message: expect.stringMatching(/standing/i) },
    });
  });

  it('tells a paced player to rest', async () => {
    castVote.mockResolvedValue({ status: 'limited', until: new Date('2026-12-15T12:00:30Z') });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 429,
      data: { message: expect.stringMatching(/too quickly/i), lockoutSeconds: 30 },
    });
  });

  it('passes the moderator flag so moderators are not paced', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    await submit({ item: queueItem(3), answer: '4' }, { isModerator: true });
    expect(castVote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, isModerator: true }),
      expect.anything()
    );
  });

  it('answers with the normal failure, not a thrown error, when the feed key is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    feedSecretMock.mockImplementationOnce(() => {
      throw new Error('FEED_TOKEN_SECRET is not configured');
    });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 500,
      data: { message: expect.stringMatching(/try again/i) },
    });
    expect(castVote).not.toHaveBeenCalled();
  });

  it('asks for an answer when the form is incomplete', async () => {
    expect(await submit({ item: 'x' })).toMatchObject({ status: 400 });
    expect(castVote).not.toHaveBeenCalled();
  });

  it("refuses an item token that is not the caller's", async () => {
    const foreign = sealItem('secret', 8, { kind: 'queue', id: 3 });
    expect(await submit({ item: foreign, answer: '4' })).toMatchObject({ status: 400 });
    expect(castVote).not.toHaveBeenCalled();
  });

  it('answers a hidden check exactly as it answers a vote', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    answerHiddenCheck.mockResolvedValue({ status: 'recorded' });

    const asVote = await submit({ item: queueItem(3), answer: '4' });
    const asCheck = await submit({ item: hiddenItem(5), answer: '8' });

    expect(asCheck).toEqual(asVote);
    expect(asCheck).toEqual({ success: true });
    expect(answerHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, referenceId: 5, answer: '8' }),
      expect.anything()
    );
    expect(castVote).toHaveBeenCalledTimes(1);
  });

  it('refuses a hidden check with the same message and status as a vote', async () => {
    const rejected = { status: 'rejected', reason: 'reset-pending' };
    castVote.mockResolvedValue(rejected);
    answerHiddenCheck.mockResolvedValue(rejected);
    expect(await submit({ item: hiddenItem(5), answer: '8' })).toEqual(
      await submit({ item: queueItem(3), answer: '4' })
    );
  });

  it('paces a hidden check like a vote', async () => {
    answerHiddenCheck.mockResolvedValue({
      status: 'limited',
      until: new Date('2026-12-15T12:00:30Z'),
    });
    expect(await submit({ item: hiddenItem(5), answer: '8' })).toMatchObject({
      status: 429,
      data: { lockoutSeconds: 30 },
    });
  });

  it('tells a player whose career reset is pending why they cannot vote', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'reset-pending' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 409,
      data: { message: expect.stringMatching(/reset/i) },
    });
  });
});
