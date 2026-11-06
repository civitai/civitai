import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ModelStatus } from '~/shared/utils/prisma/enums';

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/training-studio/model-status')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const OWNER = { id: 1, username: 'owner' } as SessionUser;
const MODELS: Row[] = [
  { id: 77, userId: 1, status: ModelStatus.Draft, deletedBy: null },
  { id: 78, userId: 1, status: ModelStatus.Deleted, deletedBy: 1 },
  { id: 79, userId: 2, status: ModelStatus.Draft, deletedBy: null },
  { id: 80, userId: 1, status: ModelStatus.Deleted, deletedBy: 999 },
  { id: 81, userId: 1, status: ModelStatus.Deleted, deletedBy: null },
];

type Row = { id: number; userId: number; status: ModelStatus; deletedBy: number | null };
type Clause = { status?: { not: ModelStatus }; deletedBy?: { not: number } | null };
type Where = { id: number; userId?: number; status?: { not: ModelStatus }; OR?: Clause[] };
// SQL's rules, not JS's: `deletedBy <> x` is not true for a NULL deletedBy.
const passes = (r: Row, c: Clause) =>
  c.status
    ? r.status !== c.status.not
    : c.deletedBy === null
    ? r.deletedBy === null
    : r.deletedBy !== null && r.deletedBy !== c.deletedBy?.not;

async function status(id: string) {
  let code = 200;
  let body: unknown;
  const req = { method: 'GET', query: { id } } as unknown as NextApiRequest;
  const res = {
    setHeader: () => res,
    status(c: number) {
      code = c;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, OWNER);
  return { code, body };
}

beforeEach(() => {
  dbMock.dbWrite.model.findFirst.mockImplementation((async ({ where }: { where: Where }) => {
    const row = MODELS.find(
      (m) =>
        m.id === where.id &&
        (where.userId === undefined || m.userId === where.userId) &&
        (!where.status || m.status !== where.status.not) &&
        (!where.OR || where.OR.some((c) => passes(m, c)))
    );
    return row ? { id: row.id } : null;
  }) as never);
});

describe('GET /api/training-studio/model-status', () => {
  it("reports the owner's draft live", async () => {
    expect(await status('77')).toEqual({ code: 200, body: { live: true } });
  });

  it('reports a draft its owner deleted not live', async () => {
    expect(await status('78')).toEqual({ code: 200, body: { live: false } });
  });

  // Publish reopens a moderator-deleted draft rather than make a fresh one; reporting it not live
  // would offer a Publish that lands back on it, forever.
  it.each([
    ['a moderator', '80'],
    ['no recorded actor', '81'],
  ])('reports a draft deleted by %s live, matching Publish', async (_label, id) => {
    expect(await status(id)).toEqual({ code: 200, body: { live: true } });
  });

  it("reports someone else's model not live", async () => {
    expect(await status('79')).toEqual({ code: 200, body: { live: false } });
  });

  it('refuses a malformed id', async () => {
    expect((await status('abc')).code).toBe(400);
  });
});
