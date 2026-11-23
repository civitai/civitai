import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { EventViewer } from '~/server/events/event-access';
import { withoutHiddenEventDecorations } from '~/server/events/event-decoration-access';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  readUserWithProfileAndPictureGateViaKysely,
  readUserWithProfileViaPrisma,
} from '~/server/services/hot-reads-9.reads';
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
import {
  customShowcaseKey,
  customShowcaseKeyPrefix,
  showcaseSectionLimits,
  showcaseSectionTypes,
} from '~/server/schema/user-profile.schema';
import { publishedImageWhere } from '~/server/selectors/image.selector';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  ImageIngestionStatus,
  ModelModifier,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import { servableProfilePicture } from '~/server/services/profile-picture.servable';
import { servableArticleImage } from '~/shared/utils/article-card-image';
import { isRestrictedImage } from '~/shared/utils/restricted-image';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { getProfilePictureOfUser } from '~/server/services/profile-picture.sql';
import { enqueueImageIngestion } from '~/server/services/image.service';
import type { UserMeta } from '~/server/schema/user.schema';
import { getUserBanDetails } from '~/utils/user-helpers';
import { sanitizeProvenance } from '~/server/services/orchestrator/remix-provenance';
import { pickClientImageColumns } from '~/server/utils/image-columns';
import {
  assertClientImageUrlsUsable,
  assertClientKeysIssuedToCaller,
} from '~/server/services/image-url-ownership';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  getUserContentOverview as getUserContentOverviewFromCache,
  getUserContentOverviewPublic as getUserContentOverviewPublicFromCache,
  getUserContentOverviewSfw as getUserContentOverviewSfwFromCache,
} from '~/server/redis/caches';
import { userUpdateCounter } from '~/server/prom/client';
import { usersSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { isShowcaseHiddenOn } from '~/shared/constants/profile-showcase.constants';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { queueScamScan } from '~/server/services/text-scan/scam-scan-queue';
import { ownsAllContent } from '~/server/services/owned-content';

export type UserContentOverviewVariant = 'public' | 'sfw' | 'all';

export const getUserContentOverview = async ({
  username,
  userId,
  variant = 'all',
}: {
  username?: string;
  userId?: number;
  variant?: UserContentOverviewVariant;
}) => {
  if (!username && !userId) {
    throwBadRequestError('Either username or id must be provided');
  }

  if (!userId) {
    const user = await dbWrite.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!user) {
      throw throwNotFoundError('User not found');
    }

    userId = user.id;
  }

  const fetchFn =
    variant === 'public'
      ? getUserContentOverviewPublicFromCache
      : variant === 'sfw'
      ? getUserContentOverviewSfwFromCache
      : getUserContentOverviewFromCache;
  const data = await fetchFn([userId]);
  return data[userId];
};

/**
 * `domain` selects which stored variant of the split profile fields (cover image /
 * announcement / bio) the caller sees. The check must stay green vs. not-green:
 * `civitai.red` is configured as blue's primary too, so the request's resolved color
 * is `blue` there and a `domain === 'red'` check would never fire in production.
 */
