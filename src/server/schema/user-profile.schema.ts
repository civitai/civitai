import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { imageReferenceInputSchema } from '~/server/schema/image.schema';
import { SearchIndexEntityTypes } from '~/components/Search/parsers/base';
import { LinkType } from '~/shared/utils/prisma/enums';
import { creatorCardStatsPreferences, profilePictureSchema } from './user.schema';

export type GetUserProfileSchema = z.infer<typeof getUserProfileSchema>;
export const getUserProfileSchema = z
  .object({
    // Reject an empty-string username at the input boundary. A profile page renders
    // `userProfile.get`/`userProfile.overview` before the username route param resolves,
    // sending `{ username: '' }`; that used to reach the service, fail the falsy
    // `!username && !id` guard, and surface as a raw 500. An empty/absent username is
    // invalid INPUT — reject it here so tRPC returns BAD_REQUEST (400).
    username: z.string().min(1).optional(),
    id: z.number().optional(),
  })
  .refine((d) => (d.username != null && d.username.length > 0) || d.id != null, {
    message: 'username or id required',
  });

export const ProfileSectionTypeDef = {
  Showcase: 'showcase',
  PopularModels: 'popularModels',
  PopularArticles: 'popularArticles',
  ModelsOverview: 'modelsOverview',
  ImagesOverview: 'imagesOverview',
  RecentReviews: 'recentReviews',
  Shop: 'shop',
  OnSale: 'onSale',
  CreatorJourney: 'creatorJourney',
} as const;

export type ProfileSectionType = (typeof ProfileSectionTypeDef)[keyof typeof ProfileSectionTypeDef];

export type ProfileSectionSchema = z.infer<typeof profileSectionSchema>;

export const customShowcaseKeyPrefix = 'custom:';
export type CustomShowcaseKey = `custom:${string}`;
export const customShowcaseKey = (id: string) =>
  `${customShowcaseKeyPrefix}${id}` as CustomShowcaseKey;

export const profileSectionSchema = z.object({
  // A custom showcase section is placed by `custom:<ShowcaseSection.id>`.
  key: z.union([
    z.enum(ProfileSectionTypeDef),
    z.custom<CustomShowcaseKey>(
      (key) => typeof key === 'string' && /^custom:[A-Za-z0-9_-]{1,32}$/.test(key)
    ),
  ]),
  enabled: z.boolean(),
});

export const showcaseSectionTypes = ['Model', 'Article', 'Image'] as const;
export type ShowcaseSectionType = (typeof showcaseSectionTypes)[number];

export const showcaseSectionLimits = {
  sections: 10,
  items: 32,
  title: 60,
  buttonLabel: 30,
} as const;

// A site path ("/models/1") or an absolute https URL. Anything else — javascript:, data:, http:,
// a protocol-relative "//host" — is refused.
export const isShowcaseButtonUrl = (url: string) => {
  // Browsers drop tabs and newlines from a URL, so "/\t/evil.com" navigates to "//evil.com".
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return false;
  if (url.startsWith('/')) return !url.startsWith('//') && !url.includes('\\');
  try {
    const parsed = new URL(url);
    // "https://civitai.com@evil.example" reads as civitai but goes to evil.example.
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

export type ShowcaseSectionSchema = z.infer<typeof showcaseSectionSchema>;
export const showcaseSectionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  type: z.enum(showcaseSectionTypes),
  title: z.string().trim().min(1).max(showcaseSectionLimits.title),
  items: z
    .array(z.number().int().positive())
    .max(showcaseSectionLimits.items)
    .refine((items) => new Set(items).size === items.length, 'Duplicate items'),
  button: z
    .object({
      label: z.string().trim().min(1).max(showcaseSectionLimits.buttonLabel),
      url: z.string().trim().max(2048).refine(isShowcaseButtonUrl, {
        message: 'Link must be a civitai.com path or an https:// URL',
      }),
    })
    .optional(),
});

/** The user-authored text of showcase sections: titles, button labels and links. */
export const showcaseSectionsText = (sections: unknown) =>
  ((sections ?? []) as ShowcaseSectionSchema[])
    .flatMap(({ title, button }) => [title, button?.label, button?.url])
    .filter(Boolean)
    .join('\n');

export type SetShowcaseSectionsSchema = z.infer<typeof setShowcaseSectionsSchema>;
export const setShowcaseSectionsSchema = z.object({
  sections: z
    .array(showcaseSectionSchema)
    .max(showcaseSectionLimits.sections)
    .refine(
      (sections) => new Set(sections.map((s) => s.id)).size === sections.length,
      'Duplicate section ids'
    ),
});

export type ShowcaseItemSchema = z.infer<typeof showcaseItemSchema>;

export const showcaseItemSchema = z.object({
  entityType: z.enum(SearchIndexEntityTypes),
  entityId: z.number(),
});

export type PrivacySettingsSchema = z.infer<typeof privacySettingsSchema>;

export const privacySettingsSchema = z.object({
  showLocation: z.boolean().optional(),
  showFollowers: z.boolean().optional(),
  showFollowing: z.boolean().optional(),
  showRating: z.boolean().optional(),
  showBadges: z.boolean().optional(),
  // Default on: shown unless explicitly false.
  showScoreSplit: z.boolean().optional(),
  // Ordered cosmetic ids of badges the user pinned to the top of their profile.
  highlightedBadgeIds: z.array(z.number()).optional(),
  // Cosmetic ids of badges the user chose not to display on their profile.
  hiddenBadgeIds: z.array(z.number()).optional(),
});

export type UserProfileUpdateSchema = z.infer<typeof userProfileUpdateSchema>;
export const userProfileUpdateSchema = z.object({
  userId: z.number().optional(),
  showcaseItems: z.array(showcaseItemSchema).max(constants.profile.showcaseItemsLimit).optional(),
  profileSectionsSettings: z.array(profileSectionSchema).optional(),
  privacySettings: privacySettingsSchema.optional(),
  message: z.string().nullish(),
  bio: z.string().nullish(),
  location: z.string().max(100).nullish(),
  // profileImage: z.string().nullish(),
  // profilePicture: profilePictureSchema.nullish(),
  coverImage: imageReferenceInputSchema.nullish(),
  // SFW (civitai.com) overrides. `null` clears the override and re-inherits the
  // field above; an empty string is a deliberate blank on the green domain.
  sfwMessage: z.string().nullish(),
  sfwBio: z.string().nullish(),
  sfwCoverImage: imageReferenceInputSchema.nullish(),
  socialLinks: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
        type: z.enum(LinkType),
      })
    )
    .optional(),
  sponsorshipLinks: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.string(),
        type: z.enum(LinkType),
      })
    )
    .optional(),
  creatorCardStatsPreferences: creatorCardStatsPreferences.optional(),
});
