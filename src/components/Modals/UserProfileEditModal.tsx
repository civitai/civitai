import type { ChipProps } from '@mantine/core';
import {
  Box,
  Button,
  Center,
  Chip,
  CloseButton,
  Divider,
  Group,
  Input,
  Loader,
  Paper,
  Popover,
  Stack,
  Switch,
  Text,
  Modal,
} from '@mantine/core';
import React, { useEffect, useMemo, useRef } from 'react';
import { trpc } from '~/utils/trpc';
import {
  Form,
  InputInlineSocialLinkInput,
  InputProfileImageUpload,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
  InputSelect,
  InputCosmeticSelect,
  InputChipGroup,
} from '~/libs/form';
import type {
  ProfileSectionSchema,
  PrivacySettingsSchema,
} from '~/server/schema/user-profile.schema';
import { userProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconExclamationMark, IconInfoCircle } from '@tabler/icons-react';
import {
  constants,
  creatorCardMaxStats,
  creatorCardStats,
  creatorCardStatsDefaults,
} from '~/server/common/constants';
import { CosmeticType, LinkType } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import type {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  NamePlateCosmetic,
  ProfileBackgroundCosmetic,
} from '~/server/selectors/cosmetic.selector';
import { getDisplayName, titleCase } from '~/utils/string-helpers';
import type { UserWithProfile } from '~/types/router';
import type { UserPublicSettingsSchema } from '~/server/schema/user.schema';
import { userUpdateSchema } from '~/server/schema/user.schema';
import { isEqual } from 'lodash-es';
import { ProfilePictureAlert } from '../User/ProfilePictureAlert';
import { cosmeticInputSchema } from '~/server/schema/cosmetic.schema';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { isDefined } from '~/utils/type-guards';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputProfileSectionsSettingsInput } from '~/components/Profile/ProfileSectionsSettingsInput';
import { InputShowcaseItemsInput } from '~/components/Profile/ShowcaseItemsInput';

const schema = z.object({
  ...userProfileUpdateSchema.shape,
  ...userUpdateSchema.pick({
    profilePicture: true,
    nameplateId: true,
    leaderboardShowcase: true,
  }).shape,
  badge: cosmeticInputSchema.nullish(),
  profileImage: z.string().nullish(),
  profileDecoration: cosmeticInputSchema.nullish(),
  profileBackground: cosmeticInputSchema.nullish(),
});

const chipProps: Partial<ChipProps> = {
  size: 'sm',
  radius: 'xl',
  variant: 'filled',
  tt: 'capitalize',
};

type FormDataSchema = z.infer<typeof schema>;