export const getUserWithProfile = async ({
  username,
  id,
  isModerator,
  sessionUserId,
  eventViewer = { id: sessionUserId },
  domain,
}: GetUserProfileSchema & {
  isModerator?: boolean;
  sessionUserId?: number;
  /**
   * Who the event preview gate is asked about: the request's `eventViewerOf`. Without one it is the
   * session user as a non-moderator, never `isModerator`, which a scoped token may carry.
   */
  eventViewer?: EventViewer;
  domain?: ColorDomain;
}) => {
  // Use write to get the latest most accurate user here since we'll need to create the profile
  // if it doesn't exist.
  if (!username && !id) {
    throwBadRequestError('Either username or id must be provided');
  }
  const viaKysely = await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_9);
  const getUser = async () => {
    // No blockedFor on the Prisma read: the servable-profile-picture extension already gated it.
    const { user, pictureBlockedFor } = viaKysely
      ? await readUserWithProfileAndPictureGateViaKysely(kyselyWrite, { id, username })
      : {
          user: await readUserWithProfileViaPrisma(dbWrite, { id, username }),
          pictureBlockedFor: null,
        };

    // Becuase this is a view, it might be slow and we prefer to get the stats in a separate query
    // Ideally, using dbRead.
    const stats = await dbRead.userStat.findFirst({
      where: {
        userId: user.id,
      },
      select: {
        downloadCountAllTime: true,
        thumbsUpCountAllTime: true,
        followerCountAllTime: true,
        reactionCountAllTime: true,
        uploadCountAllTime: true,
        generationCountAllTime: true,
      },
    });

    const { profile } = user;
    const userMeta = (user.meta ?? {}) as UserMeta;
    const sameUser = sessionUserId === user.id;
    const canEdit = !!isModerator || sameUser;

    const shapeCoverImage = (coverImage: NonNullable<typeof profile>['coverImage']) => {
      if (!coverImage) return null;
      const hidden = isModerator
        ? isRestrictedImage(coverImage)
        : !servableArticleImage(coverImage);
      if (!sameUser && hidden) return null;

      return {
        ...coverImage,
        meta: coverImage.meta as ImageMetaProps | null,
        metadata: coverImage.metadata as MixedObject,
        tags: coverImage.tags.map((t) => t.tag),
      };
    };

    const defaultCoverImage = shapeCoverImage(profile?.coverImage ?? null);
    const sfwCoverImage = shapeCoverImage(profile?.sfwCoverImage ?? null);

    const green = domain === 'green';
    const useSfwBio = green && profile?.sfwBio != null;
    const useSfwMessage = green && profile?.sfwMessage != null;
    const useSfwCoverImage = green && profile?.sfwCoverImageId != null;

    const creatorShopEnabled =
      (user.settings as { creatorShop?: { enabled?: boolean } } | null)?.creatorShop?.enabled ===
      true;

    // Only the fact, never the settings blob. The tab is hidden from visitors
    // when it is set — the book's own payload refuses the content separately, so
    // this decides a nav item and nothing else.
    const stickerBookHidden =
      (user.settings as { hideStickerBook?: boolean } | null)?.hideStickerBook === true;

    // The owner and moderators edit every section, so only other viewers lose the ones hidden on
    // this site, and with them the rows that place them.
    const showcaseSections = (profile?.showcaseSections ?? []) as ShowcaseSectionSchema[];
    const hiddenSectionKeys = new Set<string>(
      canEdit
        ? []
        : showcaseSections
            .filter((section) => isShowcaseHiddenOn(section.hiddenOn, domain))
            .map((section) => customShowcaseKey(section.id))
    );

    return {
      ...user,
      profilePicture: canEdit
        ? await withoutRestrictedPictureFor(
            sameUser,
            user.profilePicture ??
              (viaKysely ? null : await getProfilePictureOfUser(dbWrite, user.id))
          )
        : // A held picture is already dropped upstream for every viewer.
          servableProfilePicture(
            user.profilePicture,
            null,
            await isPictureModelRestricted(user.profilePicture),
            pictureBlockedFor
          ),
      // Claim keys are owner-only; withheld from every other viewer, moderators included.
      cosmetics: (await withoutHiddenEventDecorations(user.cosmetics, eventViewer)).map((c) => ({
        ...c,
        claimKey: sameUser ? c.claimKey : null,
      })),
      meta: undefined,
      // Never leak the private settings blob; expose only whether the shop is public.
      settings: undefined,
      creatorShopEnabled,
      stickerBookHidden,
      ...getUserBanDetails({
        meta: userMeta,
        isModerator: isModerator ?? false,
      }),
      stats: stats,
      profile: {
        ...profile,
        privacySettings: (profile?.privacySettings ?? {}) as PrivacySettingsSchema,
        profileSectionsSettings: (
          (profile?.profileSectionsSettings ?? []) as ProfileSectionSchema[]
        ).filter(({ key }) => !hiddenSectionKeys.has(key)),
        showcaseItems: (profile?.showcaseItems ?? []) as ShowcaseItemSchema[],
        showcaseSections: showcaseSections.filter(
          (section) => !hiddenSectionKeys.has(customShowcaseKey(section.id))
        ),
        bio: (useSfwBio ? profile?.sfwBio : profile?.bio) ?? null,
        message: (useSfwMessage ? profile?.sfwMessage : profile?.message) ?? null,
        messageAddedAt:
          (useSfwMessage ? profile?.sfwMessageAddedAt : profile?.messageAddedAt) ?? null,
        coverImageId: (useSfwCoverImage ? profile?.sfwCoverImageId : profile?.coverImageId) ?? null,
        coverImage: useSfwCoverImage ? sfwCoverImage : defaultCoverImage,
        // Both stored variants, for the profile editor only. A visitor on the green
        // domain must never receive the mature copy it is being shown instead of.
        defaultBio: canEdit ? profile?.bio ?? null : null,
        defaultMessage: canEdit ? profile?.message ?? null : null,
        defaultMessageAddedAt: canEdit ? profile?.messageAddedAt ?? null : null,
        defaultCoverImage: canEdit ? defaultCoverImage : null,
        sfwBio: canEdit ? profile?.sfwBio ?? null : null,
        sfwMessage: canEdit ? profile?.sfwMessage ?? null : null,
        sfwMessageAddedAt: canEdit ? profile?.sfwMessageAddedAt ?? null : null,
        sfwCoverImageId: canEdit ? profile?.sfwCoverImageId ?? null : null,
        sfwCoverImage: canEdit ? sfwCoverImage : null,
      },
    };
  };

  const user = await getUser();

  if (!user.profile?.userId) {
    // First time visit to this user's profile. Create base profile:
    await dbWrite.userProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
      },
      // Basically we wanna avoid a
      // racing condition where 2 users landed here and trigger
      // this at the same time.
      update: {},
      select: { userId: true },
    });

    return getUser();
  }

  return user;
};

