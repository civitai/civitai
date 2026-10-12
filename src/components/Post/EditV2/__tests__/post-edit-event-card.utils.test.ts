import { describe, expect, it } from 'vitest';
import { postEditEventCard } from '~/components/Post/EditV2/post-edit-event-card.utils';

const NOW = new Date('2026-11-05T00:00:00Z');
const base = {
  ownerId: 7,
  viewerId: 7,
  collectionId: null,
  publishedAt: null,
  unpublishedByParent: false,
  addedImages: [{ id: 1 }, { id: 2 }],
  ownModelId: null,
  now: NOW,
};

describe('postEditEventCard', () => {
  it("offers the card to the post's owner, on the first image, with the draft note", () => {
    expect(postEditEventCard(base)).toEqual({ coverImage: { id: 1 }, showDraftNote: true });
  });

  it('offers nothing to a moderator editing someone else’s post, or a contest entry', () => {
    expect(postEditEventCard({ ...base, viewerId: 99 })).toBeUndefined();
    expect(postEditEventCard({ ...base, viewerId: undefined })).toBeUndefined();
    expect(postEditEventCard({ ...base, collectionId: 5 })).toBeUndefined();
  });

  it('keeps the draft note until the post is live, and drops it where it cannot be published', () => {
    const note = (over: Partial<typeof base> & { publishedAt?: Date | null }) =>
      postEditEventCard({ ...base, ...over })?.showDraftNote;
    expect(note({ publishedAt: new Date('2026-11-01T00:00:00Z') })).toBe(false);
    expect(note({ publishedAt: NOW })).toBe(false);
    expect(note({ publishedAt: new Date('2026-11-09T00:00:00Z') })).toBe(true);
    expect(note({ unpublishedByParent: true })).toBe(false);
  });

  it("names the owner's model a post belongs to, so the card hats the model", () => {
    expect(postEditEventCard({ ...base, ownModelId: 99 })?.modelId).toBe(99);
    expect(postEditEventCard(base)?.modelId).toBeUndefined();
  });

  it('has no cover for a post without images', () => {
    expect(postEditEventCard({ ...base, addedImages: [] })?.coverImage).toBeUndefined();
  });
});
