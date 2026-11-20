import { beforeEach, describe, expect, it, vi } from 'vitest';

const castReviewVote = vi.hoisted(() => vi.fn());
const sendToInquisitor = vi.hoisted(() => vi.fn());
const nextReview = vi.hoisted(() => vi.fn());
const setImageLevelAsModerator = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/skill-check/runtime', () => ({
  skillChecks: async () => ({ poolCap: 500, serveJudged: false }),
}));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/inquisitor/review.service', () => ({
  castReviewVote,
  sendToInquisitor,
  nextReview,
}));
vi.mock('$lib/server/inquisitor/context', () => ({
  moderatorStats: async () => ({ votesThisWeek: 0, waiting: 0, agreementRate: null }),
  reviewSidebar: async () => ({}),
}));
vi.mock('$lib/server/inquisitor/main-app', () => ({ setImageLevelAsModerator }));

const { sealItem, sealReview } = await import('$lib/server/feed-token');
const { inquisitorActions, inquisitorView } = await import('./inquisitor.server');

const call = (
  action: keyof typeof inquisitorActions,
  fields: Record<string, string>,
  user: Record<string, unknown> = { id: 7, isModerator: true }
) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return inquisitorActions[action]({
    request: new Request('http://knights.test/play', {
      method: 'POST',
      body,
      headers: { cookie: 'civ-token=s' },
    }),
    locals: { user },
  } as never);
};

beforeEach(() => {
  castReviewVote.mockReset();
  sendToInquisitor.mockReset();
  setImageLevelAsModerator.mockReset();
});

describe('inquisitor actions', () => {
  it.each(['inquisitorVote', 'sendToInquisitor'] as const)(
    'refuses a player who is not a moderator with 403 and writes nothing (%s)',
    async (action) => {
      await expect(
        call(
          action,
          { token: sealReview('secret', 7, 1), answer: '4' },
          { id: 7, isModerator: false }
        )
      ).rejects.toMatchObject({ status: 403 });
      expect(castReviewVote).not.toHaveBeenCalled();
      expect(sendToInquisitor).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a tampered token', 'x'.repeat(40)],
    ["another moderator's token", sealReview('secret', 8, 1)],
    ['a feed item token', sealItem('secret', 7, { kind: 'queue', id: 1 })],
  ])('refuses %s with 400 and writes nothing', async (_label, token) => {
    expect(await call('inquisitorVote', { token, answer: '4' })).toMatchObject({ status: 400 });
    expect(castReviewVote).not.toHaveBeenCalled();
  });

  it('records a vote on the sealed review and writes an override with the request cookie', async () => {
    castReviewVote.mockImplementation(async (_db, _input, deps) => {
      await deps.setImageLevel(12, 8);
      return { status: 'confirmed' };
    });
    setImageLevelAsModerator.mockResolvedValue({ ok: true });

    expect(
      await call('inquisitorVote', { token: sealReview('secret', 7, 3), answer: '8' })
    ).toEqual({
      reviewed: 'confirmed',
    });
    expect(castReviewVote).toHaveBeenCalledWith(
      {},
      { reviewId: 3, moderatorId: 7, answer: '8' },
      expect.objectContaining({ poolCap: 500 })
    );
    expect(setImageLevelAsModerator).toHaveBeenCalledWith({
      cookie: 'civ-token=s',
      imageId: 12,
      level: 8,
    });
  });

  it('turns a refusal into a 409 with words for the moderator', async () => {
    castReviewVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    expect(
      await call('inquisitorVote', { token: sealReview('secret', 7, 3), answer: '4' })
    ).toMatchObject({
      status: 409,
      data: { message: expect.stringContaining('closed') },
    });
  });

  it('sends a sealed review to the Inquisitors', async () => {
    sendToInquisitor.mockResolvedValue({ status: 'sent' });
    expect(await call('sendToInquisitor', { token: sealReview('secret', 7, 3) })).toEqual({
      reviewed: 'sent',
    });
    expect(sendToInquisitor).toHaveBeenCalledWith(
      {},
      { reviewId: 3, moderatorId: 7 },
      expect.anything()
    );
  });
});

describe('inquisitorView', () => {
  it('serves a moderator a review by sealed token, never by its id', async () => {
    nextReview.mockResolvedValue({
      reviewId: 3,
      queueItemId: 9,
      imageId: 12,
      imageKey: 'key-12',
      width: 10,
      height: 20,
      consensusValue: '4',
      currentLevel: 4,
      votes: 1,
    });
    const view = await inquisitorView(7);
    expect(view.mode).toBe('inquisitor');
    expect(view.levels.map((l) => l.value)).toEqual(['1', '2', '4', '8', '16']);
    expect(JSON.stringify(view)).not.toMatch(/"reviewId"|"queueItemId"/);
    expect(view.review?.token).toBeTypeOf('string');
  });
});