const isSameShowcaseItem = (a: ShowcaseItemSchema, b: ShowcaseItemSchema) =>
  a.entityType === b.entityType && a.entityId === b.entityId;

// Items already on the stored showcase are not re-checked: a model can be transferred away after
// it was showcased, and refusing it would make the whole profile form unsaveable.
export const assertShowcaseItemsOwned = async ({
  userId,
  isModerator,
  showcaseItems,
  currentShowcaseItems,
  allowedTypes = ['Model', 'Image'],
}: {
  userId: number;
  isModerator?: boolean;
  showcaseItems: ShowcaseItemSchema[];
  currentShowcaseItems: ShowcaseItemSchema[];
  allowedTypes?: ShowcaseItemSchema['entityType'][];
}) => {
  const addedItems = showcaseItems.filter(
    (item) => !currentShowcaseItems.some((current) => isSameShowcaseItem(current, item))
  );
  if (!addedItems.length) return;

  if (addedItems.some((item) => !allowedTypes.includes(item.entityType)))
    throw throwBadRequestError(`Only ${allowedTypes.join(', ')} items can be added to a showcase`);

  const idsOf = (entityType: ShowcaseItemSchema['entityType']) => [
    ...new Set(
      addedItems.filter((item) => item.entityType === entityType).map((item) => item.entityId)
    ),
  ];
  const imageIds = idsOf('Image');
  const modelIds = idsOf('Model');
  const articleIds = idsOf('Article');

  // Moderators included: a taken-down model is shown to no visitor, so it never joins a showcase.
  if (
    modelIds.length &&
    // primary: a takedown moments ago must already be refused.
    (await dbWrite.model.count({
      where: { id: { in: modelIds }, mode: ModelModifier.TakenDown },
    }))
  )
    throw throwBadRequestError('A taken-down model cannot be showcased');

  if (isModerator) return;

  if (!(await ownsAllContent({ ownerId: userId, imageIds, modelIds, articleIds })))
    throw throwAuthorizationError('You can only add your own content to your showcase');
};

