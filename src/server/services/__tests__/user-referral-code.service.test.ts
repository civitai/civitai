import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  deleteUserReferralCode,
  upsertUserReferralCode,
} from '~/server/services/user-referral-code.service';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SCHEMA = `
  CREATE TABLE "UserReferralCode" (
    id int PRIMARY KEY, "userId" int NOT NULL, code text UNIQUE NOT NULL, note text,
    "deletedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT now()
  );
`;

const OWNER = 1;
const OTHER = 2;
const MOD = 3;
const CODE_ID = 10;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

const row = async () => {
  const { rows } = await harness.pg.query<{
    userId: number;
    code: string;
    note: string | null;
    deletedAt: Date | null;
  }>(`SELECT "userId", code, note, "deletedAt" FROM "UserReferralCode" WHERE id = $1`, [CODE_ID]);
  return rows[0];
};

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
});
afterAll(async () => {
  await harness?.stop();
});

beforeEach(async () => {
  await harness.pg.exec(`
    TRUNCATE "UserReferralCode";
    INSERT INTO "UserReferralCode" (id, "userId", code, note) VALUES (${CODE_ID}, ${OWNER}, 'OWNER-CODE', 'mine');
  `);
  const real = harness.prisma.userReferralCode as unknown as Record<
    string,
    (a: unknown) => unknown
  >;
  const write = dbMock.dbWrite.userReferralCode as unknown as Record<
    string,
    ReturnType<typeof vi.fn>
  >;
  for (const method of ['updateMany', 'findUniqueOrThrow'])
    write[method].mockImplementation((a: unknown) => real[method](a));
});

describe('upsertUserReferralCode with an id', () => {
  it("refuses another user's code as NOT_FOUND and leaves the row unchanged", async () => {
    const err = await errorOf(
      upsertUserReferralCode({ id: CODE_ID, userId: OTHER, note: 'stolen' })
    );

    expect(err?.code).toBe('NOT_FOUND');
    expect(await row()).toMatchObject({ userId: OWNER, note: 'mine', code: 'OWNER-CODE' });
  });

  it('answers a missing id exactly as it answers a code the caller does not own', async () => {
    const notYours = await errorOf(upsertUserReferralCode({ id: CODE_ID, userId: OTHER }));
    const missing = await errorOf(upsertUserReferralCode({ id: 999, userId: OTHER }));

    expect(missing).toEqual(notYours);
  });

  it("updates the owner's note and keeps the owner", async () => {
    await upsertUserReferralCode({ id: CODE_ID, userId: OWNER, note: 'edited' });

    expect(await row()).toMatchObject({ userId: OWNER, note: 'edited', code: 'OWNER-CODE' });
  });

  it("lets a moderator edit another user's code without taking it over", async () => {
    await upsertUserReferralCode({
      id: CODE_ID,
      userId: MOD,
      isModerator: true,
      note: 'mod note',
      code: 'NEW-CODE',
    });

    expect(await row()).toMatchObject({ userId: OWNER, note: 'mod note', code: 'NEW-CODE' });
  });
});

describe('deleteUserReferralCode', () => {
  it("refuses another user's code as NOT_FOUND and leaves it live", async () => {
    const notYours = await errorOf(deleteUserReferralCode({ id: CODE_ID, userId: OTHER }));
    const missing = await errorOf(deleteUserReferralCode({ id: 999, userId: OTHER }));

    expect(notYours?.code).toBe('NOT_FOUND');
    expect(missing).toEqual(notYours);
    expect((await row()).deletedAt).toBeNull();
  });

  it.each([
    ['the owner', { userId: OWNER }],
    ['a moderator', { userId: MOD, isModerator: true }],
  ])('soft-deletes for %s', async (_, caller) => {
    await deleteUserReferralCode({ id: CODE_ID, ...caller });

    expect(await row()).toMatchObject({ userId: OWNER, deletedAt: expect.any(Date) });
  });
});
