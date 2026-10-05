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
 * ⚠️ The App-Block review surfaces' user chip — `simpleUserSelect` MINUS `profilePicture` —
 * deliberately does NOT live here. It is in `~/server/selectors/review-user-chip.selector`,
 * a leaf with a TYPE-ONLY Prisma import, because this module calls `Prisma.validator` at
 * load and pulls in `image.selector` → `tag.selector`, which several service suites cannot
 * tolerate (they mock `@prisma/client` with a narrow factory and die on
 * `Prisma.validator is not a function`). That file's header carries the full reasoning, and
 * `review-submitter-select-parity.test.ts` asserts the two stay in the stated relationship.
 */

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
