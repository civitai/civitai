import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as UsernamePermitted from '~/server/services/username-permitted';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingComplete } from '~/server/common/enums';

// WEBHOOK_TOKEN comes from the worker-level env mock (src/__tests__/setup.ts).
const TOKEN = 'test-webhook-token';

const { trackModActivity, isUsernamePermitted } = vi.hoisted(() => ({
  trackModActivity: vi.fn(async () => undefined),
  isUsernamePermitted: vi.fn(async () => true),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/services/username-permitted', async (importOriginal) => ({
  ...(await importOriginal<typeof UsernamePermitted>()),
  isUsernamePermitted,
}));

const handler = (await import('~/pages/api/admin/create-system-account')).default;

type Row = {
  id: number;
  email: string | null;
  username: string | null;
  deletedAt: Date | null;
  [key: string]: unknown;
};
let users: Row[] = [];

// citext columns: email and username are unique case-insensitively.
const same = (a: string | null, b: string | undefined) =>
  a != null && b != null && a.toLowerCase() === b.toLowerCase();

function installUserTable() {
  dbMock.dbWrite.user.findUnique.mockImplementation(
    async ({ where }: { where: { email?: string; username?: string } }) =>
      users.find((u) =>
        where.email !== undefined ? same(u.email, where.email) : same(u.username, where.username)
      ) ?? null
  );
  dbMock.dbWrite.user.create.mockImplementation(async ({ data }: { data: Row }) => {
    if (users.some((u) => same(u.email, data.email!) || same(u.username, data.username!)))
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    const row = { deletedAt: null, ...data, id: 1000 + users.length };
    users.push(row);
    return { id: row.id };
  });
}

function call(body: Record<string, unknown>, { token = TOKEN, method = 'POST' } = {}) {
  const req = { method, query: { token }, body, headers: {} } as unknown as NextApiRequest;
  let statusCode = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return (handler(req, res as unknown as NextApiResponse) as Promise<void>).then(() => ({
    status: statusCode,
    body: payload,
  }));
}

const valid = { email: 'disputes@civitai.com', username: 'CivDisputes' };
const systemRow: Row = {
  id: 0,
  email: 'disputes@civitai.com',
  username: 'CivDisputes',
  deletedAt: null,
  meta: { systemAccount: true },
};

beforeEach(() => {
  users = [];
  installUserTable();
  trackModActivity.mockClear();
  isUsernamePermitted.mockClear();
  isUsernamePermitted.mockImplementation(async () => true);
});

describe('POST /api/admin/create-system-account', () => {
  it('refuses a caller without the admin token, and admits the same request with it', async () => {
    const refused = await call(valid, { token: 'wrong' });
    expect(refused.status).toBe(401);
    expect(users).toHaveLength(0);

    const admitted = await call(valid);
    expect(admitted.status).toBe(201);
    expect(users).toHaveLength(1);
  });

  it('creates a verified, onboarded system account and audits who created it', async () => {
    const { status, body } = await call({ ...valid, actorUserId: 42 });

    expect(status).toBe(201);
    expect(body).toMatchObject({ username: 'CivDisputes', created: true, auditRecorded: true });
    expect(users[0]).toMatchObject({
      id: body.userId,
      email: 'disputes@civitai.com',
      username: 'CivDisputes',
      emailVerified: expect.any(Date),
      excludeFromLeaderboards: true,
      rewardsEligibility: 'Ineligible',
      meta: { systemAccount: true },
    });
    expect(users[0].onboarding).toBe(OnboardingComplete);
    expect(trackModActivity).toHaveBeenCalledWith(42, {
      entityType: 'user',
      activity: 'createSystemAccount',
      entityId: body.userId,
    });
  });

  it('returns the existing account on a repeat call instead of creating a second one', async () => {
    const first = await call(valid);
    const second = await call({ email: 'Disputes@Civitai.com', username: 'civdisputes' });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      userId: first.body.userId,
      username: 'CivDisputes',
      created: false,
    });
    expect(users).toHaveLength(1);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('refuses an email that belongs to an account with a different username', async () => {
    users.push({ id: 7, email: 'disputes@civitai.com', username: 'someone', deletedAt: null });

    const { status } = await call(valid);

    expect(status).toBe(409);
    expect(users).toHaveLength(1);
  });

  // Same email and username, but not created here: answering 200 would hand its id to the caller
  // as if it were a system account.
  it('refuses an ordinary account that matches on email and username', async () => {
    users.push({ ...systemRow, id: 7, meta: {} });

    const { status } = await call(valid);

    expect(status).toBe(409);
    expect(users).toHaveLength(1);
  });

  it('refuses a soft-deleted system account on that email', async () => {
    users.push({ ...systemRow, id: 7, deletedAt: new Date() });

    const { status } = await call(valid);

    expect(status).toBe(409);
    expect(users).toHaveLength(1);
  });

  it('refuses a username taken by another account', async () => {
    users.push({ id: 7, email: 'other@civitai.com', username: 'civdisputes', deletedAt: null });

    const { status } = await call(valid);

    expect(status).toBe(409);
    expect(users).toHaveLength(1);
  });

  it('treats a create that loses a race as the account the winner made', async () => {
    dbMock.dbWrite.user.findUnique.mockImplementationOnce(async () => null);
    dbMock.dbWrite.user.findUnique.mockImplementationOnce(async () => null);
    users.push({ ...systemRow, id: 7 });

    const { status, body } = await call(valid);

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: 7, created: false });
    expect(users).toHaveLength(1);
  });

  it.each([
    ['an outside domain', { ...valid, email: 'disputes@example.com' }],
    ['a lookalike subdomain', { ...valid, email: 'disputes@civitai.com.example.com' }],
    ['a domain ending in the name', { ...valid, email: 'disputes@evilcivitai.com' }],
    ['a subdomain', { ...valid, email: 'disputes@sub.civitai.com' }],
    ['an invalid email', { ...valid, email: 'not-an-email' }],
    ['a username with illegal characters', { ...valid, username: 'Civ Disputes!' }],
    ['a too-short username', { ...valid, username: 'ab' }],
  ])('rejects %s', async (_label, body) => {
    const { status } = await call(body);

    expect(status).toBe(400);
    expect(users).toHaveLength(0);
  });

  it('rejects a username the blocklist does not permit', async () => {
    isUsernamePermitted.mockImplementation(async () => false);

    const { status } = await call(valid);

    expect(status).toBe(400);
    expect(users).toHaveLength(0);
  });

  it.each(['CivitaiModeration', 'civitaimoderation'])(
    'lets the reserved shared moderation account name %s past the blocklist',
    async (username) => {
      isUsernamePermitted.mockImplementation(async () => false);

      const { status, body } = await call({ email: 'moderation@civitai.com', username });

      expect(status).toBe(201);
      expect(body).toMatchObject({ username, created: true });
    }
  );

  it.each(['CivitaiModeration2', 'Civitai_Moderation', 'xCivitaiModeration', 'CivitaiModerator'])(
    'still holds the near-miss %s to the blocklist',
    async (username) => {
      isUsernamePermitted.mockImplementation(async () => false);

      const { status } = await call({ email: 'moderation@civitai.com', username });

      expect(status).toBe(400);
      expect(users).toHaveLength(0);
    }
  );
});