const toShowcaseItems = (sections: ShowcaseSectionSchema[]): ShowcaseItemSchema[] =>
  sections.flatMap(({ type, items }) => items.map((entityId) => ({ entityType: type, entityId })));

export const setShowcaseSections = async ({
  userId,
  sections,
  ifUnchangedFrom,
}: SetShowcaseSectionsSchema & {
  userId: number;
  /** Save only if the stored sections still equal these; refused as a conflict otherwise. */
  ifUnchangedFrom?: ShowcaseSectionSchema[];
}) => {
  await throwOnBlockedUserContent(
    sections.flatMap(({ title, button }) => [title, button?.label, button?.url]),
    { surface: 'userProfile', entityType: 'UserProfile', entityId: userId, userId }
  );

  const current = await dbWrite.userProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { showcaseSections: true },
  });

  // No moderator exemption: every item a save adds must be the saver's own. An item already
  // stored stays even if it has since changed owner.
  await assertShowcaseItemsOwned({
    userId,
    showcaseItems: toShowcaseItems(sections),
    currentShowcaseItems: toShowcaseItems(
      (current.showcaseSections ?? []) as ShowcaseSectionSchema[]
    ),
    allowedTypes: [...showcaseSectionTypes],
  });

  let saved: ShowcaseSectionSchema[];
  if (ifUnchangedFrom) {
    const { count } = await dbWrite.userProfile.updateMany({
      where: { userId, showcaseSections: { equals: ifUnchangedFrom } },
      data: { showcaseSections: sections },
    });
    if (!count) throw throwConflictError('Your showcase changed while saving. Try again.');
    saved = sections;
  } else {
    const updated = await dbWrite.userProfile.update({
      where: { userId },
      data: { showcaseSections: sections },
      select: { showcaseSections: true },
    });
    saved = updated.showcaseSections as ShowcaseSectionSchema[];
  }
  // Every save. scanEntity skips the submit when the profile's combined text hashes the same as
  // its last successful scan, or as one still in flight.
  queueScamScan({ entityType: 'UserProfile', entityId: userId });

  return saved;
};

// One answer for "not yours" and "can't be shown", so the reply says nothing about another user's
// item.
const isOwnServableItem = async ({
  userId,
  entityType,
  entityId,
}: Pick<AddToShowcaseSectionSchema, 'entityType' | 'entityId'> & { userId: number }) => {
  const select = { id: true } as const;
  switch (entityType) {
    case 'Image':
      // primary: an item published moments ago is the likeliest to be added.
      return !!(await dbWrite.image.findFirst({
        where: {
          id: entityId,
          userId,
          ...publishedImageWhere(),
          ingestion: { notIn: [ImageIngestionStatus.Blocked, ImageIngestionStatus.NotFound] },
        },
        select,
      }));
    case 'Model':
      // primary: an item published moments ago is the likeliest to be added.
      return !!(await dbWrite.model.findFirst({
        where: {
          id: entityId,
          userId,
          status: ModelStatus.Published,
          deletedAt: null,
          tosViolation: false,
          availability: { not: Availability.Private },
          // No modifier: the section feed drops Archived, so one would take a slot and never show.
          mode: null,
        },
        select,
      }));
    case 'Article':
      // Pending/Rescan pass: the section's feed shows other viewers only Scanned articles.
      // primary: an item published moments ago is the likeliest to be added.
      return !!(await dbWrite.article.findFirst({
        where: {
          id: entityId,
          userId,
          status: ArticleStatus.Published,
          publishedAt: { lte: new Date() },
          tosViolation: false,
          ingestion: { not: ArticleIngestionStatus.Blocked },
          availability: { not: Availability.Private },
        },
        select,
      }));
  }
};

const notShowableMessage: Record<AddToShowcaseSectionSchema['entityType'], string> = {
  Image: 'Only your own images in a published post can be showcased',
  Model: 'Only your own published models can be showcased',
  Article: 'Only your own published articles can be showcased',
};

