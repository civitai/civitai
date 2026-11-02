import { describe, expect, it } from 'vitest';
import { postsQuerySchema } from '~/server/schema/post.schema';

describe('postsQuerySchema userId', () => {
  // zod strips keys the schema does not name, so without this field a profile's posts query
  // arrives with no account in it.
  it('keeps the account id a profile scopes its posts to', () => {
    const parsed = postsQuerySchema.parse({ userId: 42, username: 'foo-bar' });

    expect(parsed.userId).toBe(42);
  });
});
