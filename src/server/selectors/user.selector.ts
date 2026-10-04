import { Prisma } from '@prisma/client';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';

export const simpleUserSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  deletedAt: true,
  image: true,
  profilePicture: {
    select: profileImageSelect,
  },
});

const simpleUser = Prisma.validator<Prisma.UserDefaultArgs>()({
  select: simpleUserSelect,
});

export type SimpleUser = Prisma.UserGetPayload<typeof simpleUser>;

/**
 * `simpleUserSelect` WITHOUT `profilePicture` — the user chip the moderator App-Block review
 * surfaces project, on both the queue list and the per-submission page.
 *
 * 🔴 WHY A SECOND SELECT RATHER THAN `simpleUserSelect` ITSELF. `profilePicture` is a NESTED
 * select on `Image`, so Prisma issues an extra batched query against one of the largest
 * tables in the database per list call — on three mod-queue list paths, for a cosmetic gain
 * that `UserAvatar` already falls back from (it uses the `image` string when there is no
 * profile-picture row). If it ever becomes affordable the batched route is the
 * `profilePictureCache`, not a nested select here.
 *
 * 🔴 WHY ONE DECLARATION RATHER THAN THE LITERAL AT EACH CALL SITE. It was spelled inline at
 * NINE sites in `publish-request.service.ts` plus one in `offsite-listing.service.ts`, and
 * the copies genuinely diverged: `deletedAt` reached the five `submittedBy` ones a whole
 * round before the four `reviewedBy` ones, and the off-site chip later than both — so for a
 * while the `/apps/review` queue rendered a deleted submitter as `[deleted]` on an on-site
 * row and as a live, linked profile on the off-site row directly beside it.
 *
 * 🔴 `deletedAt` IS LOAD-BEARING, NOT DECORATION. `UserAvatar` BRANCHES on it twice —
 * `UserProfileLink` suppresses `linkToProfile` for a closed account and `Username` renders
 * "[deleted]" instead of a name. Omit it and the value is `undefined` ⇒ falsy ⇒ a deleted
 * account renders as a live, linked one.
 */
export const reviewUserChipSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  deletedAt: true,
  image: true,
});

export const userWithCosmeticsSelect = Prisma.validator<Prisma.UserSelect>()({
  ...simpleUserSelect,
  // TODO.leaderboard: uncomment when migration is done
  // leaderboardShowcase: true,
  cosmetics: {
    where: { equippedAt: { not: null }, equippedToId: null },
    select: {
      data: true,
      cosmetic: {
        select: {
          id: true,
          data: true,
          type: true,
          source: true,
          name: true,
        },
      },
    },
  },
});

const userWithCosmetics = Prisma.validator<Prisma.UserDefaultArgs>()({
  select: userWithCosmeticsSelect,
});

export type UserWithCosmetics = Prisma.UserGetPayload<typeof userWithCosmetics>;

export const userWithProfileSelect = Prisma.validator<Prisma.UserSelect>()({
  ...simpleUserSelect,
  leaderboardShowcase: true,
  createdAt: true,
  muted: true,
  cosmetics: {
    select: {
      equippedAt: true,
      cosmeticId: true,
      obtainedAt: true,
      claimKey: true,
      data: true,
      cosmetic: {
        select: {
          id: true,
          data: true,
          type: true,
          source: true,
          name: true,
          description: true,
          videoUrl: true,
        },
      },
    },
  },
  links: {
    select: {
      id: true,
      url: true,
      type: true,
    },
  },
  rank: {
    select: {
      leaderboardRank: true,
      leaderboardId: true,
      leaderboardTitle: true,
      leaderboardCosmetic: true,
    },
  },
  profile: {
    select: {
      bio: true,
      coverImageId: true,
      coverImage: {
        select: imageSelect,
      },
      message: true,
      messageAddedAt: true,
      sfwBio: true,
      sfwMessage: true,
      sfwMessageAddedAt: true,
      sfwCoverImageId: true,
      sfwCoverImage: {
        select: imageSelect,
      },
      profileSectionsSettings: true,
      privacySettings: true,
      showcaseItems: true,
      location: true,
      nsfw: true,
      userId: true,
    },
  },
});

export const playerInfoSelect = Prisma.validator<Prisma.NewOrderPlayerSelect>()({
  startAt: true,
  rankType: true,
  rank: {
    select: { type: true, name: true, iconUrl: true },
  },
  user: {
    select: { id: true, username: true },
  },
});

export const userWithPlayerInfoSelect = Prisma.validator<Prisma.UserSelect>()({
  ...simpleUserSelect,
  playerInfo: { select: playerInfoSelect },
});
