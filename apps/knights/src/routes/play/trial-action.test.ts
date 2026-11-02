import { beforeEach, describe, expect, it, vi } from 'vitest';

const answerTrial = vi.hoisted(() => vi.fn());
const getTrialSummary = vi.hoisted(() => vi.fn());
const markPassedSummary = vi.hoisted(() => vi.fn());
const acknowledgePassedSummary = vi.hoisted(() => vi.fn());
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
vi.mock('$lib/server/trials/runtime', () => ({ trialDeps: {} }));
vi.mock('$lib/server/trials/summary-runtime', () => ({ summaryStore: {} }));
vi.mock('$lib/server/trials/pending-summary', () => ({
  pendingPassedSummary: vi.fn(),
  markPassedSummary,
  acknowledgePassedSummary,
}));
vi.mock('$lib/server/trials/trials.service', () => ({
  answerTrial,
  getTrial: vi.fn(),
  getTrialSummary,
}));

const { actions } = await import('./+page.server');

const answer = () => {
  const body = new FormData();
  body.set('referenceId', '5');
  body.set('questionKey', 'q');
  body.set('answer', '4');
  return actions.trial({
    request: new Request('http://x', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
  answerTrial.mockReset();
  getTrialSummary.mockReset();
  markPassedSummary.mockReset();
  acknowledgePassedSummary.mockReset();
});

describe('trial action', () => {
  it('answers mid-run with only whether it was right, and no reveal', async () => {
    answerTrial.mockResolvedValue({ status: 'recorded', correct: false, finished: null });

    expect(await answer()).toEqual({ success: true, correct: false, finished: false });
    expect(markPassedSummary).not.toHaveBeenCalled();
  });

  it('remembers a passed summary for the run that just finished', async () => {
    answerTrial.mockResolvedValue({
      status: 'recorded',
      correct: true,
      finished: { result: 'passed', score: 1 },
    });
    getTrialSummary.mockResolvedValue({ runId: 33, result: 'passed' });

    expect(await answer()).toEqual({ success: true, correct: true, finished: true });
    expect(markPassedSummary).toHaveBeenCalledWith({}, 7, 33);
  });

  it('remembers nothing for a failed run, whose summary lasts as long as its cooldown', async () => {
    answerTrial.mockResolvedValue({
      status: 'recorded',
      correct: false,
      finished: { result: 'failed', score: 0.5 },
    });

    expect(await answer()).toMatchObject({ finished: true });
    expect(markPassedSummary).not.toHaveBeenCalled();
  });
});

describe('enterOrder action', () => {
  const enter = () =>
    actions.enterOrder({ locals: { user: { id: 7 } } } as never) as Promise<unknown>;

  it('acknowledges the passed summary', async () => {
    acknowledgePassedSummary.mockResolvedValue(true);
    expect(await enter()).toEqual({ success: true });
    expect(acknowledgePassedSummary).toHaveBeenCalledWith({}, 7);
  });

  it('refuses when the acknowledgement could not be stored, so the player is not left guessing', async () => {
    acknowledgePassedSummary.mockResolvedValue(false);
    expect(await enter()).toMatchObject({ status: 500 });
  });
});
