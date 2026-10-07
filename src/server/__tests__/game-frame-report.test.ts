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

beforeEach(() => {
  vi.clearAllMocks();
  db.report.findFirst.mockResolvedValue(null);
  db.gameFrameReportReceipt.findUnique.mockResolvedValue(null);
  db.gameFrameGame.findUnique.mockResolvedValue(null);
  db.gameFrameGame.upsert.mockResolvedValue({ id: GAME_ID, stateAt: null });
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 404 ? null : { id: where.id, deletedAt: null }
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
