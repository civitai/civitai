import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';

const { mockAddContributor, mockRemoveContributor } = vi.hoisted(() => ({
  mockAddContributor: vi.fn(),
  mockRemoveContributor: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  addContributorToCollection: mockAddContributor,
  removeContributorFromCollection: mockRemoveContributor,
}));

import { followHandler, unfollowHandler } from '../collection.controller';
import { followCollectionInputSchema } from '~/server/schema/collection.schema';

const CALLER_ID = 1;
const VICTIM_ID = 999;
const COLLECTION_ID = 42;

const ctx = { user: { id: CALLER_ID, isModerator: false } } as never;

// Both services accept a target other than the caller on `manage` alone, which the owner, every
// Manager and every moderator hold. Reached through these two handlers that skipped every guard
// the collaborator paths apply: the two-way block check, the caps, and the owner-only rule over a
// Manager's seat. So the handlers must bind to the caller and offer no way to name anyone else.
describe('follow/unfollow are self-bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The router parses with this schema before the handler runs, so a smuggled key never arrives.
  it('strips a target user from the input', () => {
    const parsed = followCollectionInputSchema.parse({
      collectionId: COLLECTION_ID,
      userId: VICTIM_ID,
    });

    expect(parsed).toEqual({ collectionId: COLLECTION_ID });
    expect(parsed).not.toHaveProperty('userId');
  });

  it('follows as the caller even when a target is smuggled past the schema', () => {
    followHandler({ ctx, input: { collectionId: COLLECTION_ID, userId: VICTIM_ID } as never });

    expect(mockAddContributor).toHaveBeenCalledWith({
      collectionId: COLLECTION_ID,
      userId: CALLER_ID,
      targetUserId: CALLER_ID,
    });
  });

  // The one that matters most: removeContributorFromCollection checks `manage` and nothing else,
  // so a target here let a Manager delete another Manager's row — which removeCollaborator refuses.
  it('unfollows as the caller even when a target is smuggled past the schema', () => {
    unfollowHandler({ ctx, input: { collectionId: COLLECTION_ID, userId: VICTIM_ID } as never });

    expect(mockRemoveContributor).toHaveBeenCalledWith({
      collectionId: COLLECTION_ID,
      userId: CALLER_ID,
      targetUserId: CALLER_ID,
    });
  });
});
