import { PGlite } from '@electric-sql/pglite';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * An integration token lives an hour. A memorialized, banned or deleted account's token, issued
 * before the change, names no user for the rest of that hour.
 */

import { envMock } from '~/__tests__/mocks/env.mock';
import { createToken } from '~/server/integrations/integration-token';
import handler from '~/pages/api/auth/user-from-token';

const USER = 990500001;
let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TABLE "User" (
      "id" INTEGER PRIMARY KEY, "username" TEXT, "email" TEXT, "flags" INTEGER NOT NULL DEFAULT 0,
      "deletedAt" TIMESTAMP(3), "bannedAt" TIMESTAMP(3)
    );
    CREATE TABLE "Product" ("id" TEXT PRIMARY KEY, "metadata" JSONB);
    CREATE TABLE "CustomerSubscription" ("userId" INTEGER, "status" TEXT, "productId" TEXT);
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  envMock.set({ INTEGRATION_TOKEN: 'test-integration-secret' });
  dbMock.dbRead.$queryRawUnsafe.mockImplementation(
    (async (sql: string) => (await pg.query(sql)).rows) as never
  );
  await pg.exec('DELETE FROM "User"');
});

const request = async () => {
  // Recorded by hand: the endpoint wrapper replaces `res.status` with its own function.
  const sent: { status: number; body: unknown } = { status: 200, body: undefined };
  const res: Record<string, unknown> = {
    status: (code: number) => {
      sent.status = code;
      return res;
    },
    send: (body: unknown) => {
      sent.body = body;
      return res;
    },
    json: (body: unknown) => {
      sent.body = body;
      return res;
    },
    setHeader: () => res,
    on: () => res,
  };
  await handler(
    {
      method: 'POST',
      url: '/api/auth/user-from-token',
      query: {},
      headers: { 'x-webhook-token': 'test-webhook-token' },
      body: { token: createToken(USER) },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return sent;
};

const seed = (columns: { flags?: number; deletedAt?: Date; bannedAt?: Date } = {}) =>
  pg.query(
    'INSERT INTO "User" (id, username, email, flags, "deletedAt", "bannedAt") VALUES ($1, $2, $3, $4, $5, $6)',
    [USER, 'holder', 'holder@example.com', columns.flags ?? 0, columns.deletedAt, columns.bannedAt]
  );

describe('/api/auth/user-from-token', () => {
  it('names an ordinary account (positive control)', async () => {
    await seed();
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: USER, username: 'holder' });
  });

  it.each([
    ['memorialized', { flags: 4 }],
    ['banned', { bannedAt: new Date() }],
    ['deleted', { deletedAt: new Date() }],
  ])('names no user for a %s account', async (_, columns) => {
    await seed(columns);
    const res = await request();
    expect(res).toEqual({ status: 403, body: 'Invalid user' });
  });
});
