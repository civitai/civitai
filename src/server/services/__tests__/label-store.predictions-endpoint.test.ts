import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { bootLabelStore } from './label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The prediction endpoint end to end: the route, its service and the store migration on an
 * in-process Postgres. Only the credential, the grant lookup, the rate-limit counter and the audit
 * sink are stand-ins.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const { bearerSession, audit } = vi.hoisted(() => ({ bearerSession: vi.fn(), audit: vi.fn() }));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: bearerSession }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = audit;
  },
}));
// The grant row as `/admin` writes it: which roles hold which grant id.
const GRANTS: Record<string, string[]> = { 'labelStore.submitPrediction': ['moderator:pipeline'] };
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: vi.fn(async (user: { roles?: string[] }, id: string) =>
    (GRANTS[id] ?? []).some((role) => user.roles?.includes(role))
  ),
}));

type Raw = ReturnType<typeof pgliteRaw>;
// Prisma returns an int8 column as a BigInt, where PGlite returns a number.
dbMock.dbWrite.$queryRaw.mockImplementation((async (...a: Parameters<Raw['queryRaw']>) => {
  const rows = (await pgliteRaw(holder.db).queryRaw(...a)) as Record<string, unknown>[];
  return rows.map((r) => (typeof r.id === 'number' ? { ...r, id: BigInt(r.id) } : r));
}) as never);

const { default: handler } = await import('~/pages/api/mod/label-store/predictions');

const IMAGE = 501;
const OWNER = 11;
const HASH = createHash('sha256').update('u-501', 'utf8').digest('hex');

const PIPELINE = {
  id: 3001,
  isModerator: true,
  bannedAt: null,
  permissions: [],
  roles: ['moderator:pipeline'],
};
const fullKey = (user: object) => ({
  user,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 9 },
  tokenScope: TokenScope.Full,
});

const counter = { value: 1 };

beforeAll(async () => {
  holder.db = await PGlite.create();
  await bootLabelStore(holder.db);
});

afterAll(async () => {
  await holder.db.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  counter.value = 1;
  redisMock.sysRedis.multi.mockImplementation(() => {
    const chain = {
      set: vi.fn(() => chain),
      incr: vi.fn(() => chain),
      exec: vi.fn(async () => ['OK', counter.value]),
    };
    return chain;
  });
  redisMock.sysRedis.ttl.mockResolvedValue(30);
  bearerSession.mockResolvedValue(fullKey(PIPELINE));
  await holder.db.exec(`
    TRUNCATE label_store.subject, label_store.change, label_store.record_failure,
      label_store.erased_subject, label_store.erased_owner RESTART IDENTITY CASCADE;
    TRUNCATE "Image" RESTART IDENTITY CASCADE;
  `);
  await holder.db.query(`INSERT INTO "Image" ("id", "userId", "url") VALUES ($1, $2, 'u-501')`, [
    IMAGE,
    OWNER,
  ]);
});

const prediction = (over: Record<string, unknown> = {}) => ({
  subjectType: 'image',
  subjectId: IMAGE,
  contentHash: HASH,
  question: 'image.block',
  value: 'block',
  modelRef: 'scanner@2',
  sourceRef: 'run-1:501',
  confidence: 0.9,
  scores: { a: 0.9, b: 0.1 },
  ...over,
});

async function call(body: unknown, { method = 'POST' } = {}) {
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  const req = { method, headers: { authorization: 'Bearer k' }, body, query: {} };
  await handler(req as never, res as never);
  return { status, payload: payload as Record<string, unknown> };
}

const stored = async () =>
  (
    await holder.db.query<{ sourceRef: string; value: string; family: string }>(
      `SELECT "sourceRef", "value", "family" FROM label_store.prediction ORDER BY "id"`
    )
  ).rows;

