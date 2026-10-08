import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { createReportInputSchema } from '~/server/schema/report.schema';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

vi.mock('~/server/services/system-cache', () => ({ getModeratedTags: vi.fn(async () => []) }));

const { gameFrameReportSchema, fileGameFrameReport, applyGameFrameState } = await import(
  '~/server/services/game-frame-report.service'
);
const { gameFrameReportHandler, gameFrameStateHandler } = await import(
  '~/server/game-frame/report-endpoints'
);

const db = dbMock.dbWrite;
const GUEST = 900;
const TOKEN = 'x'.repeat(40);
const GAME_ID = 42;

const body = (over: Record<string, unknown> = {}) => ({
  gfReportId: 'gr_01JA8ZZZZZZZZZZZZZZZZZZZZZ',
  at: '2026-10-06T21:30:00.000Z',
  game: {
    slug: 'kraken-cove',
    title: 'Kraken Cove',
    authorUserId: 12345,
    official: false,
    visibility: 'public',
    url: 'https://games.civitai.com/?game=kraken-cove',
    coverUrl: null,
  },
  reporter: { kind: 'user', userId: 678 },
  gfReason: 'hate',
  reason: 'TOSViolation',
  violation: 'Hate or harassment',
  comment: '',
  ...over,
});
const guest = { kind: 'guest', guestKey: 'a1b2c3d4e5f6' };
const parse = (over: Record<string, unknown> = {}) => gameFrameReportSchema.parse(body(over));
const file = (over: Record<string, unknown> = {}) =>
  fileGameFrameReport(parse(over), { guestUserId: GUEST });

const existingReport = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 1,
  alsoReportedBy: [] as number[],
  previouslyReviewedCount: 0,
  status: ReportStatus.Pending,
  details: {},
  ...over,
});

/** Prisma returns only the selected columns; a mock that ignores `select` hides a dropped field. */
const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

beforeEach(() => {
  vi.clearAllMocks();
  db.report.findFirst.mockResolvedValue(null);
  db.gameFrameReportReceipt.findUnique.mockResolvedValue(null);
  db.gameFrameGame.findUnique.mockResolvedValue(null);
  db.gameFrameGame.upsert.mockResolvedValue({ id: GAME_ID, stateAt: null });
  db.user.findUnique.mockImplementation(
    async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) =>
      where.id === 404 ? null : pick({ id: where.id, deletedAt: null }, select)
  );
  db.report.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 991,
    userId: data.userId,
    alsoReportedBy: [],
    details: data.details,
  }));
  db.report.update.mockImplementation(
    async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({
      ...existingReport({ id: where.id }),
      ...data,
    })
  );
});

describe('B.2 reason mapping', () => {
  const pairs: [string, string, string | undefined, string][] = [
    ['minors', 'TOSViolation', 'Child abuse and exploitation', ''],
    ['adult', 'NSFW', undefined, ''],
    ['real_person', 'TOSViolation', 'Depiction of real-person likeness', 'it is Jane Doe'],
    ['hate', 'TOSViolation', 'Hate or harassment', ''],
    ['violence', 'TOSViolation', 'Graphic violence', ''],
    ['spam', 'Spam', undefined, ''],
    ['other', 'TOSViolation', 'Other', 'something else'],
  ];

  it.each(pairs)('accepts %s as %s / %s', (gfReason, reason, violation, comment) => {
    expect(
      gameFrameReportSchema.safeParse(body({ gfReason, reason, violation, comment })).success
    ).toBe(true);
  });

  // Justin, 2026-10-06: minors reports are TOSViolation "Child abuse and exploitation", never the
  // CSAM reason. If you are here to allow CSAM for minors, that decision has to change first.
  it('refuses minors filed as CSAM', () => {
    const result = gameFrameReportSchema.safeParse(
      body({ gfReason: 'minors', reason: 'CSAM', violation: undefined })
    );
    expect(result.success).toBe(false);
  });

  it('refuses a pair that does not match the table', () => {
    expect(
      gameFrameReportSchema.safeParse(body({ gfReason: 'hate', violation: 'Graphic violence' }))
        .success
    ).toBe(false);
  });

  it.each(['real_person', 'other'])('requires a comment for %s', (gfReason) => {
    const violation = gfReason === 'other' ? 'Other' : 'Depiction of real-person likeness';
    const result = gameFrameReportSchema.safeParse(body({ gfReason, violation, comment: '  ' }));
    expect(result.success).toBe(false);
  });
});

