import { beforeEach, describe, expect, it, vi } from 'vitest';

const castVote = vi.hoisted(() => vi.fn());
const feedSecretMock = vi.hoisted(() => vi.fn(() => 'secret'));
const answerHiddenCheck = vi.hoisted(() => vi.fn());
const castYesNoVote = vi.hoisted(() => vi.fn());
const getStanding = vi.hoisted(() => vi.fn());
const logToAxiom = vi.hoisted(() => vi.fn(async () => undefined));
const creditLateJudgment = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/queue/vote-record', () => ({ creditLateJudgment }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/standing', async (original) => ({
  ...(await original<typeof import('$lib/server/standing')>()),
  getStanding,
}));
vi.mock('$lib/server/skip-runtime', async () => ({
  skipStore: (await import('$lib/server/skips')).memorySkipStore(),
}));
vi.mock('$lib/server/db', () => ({ db: {}, dbRead: {} }));
const guard = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/vote-limits/runtime', () => ({ voteGate: { guard }, lockoutFor: vi.fn() }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: feedSecretMock, resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
const inquisitorQueue = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/skill-check/runtime', () => ({
  skillChecks: async () => ({ enabled: inquisitorQueue.enabled, poolCap: 500, serveJudged: true }),
}));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', () => ({
  hiddenItemId: (id: number) => -id,
  answerHiddenCheck,
  pickHiddenCheck: vi.fn(),
  readHiddenNotices: vi.fn(),
  dismissHiddenNotices: vi.fn(),
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote, getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));

const { sealItem } = await import('$lib/server/feed-token');
const { actions } = await import('./+page.server');
const { markPress } = await import('./optimistic');

// The `knights-vote-refused` rows written to Axiom, in order.
type Row = { name: string; details: Record<string, unknown>; payload: Record<string, unknown> };
const refusedRowsFull = () =>
  (logToAxiom.mock.calls as unknown as [Row][])
    .map(([row]) => row)
    .filter((row) => row.name === 'knights-vote-refused');
const refusedRows = () =>
  refusedRowsFull().map(({ details, payload }) => ({
    reason: details.reason,
    kind: payload.kind,
    playerId: details.playerId,
    itemId: payload.itemId,
    action: payload.action,
  }));

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
  guard.mockReset();
  guard.mockImplementation(async (_user, _now, work) => work());
  getStanding.mockReset();
  getStanding.mockResolvedValue({ banned: false, muted: false });
  castVote.mockReset();
  answerHiddenCheck.mockReset();
  castYesNoVote.mockReset();
  logToAxiom.mockClear();
  creditLateJudgment.mockReset();
});