describe('who may submit', () => {
  it('records for a moderator holding the grant', async () => {
    const { status, payload } = await call({ predictions: [prediction()] });

    expect(status).toBe(200);
    expect(payload).toEqual({
      results: [{ sourceRef: 'run-1:501', status: 'recorded', id: 1 }],
    });
    expect(await stored()).toEqual([
      { sourceRef: 'pipeline:run-1:501', value: 'block', family: 'pipeline' },
    ]);
  });

  it('refuses a moderator without the grant', async () => {
    bearerSession.mockResolvedValue(fullKey({ ...PIPELINE, roles: [] }));

    const { status, payload } = await call({ predictions: [prediction()] });

    expect(status).toBe(403);
    expect(JSON.stringify(payload)).toContain('labelStore.submitPrediction');
    expect(await stored()).toEqual([]);
  });

  it('refuses a grant holder who is not a moderator', async () => {
    bearerSession.mockResolvedValue(fullKey({ ...PIPELINE, isModerator: false }));

    expect((await call({ predictions: [prediction()] })).status).toBe(403);
    expect(await stored()).toEqual([]);
  });

  it('refuses a banned grant holder', async () => {
    bearerSession.mockResolvedValue(fullKey({ ...PIPELINE, bannedAt: new Date() }));

    expect((await call({ predictions: [prediction()] })).status).toBe(403);
    expect(await stored()).toEqual([]);
  });

  it('refuses a grant holder presenting a key that is not full scope', async () => {
    bearerSession.mockResolvedValue({ ...fullKey(PIPELINE), tokenScope: TokenScope.Full - 1 });

    expect((await call({ predictions: [prediction()] })).status).toBe(403);
    expect(await stored()).toEqual([]);
  });

  it('refuses an unknown key', async () => {
    bearerSession.mockResolvedValue(null);

    expect((await call({ predictions: [prediction()] })).status).toBe(401);
  });

  it('refuses a GET', async () => {
    expect((await call(undefined, { method: 'GET' })).status).toBe(405);
  });

  it('refuses past the rate limit', async () => {
    counter.value = 61;

    expect((await call({ predictions: [prediction()] })).status).toBe(429);
    expect(await stored()).toEqual([]);
  });
});