describe('filing a report', () => {
  it('creates a Pending report joined to the mirror row, with its receipt, in one transaction', async () => {
    const result = await file();

    expect(result).toEqual({ ok: true, reportId: 991, result: 'created' });
    const { data } = db.report.create.mock.calls[0][0];
    expect(data.gameFrameGame).toEqual({ create: { gameFrameGameId: GAME_ID } });
    expect(data.userId).toBe(678);
    expect(data.status).toBe(ReportStatus.Pending);
    expect(data.details).toMatchObject({
      gfReportId: 'gr_01JA8ZZZZZZZZZZZZZZZZZZZZZ',
      source: 'game-frame',
      violation: 'Hate or harassment',
      reportType: 'gameFrameGame',
    });
    expect(db.gameFrameReportReceipt.create).toHaveBeenCalledWith({
      data: { gfReportId: 'gr_01JA8ZZZZZZZZZZZZZZZZZZZZZ', reportId: 991 },
    });
    // createReport ran on the caller's transaction rather than opening a second one, which is
    // what keeps the receipt atomic with the report.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns the original report for a resent gfReportId and writes nothing', async () => {
    db.gameFrameReportReceipt.findUnique.mockResolvedValueOnce({ reportId: 555 });

    expect(await file()).toEqual({ ok: true, reportId: 555, result: 'duplicate' });
    expect(db.report.create).not.toHaveBeenCalled();
    expect(db.report.update).not.toHaveBeenCalled();
    expect(db.gameFrameReportReceipt.create).not.toHaveBeenCalled();
    expect(db.gameFrameGame.upsert).not.toHaveBeenCalled();
  });

  it('answers unknown_user for a reporter id with no account, filing nothing', async () => {
    expect(await file({ reporter: { kind: 'user', userId: 404 } })).toEqual({
      ok: false,
      error: 'unknown_user',
    });
    expect(db.report.create).not.toHaveBeenCalled();
    expect(db.gameFrameReportReceipt.create).not.toHaveBeenCalled();
  });

  it('leaves an adult (NSFW) game report Pending for a moderator', async () => {
    await file({ gfReason: 'adult', reason: 'NSFW', violation: undefined });
    expect(db.report.create.mock.calls[0][0].data.status).toBe(ReportStatus.Pending);
  });

  it('folds TOS reports by violation, so minors never lands under a hate report', async () => {
    await file({ gfReason: 'minors', violation: 'Child abuse and exploitation' });

    const where = JSON.stringify(db.report.findFirst.mock.calls[0][0].where);
    expect(where).toContain('"gameFrameGameId":42');
    expect(where).toContain('"path":["violation"],"equals":"Child abuse and exploitation"');
  });

  it('does not re-append a reporter who already filed the report it folds into', async () => {
    db.report.findFirst.mockResolvedValue(existingReport({ userId: 678 }));

    expect(await file()).toEqual({ ok: true, reportId: 7, result: 'merged' });
    expect(db.report.update).not.toHaveBeenCalled();
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('appends a second signed-in reporter to alsoReportedBy', async () => {
    db.report.findFirst.mockResolvedValue(existingReport({ userId: 1 }));

    expect(await file()).toMatchObject({ reportId: 7, result: 'merged' });
    expect(db.report.update.mock.calls[0][0].data.alsoReportedBy).toEqual([678]);
  });
});

describe('guest reports', () => {
  it('files the first one as the guest account and seeds guests[]', async () => {
    await file({ reporter: guest });

    expect(db.report.create.mock.calls[0][0].data.userId).toBe(GUEST);
    const details = db.report.update.mock.calls[0][0].data.details;
    expect(details.guestCount).toBe(1);
    expect(details.guests).toEqual([
      expect.objectContaining({ guestKey: 'a1b2c3d4e5f6', gfReason: 'hate' }),
    ]);
  });

  it('appends a later one to guests[] instead of vanishing into dedupe', async () => {
    db.report.findFirst.mockResolvedValue(
      existingReport({
        userId: GUEST,
        details: { guests: [{ guestKey: 'old' }], guestCount: 1 },
      })
    );

    expect(await file({ reporter: guest })).toMatchObject({ reportId: 7, result: 'merged' });
    expect(db.report.create).not.toHaveBeenCalled();
    expect(db.report.update).toHaveBeenCalledTimes(1);
    const { data } = db.report.update.mock.calls[0][0];
    expect(data.alsoReportedBy).toBeUndefined();
    expect(data.details.guestCount).toBe(2);
    expect(data.details.guests.map((g: { guestKey: string }) => g.guestKey)).toEqual([
      'old',
      'a1b2c3d4e5f6',
    ]);
  });

  it('keeps the newest 50 entries while counting every one', async () => {
    const guests = Array.from({ length: 50 }, (_, i) => ({ guestKey: `g${i}` }));
    db.report.findFirst.mockResolvedValue(
      existingReport({ alsoReportedBy: [GUEST], details: { guests, guestCount: 80 } })
    );

    await file({ reporter: guest });
    const { details } = db.report.update.mock.calls[0][0].data;
    expect(details.guests).toHaveLength(50);
    expect(details.guests[0].guestKey).toBe('g1');
    expect(details.guestCount).toBe(81);
  });
});

describe('mirror freshness', () => {
  it('does not let a late report overwrite a newer state push', async () => {
    db.gameFrameGame.upsert.mockResolvedValue({ id: GAME_ID, stateAt: new Date('2026-10-07') });
    await file();
    expect(db.gameFrameGame.update).not.toHaveBeenCalled();
  });

  it('applies a newer state push and ignores an older one', async () => {
    const state = {
      ...body().game,
      visibility: 'delisted' as const,
      at: '2026-10-08T00:00:00.000Z',
    };
    db.gameFrameGame.findUnique.mockResolvedValue({ id: GAME_ID, stateAt: new Date('2026-10-07') });
    expect(await applyGameFrameState(state)).toEqual({ gameId: GAME_ID });
    expect(db.gameFrameGame.update.mock.calls[0][0].data.visibility).toBe('delisted');

    db.gameFrameGame.update.mockClear();
    expect(await applyGameFrameState({ ...state, at: '2026-10-06T00:00:00.000Z' })).toEqual({
      gameId: GAME_ID,
    });
    expect(db.gameFrameGame.update).not.toHaveBeenCalled();
  });

  it('never creates a row from a state push', async () => {
    db.gameFrameGame.findUnique.mockResolvedValue(null);
    expect(await applyGameFrameState({ ...body().game, at: body().at } as never)).toBeNull();
    expect(db.gameFrameGame.upsert).not.toHaveBeenCalled();
    expect(db.gameFrameGame.create).not.toHaveBeenCalled();
  });
});

describe('the public report route', () => {
  it('refuses a game report, so only Game Frame can file one', () => {
    const input = {
      type: ReportEntity.GameFrameGame,
      id: GAME_ID,
      reason: ReportReason.Spam,
      details: {},
    };
    expect(createReportInputSchema.safeParse(input).success).toBe(false);
    expect(createReportInputSchema.safeParse({ ...input, type: ReportEntity.Model }).success).toBe(
      true
    );
  });
});

function call(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  req: Partial<NextApiRequest>
) {
  const out: { status?: number; json?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      out.json = value;
      return res;
    },
  } as unknown as NextApiResponse;
  return handler({ method: 'POST', headers: {}, query: {}, ...req } as NextApiRequest, res).then(
    () => out
  );
}

describe('POST /api/internal/game-frame/reports', () => {
  const authed = { authorization: `Bearer ${TOKEN}` };
  beforeEach(() => setEnv({ GF_REPORT_TOKEN: TOKEN, GAMES_GUEST_USER_ID: GUEST }));

  it('files with the right token', async () => {
    expect(await call(gameFrameReportHandler, { headers: authed, body: body() })).toEqual({
      status: 200,
      json: { reportId: 991, result: 'created' },
    });
  });

  it.each([
    ['no token', {}],
    ['a wrong token of the same length', { authorization: `Bearer ${'y'.repeat(40)}` }],
    ['a wrong token of another length', { authorization: 'Bearer short' }],
  ])('refuses %s with 401 and files nothing', async (_, headers) => {
    expect((await call(gameFrameReportHandler, { headers, body: body() })).status).toBe(401);
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('answers 503, never 200, while unconfigured', async () => {
    setEnv({ GF_REPORT_TOKEN: '', GAMES_GUEST_USER_ID: GUEST });
    expect((await call(gameFrameReportHandler, { headers: authed, body: body() })).status).toBe(
      503
    );
    setEnv({ GF_REPORT_TOKEN: TOKEN, GAMES_GUEST_USER_ID: '' });
    expect((await call(gameFrameReportHandler, { headers: authed, body: body() })).status).toBe(
      503
    );
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('answers 400 for an invalid body and for a mismatched Idempotency-Key', async () => {
    expect(
      (await call(gameFrameReportHandler, { headers: authed, body: body({ gfReason: 'nope' }) }))
        .status
    ).toBe(400);
    expect(
      (
        await call(gameFrameReportHandler, {
          headers: { ...authed, 'idempotency-key': 'gr_other' },
          body: body(),
        })
      ).status
    ).toBe(400);
  });

  it('answers 422 unknown_user', async () => {
    expect(
      await call(gameFrameReportHandler, {
        headers: authed,
        body: body({ reporter: { kind: 'user', userId: 404 } }),
      })
    ).toEqual({ status: 422, json: { error: 'unknown_user' } });
  });
});

describe('PUT /api/internal/game-frame/reports/games/[slug]', () => {
  const authed = { authorization: `Bearer ${TOKEN}` };
  const state = { ...body().game, at: body().at };
  beforeEach(() => setEnv({ GF_REPORT_TOKEN: TOKEN, GAMES_GUEST_USER_ID: GUEST }));

  it('answers 404 unknown_game for a game with no mirror row', async () => {
    db.gameFrameGame.findUnique.mockResolvedValue(null);
    expect(
      await call(gameFrameStateHandler, {
        method: 'PUT',
        headers: authed,
        query: { slug: 'kraken-cove' },
        body: state,
      })
    ).toEqual({ status: 404, json: { error: 'unknown_game' } });
  });

  it('refuses a body whose slug differs from the path', async () => {
    expect(
      (
        await call(gameFrameStateHandler, {
          method: 'PUT',
          headers: authed,
          query: { slug: 'other-game' },
          body: state,
        })
      ).status
    ).toBe(400);
  });

  it('refuses without the token', async () => {
    expect(
      (
        await call(gameFrameStateHandler, {
          method: 'PUT',
          query: { slug: 'kraken-cove' },
          body: state,
        })
      ).status
    ).toBe(401);
  });
});

/**
 * The shared dbMock hands `$transaction` callbacks `dbWrite` itself, so a write that escaped the
 * transaction would look identical to one inside it. These run on a distinct transaction client.
 */
describe('everything happens on the one transaction', () => {
  const makeTx = () => ({
    $executeRaw: vi.fn(async () => 0),
    $executeRawUnsafe: vi.fn(async () => 0),
    report: {
      findFirst: vi.fn(async () => null as unknown),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 991,
        userId: data.userId,
        alsoReportedBy: [],
        details: data.details,
      })),
      update: vi.fn(
        async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => ({
          ...existingReport({ id: where.id }),
          ...data,
        })
      ),
    },
    user: {
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) =>
          pick({ id: where.id, deletedAt: null }, select)
      ),
    },
    gameFrameGame: {
      upsert: vi.fn(async () => ({ id: GAME_ID, stateAt: null })),
      update: vi.fn(async () => ({})),
    },
    gameFrameReportReceipt: {
      findUnique: vi.fn(async () => null as unknown),
      create: vi.fn(async () => ({})),
    },
  });
  let tx: ReturnType<typeof makeTx>;
  beforeEach(() => {
    tx = makeTx();
    db.$transaction.mockImplementationOnce(async (cb: (client: unknown) => unknown) => cb(tx));
  });

  const noWritesOutsideTx = () => {
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.user.findUnique, 'dbWrite.user.findUnique').not.toHaveBeenCalled();
    for (const model of ['report', 'gameFrameGame', 'gameFrameReportReceipt'] as const)
      for (const method of ['create', 'update', 'upsert', 'findFirst', 'findUnique'])
        expect(db[model][method], `dbWrite.${model}.${method}`).not.toHaveBeenCalled();
  };

  it('creates the report, the mirror and the receipt on the transaction client', async () => {
    expect(await file()).toEqual({ ok: true, reportId: 991, result: 'created' });

    expect(tx.report.create).toHaveBeenCalledTimes(1);
    expect(tx.gameFrameGame.upsert).toHaveBeenCalledTimes(1);
    expect(tx.gameFrameReportReceipt.create).toHaveBeenCalledWith({
      data: { gfReportId: 'gr_01JA8ZZZZZZZZZZZZZZZZZZZZZ', reportId: 991 },
    });
    noWritesOutsideTx();
  });

  it('folds into an existing report on the transaction client', async () => {
    tx.report.findFirst.mockResolvedValue(existingReport({ userId: 1 }));

    expect(await file()).toMatchObject({ reportId: 7, result: 'merged' });
    // Both dedupe reads, ours and the one inside createReport, go through tx.
    expect(tx.report.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.report.update.mock.calls[0][0].data.alsoReportedBy).toEqual([678]);
    expect(tx.gameFrameReportReceipt.create).toHaveBeenCalledTimes(1);
    noWritesOutsideTx();
  });

  it('appends a guest on the transaction client', async () => {
    tx.report.findFirst.mockResolvedValue(existingReport({ userId: GUEST }));

    await file({ reporter: guest });
    expect(tx.report.update).toHaveBeenCalledTimes(1);
    noWritesOutsideTx();
  });

  it('fails as a whole when the receipt cannot be written', async () => {
    tx.gameFrameReportReceipt.create.mockRejectedValue(new Error('receipt write failed'));
    await expect(file()).rejects.toThrow('receipt write failed');
  });

  it('takes the report lock, then the game lock, each under a lock timeout', async () => {
    await file();

    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '3s'`);
    // The timeout must be in force before the first wait.
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0]
    );
    const locks = tx.$executeRaw.mock.calls.map((call) => {
      const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
      return { sql: strings.join('?'), values };
    });
    expect(locks).toEqual([
      {
        sql: 'SELECT pg_advisory_xact_lock(?::int, hashtext(?))',
        values: [0x47460001, body().gfReportId],
      },
      {
        sql: 'SELECT pg_advisory_xact_lock(?::int, hashtext(?))',
        values: [0x47460002, 'kraken-cove'],
      },
    ]);
  });

  it('answers a resend under the report lock alone, before touching the game', async () => {
    tx.gameFrameReportReceipt.findUnique.mockResolvedValue({ reportId: 555 });

    expect(await file()).toMatchObject({ result: 'duplicate', reportId: 555 });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.gameFrameGame.upsert).not.toHaveBeenCalled();
  });
});

describe('payload validation', () => {
  it.each(['javascript:alert(1)', 'http://games.civitai.com/?game=x', 'data:text/html,hi'])(
    'refuses a non-https game url or cover (%s)',
    (url) => {
      const game = { ...body().game, url };
      expect(gameFrameReportSchema.safeParse(body({ game })).success).toBe(false);
      const cover = { ...body().game, coverUrl: url };
      expect(gameFrameReportSchema.safeParse(body({ game: cover })).success).toBe(false);
    }
  );

  it('names the pair rule when the reason does not match', () => {
    const result = gameFrameReportSchema.safeParse(
      body({ gfReason: 'minors', reason: 'CSAM', violation: 'Child abuse and exploitation' })
    );
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['reason']);
    expect(result.error?.issues[0].message).toContain(
      'minors must be TOSViolation / Child abuse and exploitation'
    );
  });

  it('names the comment rule when a required comment is blank', () => {
    const result = gameFrameReportSchema.safeParse(
      body({ gfReason: 'other', violation: 'Other', comment: ' ' })
    );
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['comment']);
  });
});

describe('filing edge cases', () => {
  it('files a report whose author id names no account, with no owner on the mirror', async () => {
    await file({ game: { ...body().game, authorUserId: 404 } });

    expect(db.gameFrameGame.upsert.mock.calls[0][0].create.userId).toBeNull();
    expect(db.report.create).toHaveBeenCalledTimes(1);
  });

  it('refreshes the mirror from a report at least as new as its last state', async () => {
    db.gameFrameGame.upsert.mockResolvedValue({ id: GAME_ID, stateAt: new Date(body().at) });

    await file({ game: { ...body().game, title: 'Renamed', visibility: 'delisted' } });

    expect(db.gameFrameGame.update).toHaveBeenCalledWith({
      where: { id: GAME_ID },
      data: expect.objectContaining({
        title: 'Renamed',
        visibility: 'delisted',
        stateAt: new Date(body().at),
      }),
    });
  });

  it('refuses a deleted reporter as unknown_user', async () => {
    db.user.findUnique.mockImplementation(
      async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) =>
        pick({ id: where.id, deletedAt: where.id === 678 ? new Date() : null }, select)
    );
    expect(await file()).toEqual({ ok: false, error: 'unknown_user' });
    expect(db.report.create).not.toHaveBeenCalled();
  });

  // Contract B.1 upserts the mirror before resolving the reporter, so Game Frame's retry of an
  // unknown_user report as a guest finds the row already there.
  it('keeps the mirror upsert for a report refused as unknown_user', async () => {
    await file({ reporter: { kind: 'user', userId: 404 } });
    expect(db.gameFrameGame.upsert).toHaveBeenCalledTimes(1);
  });

  it('adds a guest to a report a signed-in user filed, exactly once', async () => {
    db.report.findFirst.mockResolvedValue(existingReport({ userId: 1 }));

    expect(await file({ reporter: guest })).toMatchObject({ reportId: 7, result: 'merged' });
    const [fold, append] = db.report.update.mock.calls.map((c) => c[0].data);
    expect(fold.alsoReportedBy).toEqual([GUEST]);
    expect(append.alsoReportedBy).toBeUndefined();
    expect(append.details.guestCount).toBe(1);
  });

  it('reports the first guest report as created', async () => {
    expect(await file({ reporter: guest })).toMatchObject({ result: 'created' });
  });

  it('leaves a reviewed report untouched when its own filer reports again', async () => {
    db.report.findFirst.mockResolvedValue(
      existingReport({ userId: 678, status: ReportStatus.Actioned })
    );

    expect(await file()).toMatchObject({ reportId: 7, result: 'merged' });
    expect(db.report.update).not.toHaveBeenCalled();
  });

  it.each([
    ['adult', 'NSFW'],
    ['spam', 'Spam'],
  ])('folds %s reports on reason alone, with no violation predicate', async (gfReason, reason) => {
    await file({ gfReason, reason, violation: undefined });

    expect(db.report.findFirst).toHaveBeenCalled();
    for (const [{ where }] of db.report.findFirst.mock.calls)
      expect(where).not.toHaveProperty('details');
  });

  it('puts the violation predicate on both dedupe reads', async () => {
    await file();

    expect(db.report.findFirst).toHaveBeenCalledTimes(2);
    for (const [{ where }] of db.report.findFirst.mock.calls)
      expect(where.details).toEqual({ path: ['violation'], equals: 'Hate or harassment' });
  });
});

describe('endpoint edges', () => {
  const authed = { authorization: `Bearer ${TOKEN}` };
  beforeEach(() => setEnv({ GF_REPORT_TOKEN: TOKEN, GAMES_GUEST_USER_ID: GUEST }));

  it('treats a token shorter than 32 characters as unconfigured, even when it matches', async () => {
    setEnv({ GF_REPORT_TOKEN: 'short', GAMES_GUEST_USER_ID: GUEST });
    const res = await call(gameFrameReportHandler, {
      headers: { authorization: 'Bearer short' },
      body: body(),
    });
    expect(res.status).toBe(503);
  });

  it('accepts a matching Idempotency-Key and a lower-case bearer scheme', async () => {
    const res = await call(gameFrameReportHandler, {
      headers: { authorization: `bearer ${TOKEN}`, 'idempotency-key': body().gfReportId },
      body: body(),
    });
    expect(res.status).toBe(200);
  });

  it('answers 405 to the wrong method on both routes', async () => {
    expect((await call(gameFrameReportHandler, { method: 'GET', headers: authed })).status).toBe(
      405
    );
    expect((await call(gameFrameStateHandler, { method: 'POST', headers: authed })).status).toBe(
      405
    );
  });

  it('answers 500, not 200, when filing throws', async () => {
    db.gameFrameGame.upsert.mockRejectedValue(new Error('db down'));
    expect(await call(gameFrameReportHandler, { headers: authed, body: body() })).toEqual({
      status: 500,
      json: { error: 'internal' },
    });
  });

  it('applies a state push to an existing mirror row', async () => {
    db.gameFrameGame.findUnique.mockResolvedValue({ id: GAME_ID, stateAt: null });
    expect(
      await call(gameFrameStateHandler, {
        method: 'PUT',
        headers: authed,
        query: { slug: 'kraken-cove' },
        body: { ...body().game, visibility: 'delisted', at: body().at },
      })
    ).toEqual({ status: 200, json: { gameId: GAME_ID } });
    expect(db.gameFrameGame.update.mock.calls[0][0].data.visibility).toBe('delisted');
  });
});

describe('reporters the site would refuse', () => {
  it("accepts Game Frame's guest retry key for an unknown_user report", async () => {
    const retry = { kind: 'guest', guestKey: 'u3f2a1b0c9d8' };
    expect(gameFrameReportSchema.safeParse(body({ reporter: retry })).success).toBe(true);
    expect(await file({ reporter: retry })).toMatchObject({ ok: true, result: 'created' });
    expect(db.report.create.mock.calls[0][0].data.userId).toBe(GUEST);
  });

  it.each(['u3f2a1b0c9d', 'U3f2a1b0c9d8', 'x3f2a1b0c9d8'])(
    'refuses a malformed guest key %s',
    (k) => {
      expect(
        gameFrameReportSchema.safeParse(body({ reporter: { kind: 'guest', guestKey: k } })).success
      ).toBe(false);
    }
  );

  it.each([
    ['banned', { bannedAt: new Date() }],
    ['muted', { muted: true }],
  ])('sends a %s reporter back as unknown_user, filing nothing', async (_, flags) => {
    db.user.findUnique.mockImplementation(
      async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) =>
        pick({ id: where.id, deletedAt: null, ...(where.id === 678 ? flags : {}) }, select)
    );
    expect(await file()).toEqual({ ok: false, error: 'unknown_user' });
    expect(db.report.create).not.toHaveBeenCalled();
  });
});

describe('state pushes', () => {
  it('runs on the transaction under the game lock, and drops an unknown author', async () => {
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: vi.fn(async () => 0),
      user: { findUnique: vi.fn(async () => null) },
      gameFrameGame: {
        findUnique: vi.fn(async () => ({ id: GAME_ID, stateAt: null })),
        update: vi.fn(async () => ({})),
      },
    };
    db.$transaction.mockImplementationOnce(async (cb: (client: unknown) => unknown) => cb(tx));

    await applyGameFrameState({ ...body().game, authorUserId: 404, at: body().at } as never);

    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    expect(strings.join('?')).toBe('SELECT pg_advisory_xact_lock(?::int, hashtext(?))');
    expect(values).toEqual([0x47460002, 'kraken-cove']);
    expect(tx.gameFrameGame.update.mock.calls[0][0].data.userId).toBeNull();
    expect(db.gameFrameGame.findUnique).not.toHaveBeenCalled();
    expect(db.gameFrameGame.update).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('the columns each guard reads are selected', () => {
  it('selects stateAt wherever it compares against it, and the receipt reportId', async () => {
    await file();
    db.gameFrameGame.findUnique.mockResolvedValue({ id: GAME_ID, stateAt: null });
    await applyGameFrameState({ ...body().game, at: body().at } as never);

    expect(db.gameFrameGame.upsert.mock.calls[0][0].select).toMatchObject({
      id: true,
      stateAt: true,
    });
    expect(db.gameFrameGame.findUnique.mock.calls[0][0].select).toMatchObject({
      id: true,
      stateAt: true,
    });
    expect(db.gameFrameReportReceipt.findUnique.mock.calls[0][0].select).toMatchObject({
      reportId: true,
    });
  });
});
