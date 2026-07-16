import { describe, expect, it } from 'vitest';
import {
  commentConnectorSchema,
  toggleHideCommentSchema,
} from '~/server/schema/commentv2.schema';

/**
 * CommentsV2 schema — the `appListing` entity type must be accepted by BOTH the
 * supported-parent enums that gate the shared comment procs. These two enums must
 * agree; a value in one but not the other silently breaks a moderation path.
 */
describe('commentv2 schema — appListing entity type', () => {
  it('commentConnectorSchema accepts appListing with a numeric entityId', () => {
    const parsed = commentConnectorSchema.parse({ entityType: 'appListing', entityId: 42 });
    expect(parsed.entityType).toBe('appListing');
    expect(parsed.entityId).toBe(42);
  });

  it('commentConnectorSchema rejects a non-numeric entityId (CommentsV2 is int-keyed)', () => {
    // The listing PK is a TEXT ULID, but the comment thread key is the INTEGER
    // surrogate — passing the ULID here must fail (guards the id-type bridge).
    expect(() =>
      commentConnectorSchema.parse({ entityType: 'appListing', entityId: 'apl_01H' as unknown as number })
    ).toThrow();
  });

  it('toggleHideCommentSchema (moderation) accepts appListing', () => {
    const parsed = toggleHideCommentSchema.parse({
      id: 1,
      entityType: 'appListing',
      entityId: 42,
    });
    expect(parsed.entityType).toBe('appListing');
  });

  it('rejects an unknown entity type', () => {
    expect(() =>
      commentConnectorSchema.parse({ entityType: 'notAThing', entityId: 1 })
    ).toThrow();
  });
});
