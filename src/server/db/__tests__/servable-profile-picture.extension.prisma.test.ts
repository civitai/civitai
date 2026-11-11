import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { servableProfilePictureExtension } from '~/server/db/servable-profile-picture.extension';

/**
 * The extension through a real PrismaClient's `$extends`, so Prisma's own handler signature, the
 * `$allModels` keys and the args it passes are what the gate sees. The engine is never reached: an
 * inner extension, applied after it, answers each query with `rows` and records the args it got.
 */

const rows: { current: unknown } = { current: [] };
const seen: unknown[] = [];

const base = new PrismaClient({ datasourceUrl: 'postgresql://unused@127.0.0.1:1/unused' });
const answer = async ({ args }: { args: unknown }) => {
  seen.push(args);
  return rows.current as never;
};
// Query extensions run in the order they are applied, each `query` calling the next: the gate
// first, as in client.ts, and the stand-in for the engine after it.
const client = base.$extends(servableProfilePictureExtension(() => undefined)).$extends({
  query: {
    $allModels: {
      findMany: answer,
      findUnique: answer,
      findFirst: answer,
      findUniqueOrThrow: answer,
      findFirstOrThrow: answer,
    },
  },
});

afterAll(() => base.$disconnect());

const picture = (ingestion: string, needsReview: string | null = null) => ({
  id: 2,
  url: `avatar-${ingestion}`,
  ingestion,
  needsReview,
});

describe('the servable profile picture extension on a real Prisma client', () => {
  it('nulls an unscanned or csam-flagged picture in a nested simpleUserSelect, keeps a Scanned one', async () => {
    rows.current = [
      { id: 1, user: { id: 5, profilePicture: picture('Pending') } },
      { id: 2, user: { id: 6, profilePicture: picture('Scanned', 'csam') } },
      { id: 3, user: { id: 7, profilePicture: picture('Scanned') } },
    ];
    seen.length = 0;

    const result = (await client.post.findMany({
      select: { id: true, user: { select: simpleUserSelect } },
    })) as unknown as { user: { profilePicture: { url: string } | null } }[];

    expect(result.map((r) => r.user.profilePicture?.url ?? null)).toEqual([
      null,
      null,
      'avatar-Scanned',
    ]);
    // The field it added for the check reached the query and left the result.
    const sent = seen[0] as {
      select: { user: { select: { profilePicture: { select: Record<string, boolean> } } } };
    };
    expect(sent.select.user.select.profilePicture.select.needsReview).toBe(true);
    expect(result[2].user.profilePicture).not.toHaveProperty('needsReview');
  });

  it('gates a findUnique on the user itself', async () => {
    rows.current = { id: 5, profilePicture: picture('Error') };
    const result = await client.user.findUnique({ where: { id: 5 }, select: simpleUserSelect });
    expect(result?.profilePicture).toBeNull();
  });

  it('gates findUniqueOrThrow and findFirstOrThrow', async () => {
    rows.current = { id: 5, profilePicture: picture('Pending') };
    const unique = await client.user.findUniqueOrThrow({
      where: { id: 5 },
      select: simpleUserSelect,
    });
    rows.current = { id: 5, profilePicture: picture('Scanned', 'csam') };
    const first = await client.user.findFirstOrThrow({ select: simpleUserSelect });
    expect(unique.profilePicture).toBeNull();
    expect(first.profilePicture).toBeNull();
  });

  it('passes a query without the picture through as the same object', async () => {
    const plain = [{ id: 1, username: 'u' }];
    rows.current = plain;
    const result = await client.user.findMany({ select: { id: true, username: true } });
    expect(result).toBe(plain);
  });
});