export default function UserProfileEditModal() {
  const dialog = useDialogContext();

  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();

  // Keep track of old data to compare and make only the necessary requests
  const previousData = useRef<FormDataSchema>();

  const { data: leaderboards = [], isLoading: loadingLeaderboards } =
    trpc.leaderboard.getLeaderboards.useQuery(undefined, {
      trpc: { context: { skipBatch: true } },
    });

  const { mutate, isLoading: isUpdating } = trpc.userProfile.update.useMutation({
    onSuccess: (data) => {
      if (currentUser) {
        utils.userProfile.get.setData({ username: currentUser.username }, data);
        utils.userProfile.get.invalidate({ username: currentUser.username });
      }
      showSuccessNotification({ message: 'Profile updated successfully' });
      dialog.onClose();
    },
    onError: async (error) => {
      showErrorNotification({
        title: 'There was an error updating your profile',
        error: new Error(error.message),
      });
    },
  });
  const updateUserMutation = trpc.user.update.useMutation({
    onSuccess: async () => {
      if (currentUser) {
        await currentUser?.refresh();
        await utils.userProfile.get.invalidate({ username: currentUser.username });
      }
      dialog.onClose();
    },
    onError: async (error) => {
      showErrorNotification({
        title: 'There was an error updating your profile',
        error: new Error(error.message),
      });
    },
  });

  const { isLoading: loadingProfile, data: user } = trpc.userProfile.get.useQuery(
    { username: currentUser ? currentUser.username : '' },
    { enabled: !!currentUser?.username }
  );

  const badges = useMemo(
    () =>
      user
        ? user.cosmetics
            .filter(({ cosmetic: c }) => c.type === CosmeticType.Badge && !!c.data)
            .filter((item, index, self) => {
              const data = (item.cosmetic.data ?? {}) as BadgeCosmetic['data'];
              const url = (data.url ?? '') as string;
              // Keep only the first occurrence of each unique URL
              return (
                url &&
                self.findIndex((b) => {
                  const bData = (b.cosmetic.data ?? {}) as BadgeCosmetic['data'];
                  return (bData.url ?? '') === url;
                }) === index
              );
            })
            .map(({ cosmetic, cosmeticId, ...c }) => ({
              ...c,
              ...cosmetic,
              data: cosmetic.data as BadgeCosmetic['data'],
            }))
        : [],
    [user]
  );

  const nameplates = useMemo(
    () =>
      user
        ? user.cosmetics
            .filter(({ cosmetic: c }) => c.type === CosmeticType.NamePlate && !!c.data)
            .map(({ cosmetic, cosmeticId, ...c }) => ({
              ...c,
              ...cosmetic,
              data: cosmetic.data as NamePlateCosmetic['data'],
            }))
        : [],
    [user]
  );

  const decorations = useMemo(
    () =>
      user
        ? user.cosmetics
            .filter(({ cosmetic: c }) => c.type === CosmeticType.ProfileDecoration && !!c.data)
            .map(({ cosmetic, cosmeticId, ...c }) => ({
              ...c,
              ...cosmetic,
              data: cosmetic.data as ContentDecorationCosmetic['data'],
            }))
        : [],
    [user]
  );

  const backgrounds = useMemo(
    () =>
      user
        ? user.cosmetics
            .filter(({ cosmetic: c }) => c.type === CosmeticType.ProfileBackground && !!c.data)
            .map(({ cosmetic, cosmeticId, ...c }) => ({
              ...c,
              ...cosmetic,
              data: cosmetic.data as ProfileBackgroundCosmetic['data'],
            }))
        : [],
    [user]
  );

  const leaderboardOptions = useMemo(
    () =>
      leaderboards
        .filter((board) => board.public)
        .map(({ title, id }) => ({
          label: titleCase(title),
          value: id,
        })),
    [leaderboards]
  );

  const form = useForm({ schema, shouldUnregister: false });

  const [
    badge,
    nameplateId,
    profileDecoration,
    profileBackground,
    message,
    bio,
    location,
    profileImage,
    profilePicture,
    profileSectionsSettings,
    creatorCardStatsPreferences,
    privacySettings,
  ] = form.watch([
    'badge',
    'nameplateId',
    'profileDecoration',
    'profileBackground',
    'message',
    'bio',
    'location',
    'profileImage',
    'profilePicture',
    'profileSectionsSettings',
    'creatorCardStatsPreferences',
    'privacySettings',
  ]);
  const displayShowcase = useMemo(() => {
    const sections = (profileSectionsSettings ?? []) as ProfileSectionSchema[];
    return !!sections.find((s) => s.key === 'showcase' && s.enabled);
  }, [profileSectionsSettings]);

  const publicSettings = user?.publicSettings as UserPublicSettingsSchema;

  useEffect(() => {
    if (user && user?.profile) {
      const equippedCosmetics = user.cosmetics
        .filter((c) => !!c.equippedAt)
        .map(({ cosmetic, data, ...rest }) => ({ ...rest, ...cosmetic }));
      const selectedBadge = equippedCosmetics.find((c) => c.type === CosmeticType.Badge);
      const selectedNameplate = equippedCosmetics.find((c) => c.type === CosmeticType.NamePlate);
      const selectedProfileDecoration = equippedCosmetics.find(
        (c) => c.type === CosmeticType.ProfileDecoration
      );
      const selectedProfileBackground = equippedCosmetics.find(
        (c) => c.type === CosmeticType.ProfileBackground
      );
      const formData = {
        ...user.profile,
        // TODO: Fix typing at some point :grimacing:.
        coverImage: user.profile.coverImage as any,
        profileImage: user?.image,
        socialLinks: (user?.links ?? [])
          .filter((link) => link.type === LinkType.Social)
          .map((link) => ({
            id: link.id,
            url: link.url,
            type: link.type,
          })),
        sponsorshipLinks: (user?.links ?? [])
          .filter((link) => link.type === LinkType.Sponsorship)
          .map((link) => ({
            id: link.id,
            url: link.url,
            type: link.type,
          })),
        nameplateId: selectedNameplate?.id ?? null,
        badge: selectedBadge ?? null,
        profileDecoration: selectedProfileDecoration ?? null,
        profileBackground: selectedProfileBackground ?? null,
        leaderboardShowcase: user?.leaderboardShowcase ?? null,
        profilePicture: user.profilePicture
          ? (user.profilePicture as FormDataSchema['profilePicture'])
          : user.image
          ? { url: user.image, type: 'image' as const }
          : null,
        creatorCardStatsPreferences:
          publicSettings?.creatorCardStatsPreferences ?? creatorCardStatsDefaults,
        privacySettings: user.profile.privacySettings as PrivacySettingsSchema,
      };

      if (!previousData.current) previousData.current = formData;

      form.reset(formData);
    }
  }, [user]);

  const handleClose = () => dialog.onClose();
  const handleSubmit = (data: FormDataSchema) => {
    const {
      profilePicture: prevProfilePicture,
      badge: prevBadgeId,
      nameplateId: prevNameplateId,
      profileDecoration: prevProfileDecorationId,
      profileBackground: prevProfileBackgroundId,
      leaderboardShowcase: prevLeaderboardShowcase,
      ...prevProfileData
    } = previousData.current ?? {};
    const {
      profilePicture,
      nameplateId,
      badge,
      profileDecoration,
      profileBackground,
      leaderboardShowcase,
      creatorCardStatsPreferences,
      ...profileData
    } = data;

    const shouldUpdateUser =
      prevProfilePicture?.url !== profilePicture?.url ||
      badge !== prevBadgeId ||
      nameplateId !== prevNameplateId ||
      profileDecoration !== prevProfileDecorationId ||
      profileBackground !== prevProfileBackgroundId ||
      leaderboardShowcase !== prevLeaderboardShowcase;
    const shouldUpdateProfile = !isEqual(prevProfileData, profileData);

    if (shouldUpdateProfile) mutate({ creatorCardStatsPreferences, ...profileData });
    if (user && shouldUpdateUser)
      updateUserMutation.mutate({
        id: user.id,
        profilePicture,
        badgeId: badge?.id ?? null,
        nameplateId,
        profileDecorationId: profileDecoration?.id ?? null,
        profileBackgroundId: profileBackground?.id ?? null,
        leaderboardShowcase,
      });
  };

  const isLoading = loadingProfile || loadingLeaderboards;

  if (!user && !isLoading) {
    return (
      <Stack>
        <AlertWithIcon icon={<IconExclamationMark />} color="red">
          Something went wrong. we could not fetch your user.
        </AlertWithIcon>

        <Center>
          <Button variant="default" onClick={handleClose}>
            Close
          </Button>
        </Center>
      </Stack>
    );
  }

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  const loading = isUpdating || updateUserMutation.isLoading;

  const templateImage = profilePicture?.url ?? profileImage;
  const userWithCosmetics: UserWithCosmetics | null = user
    ? {
        ...user,
        image: templateImage || user.image,
        cosmetics: [],
        deletedAt: null,
        profilePicture: {
          ...user.profilePicture,
          url: templateImage || user.image,
        } as UserWithCosmetics['profilePicture'],
      }
    : null;

  // console.log(userWithCosmetics);
  const cosmeticOverwrites = [
    badge ? badges.find((c) => c.id === badge.id) : undefined,
    nameplateId ? nameplates.find((c) => c.id === nameplateId) : undefined,
    profileDecoration ? decorations.find((c) => c.id === profileDecoration.id) : undefined,
    profileBackground ? backgrounds.find((c) => c.id === profileBackground.id) : undefined,
  ].filter(isDefined);

  return (
    <Modal {...dialog} withCloseButton={false} closeOnEscape={false} withinPortal={false} size="xl">
      <Form
        form={form}
        onSubmit={handleSubmit}
        onError={(error) => {
          const values = form.getValues();

          console.log({ values, previousData: previousData.current });
          console.error(error);
        }}
      >
        <Stack>
          <Group justify="space-between">
            <Text fz={24} fw={590}>
              Customize Profile
            </Text>

            <Group>
              <Button radius="xl" size="md" loading={loading} type="submit">
                Save Changes
              </Button>
              <CloseButton
                size="md"
                radius="xl"
                variant="transparent"
                ml="auto"
                iconSize={20}
                loading={loading}
                onClick={() => {
                  dialog.onClose();
                }}
              />
            </Group>
          </Group>
          <Divider label="Profile" />
          <Stack>
            {userWithCosmetics && (
              <>
                {featureFlags.cosmeticShop ? (
                  <Stack align="center">
                    <CreatorCardV2
                      user={userWithCosmetics}
                      cosmeticOverwrites={cosmeticOverwrites}
                      useEquippedCosmetics={false}
                      style={{ width: '100%', maxWidth: '450px' }}
                      statDisplayOverwrite={creatorCardStatsPreferences}
                    />
                  </Stack>
                ) : (
                  <ProfilePreview
                    user={user}
                    badge={badge ? badges.find((c) => c.id === badge.id) : undefined}
                    nameplate={
                      nameplateId ? nameplates.find((c) => c.id === nameplateId) : undefined
                    }
                    profileImage={profilePicture?.url ?? profileImage}
                  />
                )}
              </>
            )}
            <Stack gap="md">
              {featureFlags.cosmeticShop && (
                <>
                  <InputProfileImageUpload name="profilePicture" label="Edit avatar" />
                  <Divider label="Showcase Stats" />
                  <InputChipGroup name="creatorCardStatsPreferences" multiple>
                    <Group gap={8}>
                      {Object.values(creatorCardStats).map((type, index) => (
                        <Chip key={index} value={type} {...chipProps}>
                          <span>{getDisplayName(type)}</span>
                        </Chip>
                      ))}
                    </Group>
                  </InputChipGroup>
                  {(creatorCardStatsPreferences?.length ?? 0) > creatorCardMaxStats && (
                    <Text c="red" size="xs">
                      A maximum of {creatorCardMaxStats} stats can be displayed
                    </Text>
                  )}
                  <ProfilePictureAlert ingestion={user?.profilePicture?.ingestion} />
                  <InputCosmeticSelect
                    name="profileDecoration"
                    label="Avatar decoration"
                    shopUrl={`/shop?cosmeticTypes=${CosmeticType.ProfileDecoration}`}
                    data={decorations}
                    nothingFound={
                      <Text size="xs">You don&rsquo;t have any avatar decorations yet</Text>
                    }
                    onShopClick={handleClose}
                  />
                  <InputCosmeticSelect
                    name="profileBackground"
                    label="Creator Card Backgrounds"
                    shopUrl={`/shop?cosmeticTypes=${CosmeticType.ProfileBackground}`}
                    nothingFound={
                      <Text size="xs">You don&rsquo;t have any profile backgrounds yet</Text>
                    }
                    data={backgrounds}
                    onShopClick={handleClose}
                  />
                </>
              )}

              <Switch
                label="Show badges on profile"
                checked={privacySettings?.showBadges !== false}
                onChange={(e) =>
                  form.setValue('privacySettings', {
                    ...privacySettings,
                    showBadges: e.currentTarget.checked,
                  })
                }
              />
              <InputCosmeticSelect
                name="badge"
                label="Featured Badge"
                shopUrl={`/shop?cosmeticTypes=${CosmeticType.Badge}`}
                nothingFound={<Text size="xs">You don&rsquo;t have any badges yet</Text>}
                data={badges}
                onShopClick={handleClose}
              />
            </Stack>
            <Stack>
              <InputSelect
                name="nameplateId"
                placeholder="Select style"
                label={
                  <Group gap={4} wrap="nowrap">
                    <Input.Label>Nameplate Style</Input.Label>
                    <Popover withArrow width={300} withinPortal position="top">
                      <Popover.Target>
                        <Box
                          display="inline-block"
                          style={{ lineHeight: 0.8, cursor: 'pointer', opacity: 0.5 }}
                        >
                          <IconInfoCircle size={16} />
                        </Box>
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Text fw={500} size="sm">
                          Nameplates
                        </Text>
                        <Text size="sm">
                          Nameplates change the appearance of your username. They can include
                          special colors or effects. You can earn nameplates by being a subscriber
                          or earning trophies on the site.
                        </Text>
                      </Popover.Dropdown>
                    </Popover>
                  </Group>
                }
                nothingFoundMessage="Your earned nameplate styles will appear here"
                data={
                  nameplates.map((cosmetic) => ({
                    label: cosmetic.name,
                    value: cosmetic.id,
                  })) ?? []
                }
                clearable
              />
              <InputSelect
                label="Showcase Leaderboard"
                placeholder="Select a leaderboard"
                description="Choose which leaderboard badge to display on your profile card"
                name="leaderboardShowcase"
                data={leaderboardOptions}
                disabled={loadingLeaderboards}
                searchable
                clearable
              />
            </Stack>
          </Stack>

          <Divider label="Links" />
          <InputInlineSocialLinkInput
            name="socialLinks"
            label="Social Links"
            type={LinkType.Social}
          />
          <InputInlineSocialLinkInput
            name="sponsorshipLinks"
            label="Sponsorship Links"
            type={LinkType.Sponsorship}
          />
          <Divider label="Profile Page" />
          <InputSimpleImageUpload
            name="coverImage"
            label="Cover Image"
            description={`Suggested resolution: ${constants.profile.coverImageWidth}x${constants.profile.coverImageHeight}px`}
            aspectRatio={constants.profile.coverImageAspectRatio}
            // Im aware ideally this should ideally be 450, but images will look better on a higher res here
            previewWidth={constants.profile.coverImageWidth}
          />
          <InputTextArea
            autosize
            name="message"
            description="Have something you want to share with people visiting your profile? Put it here and we'll display it at the top of your page"
            maxLength={constants.profile.messageMaxLength}
            labelProps={{ style: { width: '100%' } }}
            label={
              <Group className="w-full" justify="space-between">
                <Text>Announcement</Text>
                <Text size="xs">
                  {message?.length ?? 0}/{constants.profile.messageMaxLength}
                </Text>
              </Group>
            }
          />
          <InputTextArea
            name="bio"
            labelProps={{ style: { width: '100%' } }}
            label={
              <Group className="w-full" justify="space-between">
                <Text>Bio</Text>
                <Text size="xs">
                  {bio?.length ?? 0}/{constants.profile.bioMaxLength}
                </Text>
              </Group>
            }
            autosize
            maxLength={constants.profile.bioMaxLength}
          />
          <InputText
            name="location"
            labelProps={{ style: { width: '100%' } }}
            label={
              <Group className="w-full" justify="space-between">
                <Text>Location</Text>
                <Text size="xs">
                  {location?.length ?? 0}/{constants.profile.locationMaxLength}
                </Text>
              </Group>
            }
            maxLength={constants.profile.locationMaxLength}
          />

          {user?.profile && (
            <InputProfileSectionsSettingsInput
              name="profileSectionsSettings"
              label="Page sections"
              description="Drag diferent sections on your profile in order of your preference"
            />
          )}
          {displayShowcase && (
            <InputShowcaseItemsInput
              name="showcaseItems"
              label="Showcase Items"
              limit={constants.profile.showcaseItemsLimit}
              description={`Select up to ${constants.profile.showcaseItemsLimit} items to showcase on your profile. You do this via the "Add to showcase" button on models and images`}
            />
          )}
          <Group justify="flex-end" align="flex-end">
            <Button radius="xl" size="md" loading={loading} type="submit">
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

type ProfilePreviewProps = {
  user?: UserWithProfile;
  badge?: BadgeCosmetic;
  nameplate?: NamePlateCosmetic;
  profileImage?: string | null;
  profileDecoration?: ContentDecorationCosmetic | null;
  profileBackground?: ProfileBackgroundCosmetic | null;
};

export function ProfilePreview({
  // deprecated
  user,
  badge,
  nameplate,
  profileImage,
  profileBackground,
}: ProfilePreviewProps) {
  if (!user) return null;

  const userWithCosmetics: UserWithCosmetics = {
    ...user,
    image: profileImage || user.image,
    cosmetics: [],
    deletedAt: null,
    profilePicture: {
      ...user.profilePicture,
      url: profileImage || user.image,
    } as UserWithCosmetics['profilePicture'],
  };
  if (badge)
    userWithCosmetics.cosmetics.push({ cosmetic: { ...badge, type: 'Badge' }, data: null });
  if (nameplate)
    userWithCosmetics.cosmetics.push({
      cosmetic: { ...nameplate, type: 'NamePlate' },
      data: null,
    });

  return (
    <Stack gap={4}>
      <Input.Label>Preview</Input.Label>
      <Paper p="sm" withBorder>
        <UserAvatar
          user={userWithCosmetics}
          size="lg"
          subText={user.createdAt ? `Member since ${formatDate(user.createdAt)}` : ''}
          withOverlay={!!profileBackground}
          withUsername
        />
      </Paper>
    </Stack>
  );
}