describe('vote action on a yes/no question', () => {
  const yesNoItem = (id: number) => sealItem('secret', 7, { kind: 'yesno', id });

  it('routes a sealed question to the yes/no vote and nothing else', async () => {
    castYesNoVote.mockResolvedValue({ status: 'recorded' });

    expect(await submit({ item: yesNoItem(41), answer: 'yes' })).toEqual({ success: true });

    expect(castYesNoVote).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 7, itemId: 41, answer: 'yes', isModerator: undefined },
      expect.anything()
    );
    expect(castVote).not.toHaveBeenCalled();
    expect(answerHiddenCheck).not.toHaveBeenCalled();
  });

  it('keeps a rating token away from the yes/no vote', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    await submit({ item: queueItem(41), answer: 'yes' });
    expect(castYesNoVote).not.toHaveBeenCalled();
  });

  it('answers a refusal and a pace limit as any vote does', async () => {
    castYesNoVote.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });
    expect(await submit({ item: yesNoItem(41), answer: 'yes' })).toMatchObject({ status: 409 });
    castYesNoVote.mockResolvedValue({ status: 'limited', until: new Date('2026-12-15T12:00:30Z') });
    expect(await submit({ item: yesNoItem(41), answer: 'yes' })).toMatchObject({
      status: 429,
      data: { lockoutSeconds: 30 },
    });
  });
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

  it('names the refusal reason, so the page can tell an item that moved on from a mistake', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toMatchObject({
      status: 409,
      data: { reason: 'not-open', message: expect.stringMatching(/settled/i) },
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

  it.each([true, false])(
    'accepts a mod-confirmed check only with the inquisitor queue on (on: %s)',
    async (enabled) => {
      answerHiddenCheck.mockResolvedValue({ status: 'recorded' });
      inquisitorQueue.enabled = enabled;
      try {
        await submit({ item: hiddenItem(5), answer: '8' });
      } finally {
        inquisitorQueue.enabled = true;
      }
      expect(answerHiddenCheck).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skillChecks: enabled, serveJudged: true }),
        expect.anything()
      );
    }
  );

  it('grades a hidden check in the request and returns what it cost', async () => {
    const check = { verdict: 'failed', consequence: 'smite', smites: 1, reset: false };
    answerHiddenCheck.mockResolvedValue({ status: 'recorded', check });

    expect(await submit({ item: hiddenItem(5), answer: '8' })).toEqual({ success: true, check });
    expect(answerHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ grade: expect.objectContaining({ settings: { rate: 1 } }) })
    );
  });

  it('records why each refused vote was refused, with its kind and the player', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    answerHiddenCheck.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });

    await submit({ item: queueItem(3), answer: '4' });
    await submit({ item: hiddenItem(5), answer: '8' });

    expect(refusedRows()).toEqual([
      { reason: 'not-open', kind: 'rating', playerId: 7, itemId: 3, action: 'vote' },
      // A hidden check is logged under its ledger id, the negative of its reference id.
      { reason: 'already-voted', kind: 'hidden_check', playerId: 7, itemId: -5, action: 'vote' },
    ]);
  });

  it('records a vote the Redis gate turns away, busy or limited', async () => {
    guard.mockResolvedValueOnce({ until: new Date('2026-12-15T12:01:00Z'), busy: true });
    await submit({ item: queueItem(3), answer: '4' });
    guard.mockResolvedValueOnce({ until: new Date('2026-12-15T12:01:00Z') });
    await submit({ item: hiddenItem(5), answer: '4' });

    expect(refusedRows()).toEqual([
      { reason: 'busy', kind: 'rating', playerId: 7, itemId: 3, action: 'vote' },
      { reason: 'limited', kind: 'hidden_check', playerId: 7, itemId: -5, action: 'vote' },
    ]);
  });

  it('records a muted player and a token that does not open', async () => {
    getStanding.mockResolvedValueOnce({ banned: false, muted: true });
    await submit({ item: queueItem(3), answer: '4' });
    await submit({ item: 'not-a-token', answer: '4' });

    expect(refusedRows()).toEqual([
      { reason: 'muted', kind: 'unknown', playerId: 7, itemId: null, action: 'vote' },
      { reason: 'bad-token', kind: 'unknown', playerId: 7, itemId: null, action: 'vote' },
    ]);
  });

  it('records nothing for a vote that was recorded', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    await submit({ item: queueItem(3), answer: '4' });
    expect(refusedRows()).toEqual([]);
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

describe('vote action block reason', () => {
  it('passes the chosen reason to a rating vote and to a hidden check', async () => {
    castVote.mockResolvedValue({ status: 'recorded' });
    answerHiddenCheck.mockResolvedValue({ status: 'recorded' });

    expect(await submit({ item: queueItem(3), answer: '32', blockReason: 'Bestiality' })).toEqual({
      success: true,
    });
    await submit({ item: hiddenItem(5), answer: '32', blockReason: 'Other' });

    expect(castVote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answer: '32', blockReason: 'Bestiality' }),
      expect.anything()
    );
    expect(answerHiddenCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ answer: '32', blockReason: 'Other' }),
      expect.anything()
    );
  });

  it('answers 400 with a friendly message for a reason not on the list, writing nothing', async () => {
    const result = await submit({ item: queueItem(3), answer: '32', blockReason: 'Nope' });
    expect(result).toMatchObject({
      status: 400,
      data: { message: expect.stringMatching(/reason/i) },
    });
    expect(castVote).not.toHaveBeenCalled();
  });

  it('answers 400, not 409, when the service finds Blocked without a reason or a reason without Blocked', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'bad-block-reason' });
    expect(await submit({ item: queueItem(3), answer: '32' })).toMatchObject({
      status: 400,
      data: { message: expect.stringMatching(/reason/i) },
    });
    expect(await submit({ item: queueItem(3), answer: '8', blockReason: 'Other' })).toMatchObject({
      status: 400,
    });
  });

  it('refuses a reason on a yes/no answer', async () => {
    const item = sealItem('secret', 7, { kind: 'yesno', id: 41 });
    expect(await submit({ item, answer: 'yes', blockReason: 'Other' })).toMatchObject({
      status: 400,
    });
    expect(castYesNoVote).not.toHaveBeenCalled();
  });
});

