import type { ColorDomain } from '~/shared/constants/domain.constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  ProfilePageTheme,
  UserProfileUpdateSchema,
} from '~/server/schema/user-profile.schema';
import * as z from 'zod';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import {
  profilePageThemeSchema,
  profilePinnedItemsLimit,
  showcaseItemSchema,
} from '~/server/schema/user-profile.schema';
import { isMemberTier, isMemberTierCached } from '~/server/services/subscriptions.service';
import { isImageOwner } from '~/server/services/util.service';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import { Flags } from '~/shared/utils/flags';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { servableArticleImage } from '~/shared/utils/article-card-image';
import { isRestrictedImage } from '~/shared/utils/restricted-image';

const MEMBERS_ONLY = 'Page backgrounds and card colours are for members';

const backgroundImageSelect = {
  id: true,
  url: true,
  type: true,
  hash: true,
  width: true,
  height: true,
  nsfwLevel: true,
  ingestion: true,
  needsReview: true,
  modelRestricted: true,
} as const;

/**
 * Refuses a save that touches the redesign's page fields without the flag, and one that sets a
 * background, colour or opacity a non-member did not already have. Values already stored pass, so
 * a lapsed member can still save the rest of their profile; clearing always passes.
 */
export async function assertPageCustomizationAllowed({
  userId,
  profileRedesign,
  backgroundImage,
  sfwBackgroundImage,
  pageTheme,
  about,
}: Pick<
  UserProfileUpdateSchema,
  'backgroundImage' | 'sfwBackgroundImage' | 'pageTheme' | 'about'
> & {
  userId: number;
  profileRedesign: boolean;
}) {
  const touched = [backgroundImage, sfwBackgroundImage, pageTheme, about].some(
    (value) => value !== undefined
  );
  if (!touched) return;
  if (!profileRedesign) throw throwAuthorizationError('Profile customization is not available');

  // primary: compared with the save that follows it.
  const stored = await dbWrite.userProfile.findUnique({
    where: { userId },
    select: {
      backgroundImageId: true,
      sfwBackgroundImageId: true,
      pageTheme: true,
    },
  });
  const setsImage = (
    image: UserProfileUpdateSchema['backgroundImage'],
    storedId: number | null | undefined
  ) => !!image && image.id !== storedId;
  // A theme colour counts as set only where it differs from what is stored for that theme.
  const storedTheme = parsePageTheme(stored?.pageTheme);
  const setsTheme =
    (['dark', 'light'] as const).some((mode) => {
      const next = pageTheme?.[mode];
      const prev = storedTheme?.[mode];
      return !!next && (next.color !== prev?.color || next.opacity !== prev?.opacity);
    }) ||
    (!!pageTheme?.sidebar && pageTheme.sidebar.color !== storedTheme?.sidebar?.color);

  const raises =
    setsImage(backgroundImage, stored?.backgroundImageId) ||
    setsImage(sfwBackgroundImage, stored?.sfwBackgroundImageId) ||
    setsTheme;
  if (raises && !(await isMemberTier(userId))) throw throwAuthorizationError(MEMBERS_ONLY);
}

/** "Set as background": one of the owner's own images, never another user's, even for a moderator. */
export async function setProfileBackground({
  userId,
  imageId,
  domain,
}: {
  userId: number;
  imageId: number;
  domain?: ColorDomain;
}) {
  if (!(await isImageOwner({ userId, imageId, allowMods: false })))
    throw throwNotFoundError('Image not found');
  if (!(await isMemberTier(userId))) throw throwAuthorizationError(MEMBERS_ONLY);

  // On civitai.com it sets the civitai.com override, as the customizer's own field there does.
  const column = domain === 'green' ? 'sfwBackgroundImageId' : 'backgroundImageId';
  await dbWrite.userProfile.upsert({
    where: { userId },
    create: { userId, [column]: imageId },
    update: { [column]: imageId },
    select: { userId: true },
  });
}

export type ProfileCustomization = Awaited<ReturnType<typeof getProfileCustomization>>;

/**
 * The redesign's page customisation as this viewer may see it. Everything is null unless the
 * owner is a member now: lapsed values are kept, not shown. The background is the one for this
 * domain, withheld while unservable or outside the viewer's browsing level (owners still see
 * their own), and on civitai.com dropped unless it is SFW, so its url never reaches a page that
 * may not show it.
 */
