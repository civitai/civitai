import { describe, expect, it } from 'vitest';
import { postsQuerySchema } from '~/server/schema/post.schema';

describe('postsQuerySchema userId', () => {
  // zod strips keys the schema does not name, so without this field a profile's posts query
  // arrives with no account in it.
  it('keeps the account id a profile scopes its posts to', () => {
    const parsed = postsQuerySchema.parse({ userId: 42, username: 'foo-bar' });

    expect(parsed.userId).toBe(42);
  });

  // Each distinct id gets its own cache tag set, and Postgres rejects ids past int4.
  it.each([0, -1, 2 ** 31])('rejects %s', (userId) => {
    expect(postsQuerySchema.safeParse({ userId }).success).toBe(false);
  });
});