describe('vote action for a muted player', () => {
  beforeEach(() => {
    getStanding.mockResolvedValue({ banned: false, muted: true });
  });

  it.each([
    ['rating', queueItem(3), '4'],
    ['hidden check', hiddenItem(5), '8'],
    ['yes/no', sealItem('secret', 7, { kind: 'yesno', id: 41 }), 'yes'],
  ])('refuses a %s vote with a friendly 403 and records nothing', async (_kind, item, answer) => {
    expect(await submit({ item, answer })).toMatchObject({
      status: 403,
      data: { message: expect.stringMatching(/muted/i) },
    });
    expect(castVote).not.toHaveBeenCalled();
    expect(answerHiddenCheck).not.toHaveBeenCalled();
    expect(castYesNoVote).not.toHaveBeenCalled();
  });

  it('refuses before it even reads the form', async () => {
    expect(await submit({})).toMatchObject({ status: 403 });
  });

  it('still counts the vote of a player who is not muted', async () => {
    getStanding.mockResolvedValue({ banned: false, muted: false });
    castVote.mockResolvedValue({ status: 'recorded' });
    expect(await submit({ item: queueItem(3), answer: '4' })).toEqual({ success: true });
  });
});

describe('a judgment on an item that settled before it arrived', () => {
  it('asks to count it toward the Daily Watch and says so when it was counted', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    creditLateJudgment.mockResolvedValueOnce(true);

    expect(await submit({ item: queueItem(501), answer: '4' })).toMatchObject({
      status: 409,
      data: { reason: 'not-open', watchCounted: true },
    });
    expect(creditLateJudgment).toHaveBeenCalledWith(expect.anything(), {
      userId: 7,
      itemId: 501,
      answer: '4',
      now: expect.any(Date),
    });
  });

  it('says nothing was counted when the credit is refused or fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    creditLateJudgment.mockResolvedValueOnce(false);
    const refused = (await submit({ item: queueItem(501), answer: '4' })) as { data: object };
    expect(refused.data).not.toHaveProperty('watchCounted');

    creditLateJudgment.mockRejectedValueOnce(new Error('db down'));
    const failed = (await submit({ item: queueItem(502), answer: '4' })) as { data: object };
    expect(failed.data).not.toHaveProperty('watchCounted');
    expect(log).toHaveBeenCalled();
  });

  it('does not ask for a refusal that is not about the item moving on, or for a yes/no question', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });
    await submit({ item: queueItem(503), answer: '4' });
    castYesNoVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    await submit({ item: sealItem('secret', 7, { kind: 'yesno', id: 9 }), answer: 'yes' });
    expect(creditLateJudgment).not.toHaveBeenCalled();
  });
});