export async function getProfileCustomization({
  userId,
  viewerId,
  isModerator,
  domain,
  browsingLevel = publicBrowsingLevelsFlag,
}: {
  userId: number;
  viewerId?: number;
  isModerator?: boolean;
  domain?: ColorDomain;
  browsingLevel?: number;
}) {
  const sameUser = viewerId === userId;
  // primary: only for the owner, whose save is read back at once.
  const profile = await (sameUser ? dbWrite : dbRead).userProfile.findUnique({
    where: { userId },
    select: {
      backgroundImageId: true,
      sfwBackgroundImageId: true,
      pageTheme: true,
      backgroundImage: { select: backgroundImageSelect },
      sfwBackgroundImage: { select: backgroundImageSelect },
    },
  });
  const empty = {
    background: null,
    pageTheme: null as ProfilePageTheme | null,
    // The customizer's own values; only for someone who can edit the profile.
    stored: null,
  };
  if (!profile) return empty;
  const pageTheme = parsePageTheme(profile.pageTheme);

  const isSet =
    profile.backgroundImageId != null || profile.sfwBackgroundImageId != null || !!pageTheme;
  if (!isSet) return empty;

  const canEdit = sameUser || !!isModerator;
  // A moderator editing someone else's profile is not shown a restricted image, as with the cover.
  const editable = <T extends { nsfwLevel: number; modelRestricted: boolean | null }>(
    image: T | null
  ) => (image && !sameUser && isRestrictedImage(image) ? null : image);
  const stored = canEdit
    ? {
        backgroundImage: editable(profile.backgroundImage),
        sfwBackgroundImage: editable(profile.sfwBackgroundImage),
        pageTheme,
      }
    : null;

  // Fail closed: a failed membership lookup hides the values rather than failing the page.
  const member = await (sameUser ? isMemberTier : isMemberTierCached)(userId).catch(() => false);
  if (!member) return { ...empty, stored };

  const green = domain === 'green';
  const image =
    green && profile.sfwBackgroundImageId != null
      ? profile.sfwBackgroundImage
      : profile.backgroundImage;
  const visible = (() => {
    if (!image) return null;
    if (green && !Flags.intersects(image.nsfwLevel, sfwBrowsingLevelsFlag)) return null;
    if (sameUser) return image;
    // No blur to reveal a backdrop behind, so one outside the viewer's level is not sent at all.
    if (!Flags.intersects(image.nsfwLevel, browsingLevel)) return null;
    const hidden = isModerator ? isRestrictedImage(image) : !servableArticleImage(image);
    return hidden ? null : image;
  })();

  return {
    background: visible,
    pageTheme,
    stored,
  };
}

/** The About tab's text and pinned items: kept out of the main profile read, which every visitor pays for. */
export async function getProfileAbout({ userId, viewerId }: { userId: number; viewerId?: number }) {
  // primary: only for the owner, whose save is read back at once.
  const profile = await (viewerId === userId ? dbWrite : dbRead).userProfile.findUnique({
    where: { userId },
    select: { about: true, pinnedItems: true },
  });
  return { about: profile?.about ?? null, pinnedItems: parsePinnedItems(profile?.pinnedItems) };
}

/**
 * Which of a profile's images a moderator editing it is not shown (restricted, as the cover and
 * background reads withhold them). Their editor holds null for those, so a null saved back from it
 * means "unchanged", not "cleared".
 */
export async function imagesHiddenFromModerator(userId: number) {
  const select = { select: { nsfwLevel: true, modelRestricted: true } } as const;
  // primary: compared with the save that follows it.
  const profile = await dbWrite.userProfile.findUnique({
    where: { userId },
    select: {
      coverImage: select,
      sfwCoverImage: select,
      backgroundImage: select,
      sfwBackgroundImage: select,
    },
  });
  const hidden = (image: { nsfwLevel: number; modelRestricted: boolean | null } | null) =>
    !!image && isRestrictedImage(image);
  return {
    coverImage: hidden(profile?.coverImage ?? null),
    sfwCoverImage: hidden(profile?.sfwCoverImage ?? null),
    backgroundImage: hidden(profile?.backgroundImage ?? null),
    sfwBackgroundImage: hidden(profile?.sfwBackgroundImage ?? null),
  };
}

/** A stored theme, or null when it is missing or not the shape the schema allows. */
function parsePageTheme(value: unknown): ProfilePageTheme | null {
  const parsed = profilePageThemeSchema.safeParse(value);
  const { dark, light, sidebar } = parsed.success ? parsed.data : {};
  return parsed.success && (dark || light || sidebar) ? parsed.data : null;
}

/** A stored pinned list, keeping only entries of the allowed shape, at most the limit. */
export function parsePinnedItems(value: unknown): ShowcaseItemSchema[] {
  const parsed = z.array(showcaseItemSchema).safeParse(value);
  return parsed.success
    ? parsed.data
        .filter((item) => item.entityType === 'Image' || item.entityType === 'Model')
        .slice(0, profilePinnedItemsLimit)
    : [];
}
