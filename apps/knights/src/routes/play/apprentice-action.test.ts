import { beforeEach, describe, expect, it, vi } from 'vitest';

const answerApprentice = vi.hoisted(() => vi.fn());
const acknowledgeCheckpoint = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));
vi.mock('$lib/server/apprenticeship/runtime', () => ({
  apprenticeDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/apprenticeship/apprenticeship.service', () => ({
  answerApprentice,
  acknowledgeCheckpoint,
  getApprentice: vi.fn(),
}));

const { actions } = await import('./+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.apprentice({
    request: new Request('http://x', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never) as Promise<Record<string, unknown>>;
};
const valid = { kind: 'rating', referenceId: '5', answer: '4' };

beforeEach(() => {
  answerApprentice.mockReset();
  acknowledgeCheckpoint.mockReset();
});

describe('apprentice action', () => {
  it('answers with only whether it was right, and whether the player was knighted', async () => {
    answerApprentice.mockResolvedValue({
      status: 'recorded',
      correct: false,
      xp: 0,
      promoted: false,
    });

    expect(await post(valid)).toEqual({ success: true, correct: false, promoted: false });
    expect(answerApprentice).toHaveBeenCalledWith(
      {},
      { userId: 7, kind: 'rating', referenceId: 5, answer: '4' },
      expect.anything()
    );
  });

  it('turns a refused answer into a 409 the page can show', async () => {
    answerApprentice.mockResolvedValue({ status: 'rejected', reason: 'checkpoint-pending' });
    expect(await post(valid)).toMatchObject({ status: 409 });
  });

  it('refuses a malformed submission before touching the ledger', async () => {
    expect(await post({ ...valid, kind: 'other' })).toMatchObject({ status: 400 });
    expect(await post({ ...valid, referenceId: 'x' })).toMatchObject({ status: 400 });
    expect(answerApprentice).not.toHaveBeenCalled();
  });

  it('answers 500 rather than a verdict when the ledger throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answerApprentice.mockRejectedValue(new Error('down'));
    expect(await post(valid)).toMatchObject({ status: 500 });
  });

  it('moves past a checkpoint for the signed-in player', async () => {
    const result = await actions.continueCheckpoint({ locals: { user: { id: 7 } } } as never);
    expect(result).toEqual({ success: true });
    expect(acknowledgeCheckpoint).toHaveBeenCalledWith({}, 7, expect.any(Date));
  });
});
