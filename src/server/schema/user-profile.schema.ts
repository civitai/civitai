import * as z from 'zod';
import { showcaseHiddenOnMask } from '~/shared/constants/profile-showcase.constants';
import { constants } from '~/server/common/constants';
import { imageReferenceInputSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
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
  Recent: 'recent',
} as const;

export type ProfileSectionType = (typeof ProfileSectionTypeDef)[keyof typeof ProfileSectionTypeDef];

export type ProfileSectionSchema = z.infer<typeof profileSectionSchema>;

export const customShowcaseKeyPrefix = 'custom:';
export type CustomShowcaseKey = `custom:${string}`;
export const customShowcaseKey = (id: string) =>
  `${customShowcaseKeyPrefix}${id}` as CustomShowcaseKey;

export const profileSectionWidths = ['full', 'half'] as const;
export type ProfileSectionWidth = (typeof profileSectionWidths)[number];

export const profileSectionSchema = z.object({
  // A custom showcase section is placed by `custom:<ShowcaseSection.id>`.
  key: z.union([
    z.enum(ProfileSectionTypeDef),
    z.custom<CustomShowcaseKey>(
      (key) => typeof key === 'string' && /^custom:[A-Za-z0-9_-]{1,32}$/.test(key)
    ),
  ]),
  enabled: z.boolean(),
  width: z.enum(profileSectionWidths).optional(),
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
  /** `ShowcaseHiddenOn` bits: the sites this section is not shown on. */
  hiddenOn: z
    .number()
    .int()
    .min(0)
    .refine((bits) => (bits & ~showcaseHiddenOnMask) === 0, 'Unknown site')
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

export type AddToShowcaseSectionSchema = z.infer<typeof addToShowcaseSectionSchema>;
export const addToShowcaseSectionSchema = z.object({
  sectionId: showcaseSectionSchema.shape.id,
  entityType: z.enum(showcaseSectionTypes),
  entityId: z.number().int().positive(),
});

export type ShowcaseItemSchema = z.infer<typeof showcaseItemSchema>;

export const showcaseItemSchema = z.object({
  entityType: z.enum(SearchIndexEntityTypes),
  entityId: z.number(),
});

export const profileAboutMaxLength = 5000;
const profileAboutAllowedTags = [
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'strong',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'code',
];
export const profileCardOpacityDefault = 80;

/** Profile tabs an owner may hide; Overview and Shop always show. */
export const profileHideableTabs = [
  'models',
  'posts',
  'images',
  'videos',
  '3d-models',
  'articles',
  'comics',
  'storylines',
  'apps',
  'achievements',
  'collections',
  'sticker-book',
] as const;
export type ProfileHideableTab = (typeof profileHideableTabs)[number];

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
  // Profile tabs hidden from visitors' nav. The pages themselves still resolve.
  hiddenTabs: z.array(z.enum(profileHideableTabs)).max(profileHideableTabs.length).optional(),
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
  // Profile redesign. Background, card colour and opacity are members only; `null` clears.
  backgroundImage: imageReferenceInputSchema.nullish(),
  sfwBackgroundImage: imageReferenceInputSchema.nullish(),
  cardColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullish(),
  cardOpacity: z.number().int().min(60).max(100).nullish(),
  // Text only: media here would never be scanned or rated, and shows on every domain.
  about: getSanitizedStringSchema({ allowedTags: profileAboutAllowedTags })
    .refine((html) => html.length <= profileAboutMaxLength, 'Your About text is too long')
    .nullish(),
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

export type SetProfileBackgroundSchema = z.infer<typeof setProfileBackgroundSchema>;
export const setProfileBackgroundSchema = z.object({ imageId: z.number().int().positive() });

export type GetProfilePartSchema = z.infer<typeof getProfilePartSchema>;
export const getProfilePartSchema = z.object({ userId: z.number().int().positive() });

export type GetProfileCustomizationSchema = z.infer<typeof getProfileCustomizationSchema>;
export const getProfileCustomizationSchema = getProfilePartSchema.extend({
  // The viewer's browsing level: a background outside it is not sent.
  browsingLevel: z.number().int().min(0).optional(),
});