describe('press timing on a refused vote (log only)', () => {
  const NOW = Date.parse('2026-12-15T12:00:00Z');
  const refusedRow = () => refusedRowsFull()[0];

  it('logs when the vote was pressed, how long it took to arrive and the live connection then, on not-open', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    await submit({
      item: queueItem(3),
      answer: '4',
      pressedAt: String(NOW - 5_250),
      waitedMs: '4100',
      signals: '10',
    });

    expect(refusedRow()).toMatchObject({
      details: { reason: 'not-open', playerId: 7 },
      payload: {
        kind: 'rating',
        itemId: 3,
        action: 'vote',
        pressedAt: NOW - 5_250,
        pressGapMs: 5_250,
        waitedMs: 4_100,
        signalsConnected: true,
        signalsSubscribed: false,
      },
    });
  });

  it('logs null for each field the body did not carry, on not-open', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    await submit({ item: queueItem(3), answer: '4' });

    expect(refusedRow()?.payload).toEqual({
      kind: 'rating',
      itemId: 3,
      action: 'vote',
      pressedAt: null,
      pressGapMs: null,
      waitedMs: null,
      signalsConnected: null,
      signalsSubscribed: null,
    });
  });

  it('logs any other refusal exactly as before, without the press fields', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'already-voted' });
    await submit({
      item: queueItem(3),
      answer: '4',
      pressedAt: String(NOW - 5_250),
      waitedMs: '4100',
      signals: '11',
    });

    expect(refusedRow()).toMatchObject({
      details: { reason: 'already-voted', playerId: 7 },
      payload: { kind: 'rating', itemId: 3, action: 'vote' },
    });
    expect(refusedRow()?.payload).toEqual({ kind: 'rating', itemId: 3, action: 'vote' });
  });

  it('logs the press fields exactly as the page writes them', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    const body = new FormData();
    const now = { wall: NOW - 9_000, mono: 100 };
    const start = markPress(
      body,
      { connected: true, subscribed: true },
      {
        wall: () => now.wall,
        mono: () => now.mono,
      }
    );
    now.mono += 8_200;
    start();
    await submit({ item: queueItem(3), answer: '4', ...Object.fromEntries(body) } as Record<
      string,
      string
    >);

    expect(refusedRow()?.payload).toMatchObject({
      pressedAt: NOW - 9_000,
      pressGapMs: 9_000,
      waitedMs: 8_200,
      signalsConnected: true,
      signalsSubscribed: true,
    });
  });

  // The press fields come from the client: they are logged and never decide anything.
  it.each([
    ['garbage', { pressedAt: 'soon', waitedMs: 'a while', signals: 'yes' }],
    ['negative', { pressedAt: '-1797336000000', waitedMs: '-5', signals: '-1' }],
    ['far-future', { pressedAt: '9999999999999999', waitedMs: '86400000', signals: '11' }],
    ['huge', { pressedAt: '9'.repeat(400), waitedMs: '9'.repeat(400), signals: '1'.repeat(400) }],
    ['fractional', { pressedAt: '1797336000000.5', waitedMs: '1.5', signals: '1.' }],
  ])(
    'answers and casts a vote with %s press fields exactly as one without them',
    async (_case, extra) => {
      for (const result of [
        { status: 'recorded' },
        { status: 'rejected', reason: 'not-open' },
        { status: 'rejected', reason: 'already-voted' },
        { status: 'limited', until: new Date('2026-12-15T12:00:30Z') },
      ]) {
        castVote.mockReset();
        castVote.mockResolvedValue(result);
        const without = await submit({ item: queueItem(3), answer: '4' });
        const withFields = await submit({ item: queueItem(3), answer: '4', ...extra });
        expect(withFields).toEqual(without);
        expect(castVote.mock.calls[1]).toEqual(castVote.mock.calls[0]);
      }
    }
  );

  it('logs null for a press field it cannot read, instead of refusing the vote', async () => {
    castVote.mockResolvedValue({ status: 'rejected', reason: 'not-open' });
    await submit({
      item: queueItem(3),
      answer: '4',
      pressedAt: '9'.repeat(400),
      waitedMs: '-5',
      signals: 'x',
    });

    expect(refusedRow()?.payload).toMatchObject({
      pressedAt: null,
      pressGapMs: null,
      waitedMs: null,
      signalsConnected: null,
      signalsSubscribed: null,
    });
  });
});