describe('what it accepts', () => {
  it('refuses a malformed prediction, naming the field, and records none of the batch', async () => {
    const { status, payload } = await call({
      predictions: [prediction({ sourceRef: 'ok-1' }), prediction({ contentHash: 'not-a-hash' })],
    });

    expect(status).toBe(400);
    expect(payload.issues).toEqual([
      expect.objectContaining({ path: ['predictions', 1, 'contentHash'] }),
    ]);
    expect(await stored()).toEqual([]);
  });

  it.each([
    ['an unknown field', { confidnce: 0.5 }],
    ['a subject type other than image', { subjectType: 'text' }],
    ['a zero subject id', { subjectId: 0 }],
    ['a subject id past int4', { subjectId: 2_147_483_648 }],
    ['a blank value', { value: '   ' }],
    ['an uppercase hash', { contentHash: HASH.toUpperCase() }],
    ['a 63-character hash', { contentHash: HASH.slice(1) }],
    ['a 65-character hash', { contentHash: HASH + 'a' }],
    ['a question with capitals', { question: 'Image.Block' }],
    ['a question with no namespace', { question: 'block' }],
    ['question version 0', { questionVersion: 0 }],
    ['question version 1001', { questionVersion: 1001 }],
    ['a 201-character sourceRef', { sourceRef: 'r'.repeat(201) }],
    ['a confidence above 1', { confidence: 5 }],
    [
      '65 scores',
      { scores: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, 0])) },
    ],
    ['versions over 1KB', { versions: { v: 'x'.repeat(1100) } }],
    ['detail over 2KB', { detail: { v: 'x'.repeat(2100) } }],
  ])('refuses %s', async (_, over) => {
    const { status } = await call({ predictions: [prediction(over)] });

    expect(status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it('refuses an empty batch', async () => {
    expect((await call({ predictions: [] })).status).toBe(400);
  });

  it('stores every field it is given, and a later question version stays apart', async () => {
    for (const ref of ['h-1', 'h-2', 'h-3'])
      await holder.db.query(
        `SELECT label_store.record_label('image', '${IMAGE}', $1, 'test', 'image.block', 'block',
           'moderator', $2, now(), p_labeller_ref => $2)`,
        [HASH, ref]
      );
    const { payload } = await call({
      predictions: [
        prediction({
          questionVersion: 2,
          predictedAt: '2026-02-03T04:05:06Z',
          confidence: 0.25,
          scores: { a: 0.25 },
          versions: { v: 3 },
          inputHash: 'in-9',
          detail: { k: 'x' },
        }),
      ],
    });

    expect(payload.results).toEqual([{ sourceRef: 'run-1:501', status: 'recorded', id: 1 }]);
    expect(
      (
        await holder.db.query(
          `SELECT "question", "questionVersion", "value", "modelRef", "predictedAt", "confidence",
             "scores", "versions", "inputHash", "detail" FROM label_store.prediction`
        )
      ).rows
    ).toEqual([
      {
        question: 'image.block',
        questionVersion: 2,
        value: 'block',
        modelRef: 'scanner@2',
        predictedAt: new Date('2026-02-03T04:05:06Z'),
        confidence: 0.25,
        scores: { a: 0.25 },
        versions: { v: 3 },
        inputHash: 'in-9',
        detail: { k: 'x' },
      },
    ]);
    expect(
      (
        await holder.db.query(
          `SELECT "questionVersion", "modelValue" FROM label_store.consensus ORDER BY "questionVersion"`
        )
      ).rows
    ).toEqual([{ questionVersion: 1, modelValue: null }]);
  });

  it('a ten-digit image id keeps its owner, so the owner can be erased', async () => {
    await holder.db.query(
      `INSERT INTO "Image" ("id", "userId", "url") VALUES (1234567890, $1, 'u-big')`,
      [OWNER]
    );
    await call({ predictions: [prediction({ subjectId: 1_234_567_890 })] });

    expect((await holder.db.query(`SELECT label_store.erase_owner(${OWNER}) AS n`)).rows).toEqual([
      { n: 1 },
    ]);
  });

  it(`takes 500 predictions in one call and refuses 501`, async () => {
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => prediction({ sourceRef: `run-2:${i}` }));

    expect((await call({ predictions: batch(501) })).status).toBe(400);
    expect(await stored()).toHaveLength(0);

    const { status, payload } = await call({ predictions: batch(500) });
    expect(status).toBe(200);
    // Across the service's statement chunks, results stay in input order.
    expect((payload.results as { sourceRef: string }[]).map((r) => r.sourceRef)).toEqual(
      batch(500).map((p) => p.sourceRef)
    );
    expect(await stored()).toHaveLength(500);
    // 50 per statement keeps each under the 64 subtransactions a snapshot can track.
    const statements = (dbMock.dbWrite.$queryRaw.mock.calls as unknown[][]).map((args) => args[1]);
    expect(statements.map((json) => JSON.parse(json as string).length)).toEqual(Array(10).fill(50));
  });

  it('a re-submission is a duplicate, not a second row', async () => {
    await call({ predictions: [prediction()] });
    const { status, payload } = await call({
      predictions: [prediction(), prediction({ sourceRef: 'run-1:other' })],
    });

    expect(status).toBe(200);
    expect(payload.results).toEqual([
      { sourceRef: 'run-1:501', status: 'duplicate' },
      { sourceRef: 'run-1:other', status: 'recorded', id: expect.any(Number) },
    ]);
    expect(await stored()).toHaveLength(2);
  });

  it('one sourceRef can answer several images and questions', async () => {
    await holder.db.query(`INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-502')`);
    const { payload } = await call({
      predictions: [
        prediction({ sourceRef: 'run-4' }),
        prediction({ sourceRef: 'run-4', question: 'image.rating', value: 'pg' }),
        prediction({ sourceRef: 'run-4', subjectId: 502 }),
      ],
    });

    expect((payload.results as { status: string }[]).map((r) => r.status)).toEqual([
      'recorded',
      'recorded',
      'recorded',
    ]);
    expect(await stored()).toHaveLength(3);
  });

  it('rejects a prediction for an erased image and records the rest of the batch', async () => {
    await holder.db.query(`SELECT label_store.exclude('image', '777', 'erasure')`);

    const { status, payload } = await call({
      predictions: [prediction({ subjectId: 777, sourceRef: 'run-3:777' }), prediction()],
    });

    expect(status).toBe(200);
    expect(payload.results).toEqual([
      { sourceRef: 'run-3:777', status: 'rejected', error: expect.stringContaining('erased') },
      { sourceRef: 'run-1:501', status: 'recorded', id: 1 },
    ]);
    expect(await stored()).toEqual([expect.objectContaining({ sourceRef: 'pipeline:run-1:501' })]);
  });

  it('keeps the batch out of the audit row and counts it instead', async () => {
    await call({ predictions: [prediction()] });
    await call({ predictions: [prediction(), prediction({ sourceRef: 'run-1:b' })] });

    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'labelStore.submitPredictions',
        outcome: 'ok',
        payload: {},
        affected: { predictions: 2, recorded: 1 },
      })
    );
  });
});
