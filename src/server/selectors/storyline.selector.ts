import type { Prisma } from '@prisma/client';

/** The title's rating, as the text scan or a moderator set it. */
export const storylineTitleLevelSelect = {
  nsfwLevel: true,
  moderatorNsfwLevel: true,
} satisfies Prisma.StorylineSelect;

/**
 * Chapter 1, as `isStorylineHidden` judges it. Its level is also the story's level for the reader's
 * browsing-level gate.
 */
export const storylineRootChapterSelect = {
  where: { depth: 0 },
  select: {
    id: true,
    postId: true,
    removedAt: true,
    post: {
      select: {
        nsfwLevel: true,
        publishedAt: true,
        tosViolation: true,
        user: { select: { bannedAt: true, deletedAt: true } },
      },
    },
  },
} satisfies Prisma.Storyline$chaptersArgs;
