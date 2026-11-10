import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WriteService from '~/server/services/commentv3/write.service';

const m = vi.hoisted(() => ({
  owners: vi.fn(async (..._a: unknown[]): Promise<number[]> => [4]),
  stored: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
  commentMute: vi.fn(async (..._a: unknown[]) => ({ muted: true })),
  topicMute: vi.fn(async (..._a: unknown[]) => ({ muted: true })),
  topicMuted: vi.fn(async (..._a: unknown[]) => true),
}));

vi.mock('~/server/services/block-check.service', () => ({ getBlockCheckOwnerIds: m.owners }));
vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteService>()),
  getV3WriteComment: m.stored,
  toggleCommentMute: m.commentMute,
  toggleTopicMute: m.topicMute,
  isTopicMuted: m.topicMuted,
}));

const { getSectionMuted, getCommentMuted, toggleSectionMute, toggleCommentMute } = await import(
  '~/server/services/commentv3/section.service'
);

beforeEach(() => vi.clearAllMocks());

describe('a section mute', () => {
  const section = { entityType: 'image', entityId: 10, userId: 7 } as const;

  // Two surfaces, so a hardcoded entity type cannot pass.
  it.each([
    ['image', 10],
    ['comicChapter', 12],
  ] as const)('mutes the %s topic of an entity that exists', async (entityType, entityId) => {
    await expect(toggleSectionMute({ entityType, entityId, userId: 7 })).resolves.toEqual({
      muted: true,
      exists: true,
    });
    expect(m.owners).toHaveBeenCalledWith({ entityType, entityId });
    expect(m.topicMute).toHaveBeenCalledWith(expect.anything(), {
      userId: 7,
      entityType,
      entityId,
    });
  });

  // It takes a plain entity id, so it must not write a row for one that does not exist.
  it('writes nothing for an entity that does not exist', async () => {
    m.owners.mockResolvedValueOnce([]);
    await expect(toggleSectionMute(section)).resolves.toEqual({ muted: false, exists: false });
    expect(m.topicMute).not.toHaveBeenCalled();
  });
});

describe('a section mute status', () => {
  it("answers the caller's own mute on a section that exists", async () => {
    await expect(getSectionMuted({ entityType: 'post', entityId: 3, userId: 7 })).resolves.toEqual({
      muted: true,
      exists: true,
    });
    expect(m.topicMuted).toHaveBeenCalledWith(expect.anything(), {
      userId: 7,
      entityType: 'post',
      entityId: 3,
    });
  });

  // The control relabels itself on `exists`, so a missing entity must not read as unmuted.
  it('says there is nothing to mute for an entity that does not exist', async () => {
    m.owners.mockResolvedValueOnce([]);
    m.topicMuted.mockResolvedValueOnce(false);
    await expect(getSectionMuted({ entityType: 'post', entityId: 3, userId: 7 })).resolves.toEqual({
      muted: false,
      exists: false,
    });
  });
});

describe('a thread mute', () => {
  it('mutes a live comment for the caller', async () => {
    m.stored.mockResolvedValueOnce({ id: 5, tosViolation: false });
    await expect(toggleCommentMute({ commentId: 5, userId: 7 })).resolves.toEqual({ muted: true });
    expect(m.commentMute).toHaveBeenCalledWith(expect.anything(), { userId: 7, commentId: 5 });
  });

  it('takes a comment the caller already read without reading it again', async () => {
    const comment = { id: 5, tosViolation: false } as never;
    await toggleCommentMute({ commentId: 5, userId: 7 }, { comment });
    expect(m.stored).not.toHaveBeenCalled();
    expect(m.commentMute).toHaveBeenCalledTimes(1);
    await expect(
      toggleCommentMute({ commentId: 5, userId: 7 }, { comment: undefined })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.stored).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['removed for ToS', { id: 5, tosViolation: true }],
  ])('answers a %s comment as not found, writing nothing', async (_, row) => {
    m.stored.mockResolvedValueOnce(row);
    await expect(toggleCommentMute({ commentId: 5, userId: 7 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(m.commentMute).not.toHaveBeenCalled();
  });
});

describe('a thread mute status', () => {
  it('takes a comment the caller already read without reading it again', async () => {
    await expect(
      getCommentMuted({ commentId: 5, userId: 7 }, { comment: undefined })
    ).resolves.toMatchObject({ canMute: false });
    expect(m.stored).not.toHaveBeenCalled();
  });

  // The endpoint takes a bare id, so it must answer a ToS removal exactly as a missing comment.
  it.each([
    ['missing', undefined],
    ['removed for ToS', { id: 5, tosViolation: true }],
  ])('offers nothing for a %s comment', async (_, row) => {
    m.stored.mockResolvedValueOnce(row);
    await expect(getCommentMuted({ commentId: 5, userId: 7 })).resolves.toEqual({
      muted: false,
      viaAncestor: false,
      canMute: false,
    });
  });
});
