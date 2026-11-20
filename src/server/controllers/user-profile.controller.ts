import { bustUserCreator } from '~/server/services/user-creator.service';
import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';
import {
  addToShowcaseSection,
  getUserContentOverview,
  getUserWithProfile,
  setShowcaseSections,
  updateUserProfile,
} from '~/server/services/user-profile.service';
import type {
  AddToShowcaseSectionSchema,
  GetUserProfileSchema,
  PrivacySettingsSchema,
  ProfileSectionSchema,
  SetShowcaseSectionsSchema,
  ShowcaseItemSchema,
  ShowcaseSectionSchema,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import type { Context, ProtectedContext } from '~/server/createContext';
import { eventViewerOf } from '~/server/events/event-viewer';
import { TRPCError } from '@trpc/server';
import { entityExists } from '~/server/services/util.service';
import { constants } from '~/server/common/constants';
import {
  amIBlockedByUser,
  archiveProfileBeforeModeratorChange,
  type ProfileClearField,
} from '~/server/services/user.service';
import { archiveUserProfile } from '~/server/services/csam.service-new';
import { dbWrite } from '~/server/db/client';
import { getShowcaseHatForUser } from '~/server/events/showcase-hat';

export const getUserContentOverviewHandler = async ({
  input,
  ctx,
}: {
  input: GetUserProfileSchema;
  ctx: Context;
}) => {
  // Pick the overview variant so the counts match what the user can actually browse:
  //   anonymous (any domain)     â†’ 'public' (PG only)
  //   logged-in on green domain  â†’ 'sfw'    (PG + PG-13)
  //   logged-in on blue/red      â†’ 'all'    (respect user preference)
  const variant = !ctx.user ? 'public' : ctx.domain === 'green' ? 'sfw' : 'all';
  try {
    const overview = await getUserContentOverview({
      username: input.username,
      variant,
    });

    return overview;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
export const getUserProfileHandler = async ({
  input,
  ctx,
}: {
  input: GetUserProfileSchema;
  ctx: Context;
}) => {
  try {
    const user = await getUserWithProfile({
      username: input.username,
      isModerator: ctx.user?.isModerator,
      sessionUserId: ctx.user?.id,
      eventViewer: eventViewerOf(ctx),
      domain: ctx.domain,
    });

    if (ctx.user && !ctx.user.isModerator) {
      const blocked = await amIBlockedByUser({ userId: ctx.user.id, targetUserId: user.id });
      if (blocked) {
        // Return a minimal stub so the viewer can block back. Strip every field
        // that could leak content the blocker doesn't want them to see.
        return {
          ...user,
          blockedByThem: true as const,
          muted: false,
          links: [],
          cosmetics: [],
          showcaseHat: null,
          rank: null,
          leaderboardShowcase: null,
          stats: null,
          profile: {
            userId: user.id,
            bio: null,
            message: null,
            messageAddedAt: null,
            coverImage: null,
            coverImageId: null,
            defaultBio: null,
            defaultMessage: null,
            defaultMessageAddedAt: null,
            defaultCoverImage: null,
            sfwBio: null,
            sfwMessage: null,
            sfwMessageAddedAt: null,
            sfwCoverImage: null,
            sfwCoverImageId: null,
            location: null,
            nsfw: false,
            showcaseItems: [] as ShowcaseItemSchema[],
            showcaseSections: [] as ShowcaseSectionSchema[],
            profileSectionsSettings: [] as ProfileSectionSchema[],
            privacySettings: {} as PrivacySettingsSchema,
          },
        };
      }
    }

    return { ...user, showcaseHat: await getShowcaseHatForUser(user.id) };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const updateUserProfileHandler = async ({
  input,
  ctx,
}: {
  input: UserProfileUpdateSchema;
  ctx: ProtectedContext;
}) => {
  const { user: sessionUser } = ctx;

  try {
    if ((!sessionUser.isModerator && input.userId !== sessionUser.id) || sessionUser.muted)
      throw throwAuthorizationError();

    const userId = sessionUser.isModerator ? input.userId || sessionUser.id : sessionUser.id;
    const byModerator = userId !== sessionUser.id;
    if (byModerator) {
      // The civitai.com copies count as the field they override.
      const touched = {
        bio: ['bio', 'sfwBio'],
        message: ['message', 'sfwMessage'],
        location: ['location'],
        links: ['socialLinks', 'sponsorshipLinks'],
      };
      const fields = (Object.keys(touched) as (keyof typeof touched)[]).filter((field) =>
        touched[field].some((key) => key in input)
      );
      if (fields.length)
        await archiveProfileBeforeModeratorChange({
          userId,
          actorId: sessionUser.id,
          fields,
          archive: archiveUserProfile,
        });
    }
    const user = await updateUserProfile({
      ...input,
      userId,
      isModerator: sessionUser.isModerator,
      sessionUserId: sessionUser.id,
      domain: ctx.domain,
    });

    await bustUserCreator(userId);
    if (byModerator)
      await dbWrite.modActivity.create({
        data: {
          userId: sessionUser.id,
          activity: 'editProfile',
          entityType: 'User',
          entityId: userId,
        },
      });

    return user;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
export const setShowcaseSectionsHandler = async ({
  input,
  ctx,
}: {
  input: SetShowcaseSectionsSchema;
  ctx: ProtectedContext;
}) => {
  if (ctx.user.muted) throw throwAuthorizationError();
  try {
    return await setShowcaseSections({ ...input, userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const addToShowcaseSectionHandler = async ({
  input,
  ctx,
}: {
  input: AddToShowcaseSectionSchema;
  ctx: ProtectedContext;
}) => {
  if (ctx.user.muted) throw throwAuthorizationError();
  try {
    return await addToShowcaseSection({ ...input, userId: ctx.user.id });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const addEntityToShowcaseHandler = async ({
  input,
  ctx,
}: {
  input: ShowcaseItemSchema;
  ctx: ProtectedContext;
}) => {
  try {
    await entityExists({
      entityType: input.entityType,
      entityId: input.entityId,
    });

    const user = await getUserWithProfile({ id: ctx.user.id });
    const showcaseItems = (user.profile.showcaseItems as ShowcaseItemSchema[]) || [];

    if (
      showcaseItems.find(
        (item) => item.entityId === input.entityId && item.entityType === input.entityType
      )
    ) {
      return user;
    }

    const updatedShowcaseItems = [input, ...showcaseItems].slice(
      0,
      constants.profile.showcaseItemsLimit
    );

    const result = await updateUserProfile({
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
      sessionUserId: ctx.user.id,
      showcaseItems: updatedShowcaseItems,
    });

    await bustUserCreator(ctx.user.id);

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
