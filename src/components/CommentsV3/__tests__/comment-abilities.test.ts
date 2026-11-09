import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentV3Comment } from '~/components/CommentsV3/types';

const h = vi.hoisted(() => ({
  user: null as { id: number; isModerator?: boolean } | null,
  section: { ownerId: 1, isMuted: false, forceLocked: false },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/components/CommentsV3/CommentSectionContext', () => ({
  useCommentSection: () => h.section,
}));

const { useCommentAbilities } = await import('~/components/CommentsV3/CommentMenu');

// The server refuses each of these; the menu decides what a viewer is offered.
const OWNER = 1;
const AUTHOR = 2;
const STRANGER = 3;
const comment = (over: Partial<CommentV3Comment> = {}) =>
  ({ id: 10, user: { id: AUTHOR }, locked: false, hidden: false, ...over } as CommentV3Comment);
const useAbilitiesAs = (
  id: number,
  isModerator = false,
  over?: Partial<CommentV3Comment>,
  lockedAbove = false
) => {
  h.user = { id, isModerator };
  return useCommentAbilities(comment(over), lockedAbove);
};

beforeEach(() => {
  h.section = { ownerId: OWNER, isMuted: false, forceLocked: false };
});

describe("a comment's menu", () => {
  it('offers hide and pin to the section owner and moderators, not the author or a stranger', () => {
    expect(useAbilitiesAs(OWNER)).toMatchObject({ hide: true, pin: true });
    expect(useAbilitiesAs(STRANGER, true)).toMatchObject({ hide: true, pin: true });
    expect(useAbilitiesAs(AUTHOR)).toMatchObject({ hide: false, pin: false });
    expect(useAbilitiesAs(STRANGER)).toMatchObject({ hide: false, pin: false });
  });

  it('offers edit and delete to the author and moderators, and report to everyone else', () => {
    expect(useAbilitiesAs(AUTHOR)).toMatchObject({ edit: true, delete: true, report: false });
    expect(useAbilitiesAs(STRANGER, true)).toMatchObject({ edit: true, delete: true });
    expect(useAbilitiesAs(OWNER)).toMatchObject({ edit: false, delete: false, report: true });
  });

  it('takes Reply away under a lock on the comment, and from a hidden one', () => {
    expect(useAbilitiesAs(STRANGER).reply).toBe(true);
    expect(useAbilitiesAs(STRANGER, false, { locked: true }).reply).toBe(false);
    expect(useAbilitiesAs(STRANGER, false, { hidden: true }).reply).toBe(false);
  });

  it('under a lock above, takes Reply from everyone and Edit from all but moderators', () => {
    expect(useAbilitiesAs(STRANGER, false, {}, true).reply).toBe(false);
    expect(useAbilitiesAs(AUTHOR, false, {}, true).edit).toBe(false);
    expect(useAbilitiesAs(STRANGER, true, {}, true)).toMatchObject({ edit: true, reply: false });
  });

  it('takes Reply away in a muted or force-locked section', () => {
    h.section = { ...h.section, isMuted: true };
    expect(useAbilitiesAs(STRANGER).reply).toBe(false);
    h.section = { ownerId: OWNER, isMuted: false, forceLocked: true };
    expect(useAbilitiesAs(STRANGER).reply).toBe(false);
  });
});