/** Adds one of the caller's items to the front of one of their sections of its type. */
export const addToShowcaseSection = async ({
  userId,
  sectionId,
  entityType,
  entityId,
}: AddToShowcaseSectionSchema & { userId: number }) => {
  // primary: the sections read here are written back whole below.
  const profile = await dbWrite.userProfile.findUnique({
    where: { userId },
    select: { showcaseSections: true },
  });
  const sections = (profile?.showcaseSections ?? []) as ShowcaseSectionSchema[];
  const section = sections.find((s) => s.id === sectionId && s.type === entityType);
  if (!section) throw throwNotFoundError('Showcase section not found');
  if (section.items.includes(entityId)) return { added: false, sections };
  if (section.items.length >= showcaseSectionLimits.items)
    throw throwBadRequestError(
      `This section is full: it holds up to ${showcaseSectionLimits.items} items`
    );

  if (!(await isOwnServableItem({ userId, entityType, entityId })))
    throw throwBadRequestError(notShowableMessage[entityType]);

  const updated = await setShowcaseSections({
    userId,
    sections: sections.map((s) => (s === section ? { ...s, items: [entityId, ...s.items] } : s)),
    ifUnchangedFrom: sections,
  });
  return { added: true, sections: updated };
};

export const updateUserProfile = async ({
  // profileImage,
  isModerator,
  socialLinks,
  sponsorshipLinks,
  // badgeId,
  // nameplateId,
  userId,
  coverImage,
  sfwCoverImage,
  // leaderboardShowcase,
  // profilePicture,
  creatorCardStatsPreferences,
  domain,
  sessionUserId,
  ...profile
}: UserProfileUpdateSchema & {
  userId: number;
  isModerator?: boolean;
  domain?: ColorDomain;
  /** Who saved it: a moderator may save another user's profile, and is answered as a viewer. */
  sessionUserId: number;
}) => {
  // Both domain variants, not just the field being edited: the SFW override and the field it
  // overrides are independently writable and independently rendered, so checking one leaves the
  // other as an unchecked way to put the same text on a profile page.
  //
  // 🔴 `isModerator` is load-bearing here, not decoration. `updateUserProfileHandler` routes a
  // moderator to ANOTHER user's profile, and this form round-trips every stored field — so
  // without it, a moderator clearing a spam bio is refused over a field they were not editing,
  // and no path through this service can clear it. The guard would block the cleanup it exists
  // to prompt.
  await throwOnBlockedUserContent(
    [
      profile.bio,
      profile.sfwBio,
      profile.message,
      profile.sfwMessage,
      profile.location,
      ...(socialLinks?.map((link) => link.url) ?? []),
      ...(sponsorshipLinks?.map((link) => link.url) ?? []),
    ],
    { isModerator, surface: 'userProfile', entityType: 'UserProfile', entityId: userId, userId }
  );

  // `sessionUserId` is what populates the `default*`/`sfw*` fields compared below — they are
  // withheld from anyone who can't edit the profile. Drop it and both read back null, so every
  // save looks like a changed announcement and re-stamps `messageAddedAt`.
  const current = await getUserWithProfile({ id: userId, sessionUserId: userId }); // Ensures user exists && has a profile record.

  // A `custom:<id>` row only places a section that exists. A user who never had the flag has
  // none, so none of their rows survive.
  if (profile.profileSectionsSettings) {
    const sectionKeys = new Set(
      ((current.profile?.showcaseSections ?? []) as ShowcaseSectionSchema[]).map((s) =>
        customShowcaseKey(s.id)
      )
    );
    profile.profileSectionsSettings = profile.profileSectionsSettings.filter(
      ({ key }) => !key.startsWith(customShowcaseKeyPrefix) || sectionKeys.has(key as never)
    );
  }

  if (profile.showcaseItems)
    await assertShowcaseItemsOwned({
      userId,
      // A moderator may curate another user's showcase, never fill their own with others' items.
      isModerator: isModerator && sessionUserId !== userId,
      showcaseItems: profile.showcaseItems,
      currentShowcaseItems: (current.profile?.showcaseItems ?? []) as ShowcaseItemSchema[],
    });

  // A cover with no `id` is created from its client url below. Checked before any write, so a
  // refused cover leaves the whole save unapplied.
  const newCoverUrls = [coverImage, sfwCoverImage].map((image) =>
    image && !image.id ? image.url : null
  );
  await assertClientImageUrlsUsable({ urls: newCoverUrls, userId });
  await assertClientKeysIssuedToCaller({
    urls: newCoverUrls,
    userId,
    alsoIssuedTo: sessionUserId,
  });

  // We can safely update creatorCardStatsPreferences out of the transaction as it's not critical
  if (creatorCardStatsPreferences) {
    // Parameterised: the payload is bound, not spliced into a string literal.
    // `JSON.stringify` escapes `"` and `\` but not `'`, so a preference value holding an
    // apostrophe used to close the literal early and corrupt the statement — the write
    // then failed instead of being stored. `creatorCardStatsPreferences` is
    // `z.array(z.string()).max(3)` on `userProfileUpdateSchema`, so the strings arrive
    // here exactly as the caller sent them.
    await dbWrite.$executeRaw`
        UPDATE "User"
        SET "publicSettings" = jsonb_set(
          "publicSettings",
          '{creatorCardStatsPreferences}',
          ${JSON.stringify(creatorCardStatsPreferences)}::jsonb
        )
        WHERE "id" = ${userId}`;

    userUpdateCounter?.inc({ location: 'user-profile.service:updateProfile' });
  }

  const buildCoverImageUpdate = (image: UserProfileUpdateSchema['coverImage']) =>
    image !== undefined && !image?.id
      ? image === null
        ? { disconnect: true }
        : {
            connectOrCreate: {
              where: { id: image.id ?? -1 },
              create: {
                ...pickClientImageColumns(image),
                meta:
                  (sanitizeProvenance(image?.meta as Record<string, unknown> | null | undefined) as
                    | Prisma.JsonObject
                    | undefined) ?? Prisma.JsonNull,
                metadata: { coverImage: true, userId },
                userId,
                resources: undefined,
              },
            },
          }
      : undefined;

  const updatedCoverImages = await dbWrite.$transaction(
    async (tx) => {
      // const shouldUpdateCosmetics = badgeId !== undefined || nameplateId !== undefined;
      // const payloadCosmeticIds: number[] = [];

      // if (badgeId) payloadCosmeticIds.push(badgeId);
      // if (nameplateId) payloadCosmeticIds.push(nameplateId);

      // const shouldUpdateUser = shouldUpdateCosmetics || profileImage || leaderboardShowcase;

      // if (shouldUpdateUser) {
      //   await tx.user.update({
      //     where: {
      //       id: userId,
      //     },
      //     data: {
      //       image: profileImage,
      //       leaderboardShowcase,
      //       profilePicture:
      //         profilePicture === null
      //           ? { delete: true }
      //           : profilePicture
      //           ? {
      //               delete: true,
      //               upsert: {
      //                 where: { id: profilePicture.id },
      //                 update: {
      //                   ...profilePicture,
      //                   userId,
      //                 },
      //                 create: {
      //                   ...profilePicture,
      //                   userId,
      //                 },
      //               },
      //             }
      //           : undefined,
      //     },
      //   });

      //   if (shouldUpdateCosmetics) await equipCosmetic({ userId, cosmeticId: payloadCosmeticIds });

      //   if (leaderboardShowcase !== undefined) {
      //     await updateLeaderboardRank({ userIds: userId });
      //   }
      // }

      const links = [...(socialLinks ?? []), ...(sponsorshipLinks ?? [])];

      if (socialLinks !== undefined || sponsorshipLinks !== undefined) {
        await tx.userLink.deleteMany({
          where: {
            userId,
            id: {
              not: {
                in: links.map((l) => l.id).filter(isDefined),
              },
            },
          },
        });

        const parsed = links.map(({ url, id, type }) => ({
          type,
          url,
          userId,
          id,
        }));

        const toCreate = parsed.filter((x) => !x.id);
        const toUpdate = parsed.filter((x) => !!x.id);

        if (toCreate.length) {
          await tx.userLink.createMany({ data: toCreate });
        }

        if (toUpdate.length) {
          await Promise.all(
            toUpdate.map(
              async (userLink) =>
                await tx.userLink.updateMany({
                  where: { id: userLink.id, userId },
                  data: userLink,
                })
            )
          );
        }
      }

      const updatedProfile = await tx.userProfile.update({
        select: {
          userId: true,
          coverImage: { select: { id: true, url: true, ingestion: true, type: true } },
          sfwCoverImage: { select: { id: true, url: true, ingestion: true, type: true } },
        },
        where: { userId },
        data: {
          ...profile,
          messageAddedAt:
            profile.message === undefined || profile.message === current?.profile?.defaultMessage
              ? undefined
              : profile.message
              ? new Date()
              : null,
          sfwMessageAddedAt:
            profile.sfwMessage === undefined || profile.sfwMessage === current?.profile?.sfwMessage
              ? undefined
              : profile.sfwMessage
              ? new Date()
              : null,
          coverImage: buildCoverImageUpdate(coverImage),
          sfwCoverImage: buildCoverImageUpdate(sfwCoverImage),
        },
      });

      return updatedProfile;
    },
    {
      timeout: 15000,
    }
  );

  // Ingest the cover image AFTER the transaction commits. ingestImage makes a
  // blocking external HTTP call to the image scanner; keeping it inside the
  // interactive transaction held the txn open past its 15s timeout whenever the
  // scanner was slow ("Transaction already closed: a commit cannot be executed
  // on an expired transaction"). Ingestion only needs the committed Image row,
  // not transactional atomicity with the profile write.
  //
  // Fire-and-forget on purpose: the profile is already saved, so a scanner
  // outage must NOT bubble up as "error updating your profile" on a successful
  // save. Recovery is guaranteed independently — the `trg_image_scan_queue`
  // trigger enqueues an ImageScan JobQueue row on the Pending insert, which the
  // `ingest-images` sweeper drains, so the cover image still gets scanned even
  // if this inline enqueue fails.
  const pendingCoverImages = [updatedCoverImages.coverImage, updatedCoverImages.sfwCoverImage]
    .filter(isDefined)
    .filter((image) => image.ingestion === ImageIngestionStatus.Pending);
  if (pendingCoverImages.length) {
    enqueueImageIngestion({
      images: pendingCoverImages,
      name: 'user-profile-cover-ingest',
      userId,
    });
  }

  await usersSearchIndex.queueUpdate([{ id: userId, action: SearchIndexUpdateQueueAction.Update }]);
  if (
    [profile.bio, profile.message, profile.sfwBio, profile.sfwMessage].some((v) => v !== undefined)
  )
    queueScamScan({ entityType: 'UserProfile', entityId: userId });

  return getUserWithProfile({ id: userId, sessionUserId, domain });
};

/**
 * A profile picture's `modelRestricted`, read only for a mature one: `profilePictureOf` drops the
 * flag the Kysely row selects.
 */
async function isPictureModelRestricted(picture: { id: number; nsfwLevel: number } | null) {
  if (!picture || (picture.nsfwLevel & nsfwBrowsingLevelsFlag) === 0) return false;
  const image = await dbRead.image.findUnique({
    where: { id: picture.id },
    select: { modelRestricted: true },
  });
  return image?.modelRestricted ?? true;
}

/** Null for a restricted picture unless `sameUser`: a moderator never sees one. */
async function withoutRestrictedPictureFor<T extends { id: number; nsfwLevel: number }>(
  sameUser: boolean,
  picture: T | null
) {
  if (sameUser || !(await isPictureModelRestricted(picture))) return picture;
  return null;
}
