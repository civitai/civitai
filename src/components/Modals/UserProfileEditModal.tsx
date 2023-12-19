import {
  Box,
  Button,
  Center,
  CloseButton,
  Divider,
  Group,
  HoverCard,
  Input,
  Loader,
  Paper,
  Popover,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import React, { useEffect, useMemo, useRef } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { trpc } from '~/utils/trpc';
import {
  Form,
  InputInlineSocialLinkInput,
  InputProfileImageUpload,
  InputShowcaseItemsInput,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
  InputProfileSectionsSettingsInput,
  InputSelect,
} from '~/libs/form';
import { ProfileSectionSchema, userProfileUpdateSchema } from '~/server/schema/user-profile.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconExclamationMark, IconInfoCircle } from '@tabler/icons-react';
import { constants } from '~/server/common/constants';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CosmeticType, LinkType } from '@prisma/client';
import { z } from 'zod';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { titleCase } from '~/utils/string-helpers';
import { UserWithProfile } from '~/types/router';
import { userUpdateSchema } from '~/server/schema/user.schema';
import { isEqual } from 'lodash-es';
import { ProfilePictureAlert } from '../User/ProfilePictureAlert';

const schema = userProfileUpdateSchema.merge(
  userUpdateSchema
    .pick({
      badgeId: true,
      profilePicture: true,
      nameplateId: true,
      leaderboardShowcase: true,
    })
    .extend({ profileImage: z.string().nullish() })
);
type FormDataSchema = z.infer<typeof schema>;

const { openModal, Modal } = createContextModal({
  name: 'userProfileEditModal',
  withCloseButton: false,
  closeOnEscape: false,
  size: 'xl',
  Element: ({ context }) => {
    const utils = trpc.useContext();
    const currentUser = useCurrentUser();
    const theme = useMantineTheme();

    // Keep track of old data to compare and make only the necessary requests
    const previousData = useRef<FormDataSchema>();

    const { data: leaderboards = [], isLoading: loadingLeaderboards } =
      trpc.leaderboard.getLeaderboards.useQuery();

    const { mutate, isLoading: isUpdating } = trpc.userProfile.update.useMutation({
      onSuccess: (data) => {
        if (currentUser) {
          utils.userProfile.get.setData({ username: currentUser.username }, data);
          utils.userProfile.get.invalidate({ username: currentUser.username });
        }
        showSuccessNotification({ message: 'Profile updated successfully' });
        context.close();
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
        context.close();
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
              .map((c) => ({
                ...c,
                ...c.cosmetic,
                data: c.cosmetic.data as any,
              }))
          : [],
      [user]
    );

    const nameplates = useMemo(
      () =>
        user
          ? user.cosmetics
              .filter(({ cosmetic: c }) => c.type === CosmeticType.NamePlate && !!c.data)
              .map((c) => ({ ...c, ...c.cosmetic, data: c.cosmetic.data as any }))
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

    const form = useForm({
      schema,
      shouldUnregister: false,
    });

    const [
      badgeId,
      nameplateId,
      message,
      bio,
      location,
      profileImage,
      profilePicture,
      profileSectionsSettings,
    ] = form.watch([
      'badgeId',
      'nameplateId',
      'message',
      'bio',
      'location',
      'profileImage',
      'profilePicture',
      'profileSectionsSettings',
    ]);
    const displayShowcase = useMemo(() => {
      const sections = (profileSectionsSettings ?? []) as ProfileSectionSchema[];
      return !!sections.find((s) => s.key === 'showcase' && s.enabled);
    }, [profileSectionsSettings]);
    const equippedCosmetics = useMemo(
      () => (user?.cosmetics ?? []).filter((c) => !!c.equippedAt).map((c) => c.cosmetic),
      [user]
    );

    useEffect(() => {
      if (user && user?.profile) {
        const selectedBadge = equippedCosmetics.find((c) => c.type === CosmeticType.Badge);
        const selectedNameplate = equippedCosmetics.find((c) => c.type === CosmeticType.NamePlate);
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
          badgeId: selectedBadge?.id ?? null,
          nameplateId: selectedNameplate?.id ?? null,
          leaderboardShowcase: user?.leaderboardShowcase ?? null,
          profilePicture: user.profilePicture
            ? (user.profilePicture as FormDataSchema['profilePicture'])
            : user.image
            ? { url: user.image, type: 'image' as const }
            : null,
        };

        if (!previousData.current) previousData.current = formData;

        form.reset(formData);
      }
    }, [equippedCosmetics, user]);

    const handleClose = () => context.close();
    const handleSubmit = (data: FormDataSchema) => {
      const {
        profilePicture: prevProfilePicture,
        badgeId: prevBadgeId,
        nameplateId: prevNameplateId,
        leaderboardShowcase: prevLeaderboardShowcase,
        ...prevProfileData
      } = previousData.current ?? {};
      const { profilePicture, badgeId, nameplateId, leaderboardShowcase, ...profileData } = data;
      const shouldUpdateUser =
        prevProfilePicture?.url !== profilePicture?.url ||
        badgeId !== prevBadgeId ||
        nameplateId !== prevNameplateId ||
        leaderboardShowcase !== prevLeaderboardShowcase;
      const shouldUpdateProfile = !isEqual(prevProfileData, profileData);

      if (shouldUpdateProfile) mutate(profileData);
      if (user && shouldUpdateUser)
        updateUserMutation.mutate({
          id: user.id,
          profilePicture,
          badgeId,
          nameplateId,
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

    return (
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <Group position="apart">
            <Text size={24} weight={590}>
              Edit Profile
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
                  context.close();
                }}
              />
            </Group>
          </Group>
          <Divider label="Profile" />
          <Stack>
            <ProfilePreview
              user={user}
              badge={badgeId ? badges.find((c) => c.id === badgeId) : undefined}
              nameplate={nameplateId ? nameplates.find((c) => c.id === nameplateId) : undefined}
              profileImage={profilePicture?.url ?? profileImage}
            />
            <Stack spacing={8}>
              <InputProfileImageUpload name="profilePicture" label="Edit profile image" />
              <ProfilePictureAlert ingestion={user?.profilePicture?.ingestion} />
            </Stack>
            <Stack>
              <InputSelect
                name="nameplateId"
                placeholder="Select style"
                label={
                  <Group spacing={4} noWrap>
                    <Input.Label>Nameplate Style</Input.Label>
                    <Popover withArrow width={300} withinPortal position="top">
                      <Popover.Target>
                        <Box
                          display="inline-block"
                          sx={{ lineHeight: 0.8, cursor: 'pointer', opacity: 0.5 }}
                        >
                          <IconInfoCircle size={16} />
                        </Box>
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Text weight={500} size="sm">
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
                nothingFound="Your earned nameplate styles will appear here"
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
            <Group spacing={4}>
              <Input.Label>Featured Badge</Input.Label>
              <Popover withArrow width={300} withinPortal position="top">
                <Popover.Target>
                  <Box
                    display="inline-block"
                    sx={{ lineHeight: 0.8, cursor: 'pointer', opacity: 0.5 }}
                  >
                    <IconInfoCircle size={16} />
                  </Box>
                </Popover.Target>
                <Popover.Dropdown>
                  <Text weight={500} size="sm">
                    Featured Badge
                  </Text>
                  <Text size="sm">
                    Badges appear next your username and can even include special effects. You can
                    earn badges by being a subscriber or earning trophies on the site.
                  </Text>
                </Popover.Dropdown>
              </Popover>
            </Group>

            {badges.length > 0 ? (
              <Group spacing={8}>
                {badges.map((cosmetic) => {
                  const data = (cosmetic.data ?? {}) as BadgeCosmetic['data'];
                  const url = (data.url ?? '') as string;
                  const isSelected = badgeId === cosmetic.id;

                  return (
                    <HoverCard
                      key={cosmetic.id}
                      position="top"
                      width="auto"
                      openDelay={300}
                      withArrow
                      withinPortal
                    >
                      <HoverCard.Target>
                        <Button
                          key={cosmetic.id}
                          p={4}
                          variant={isSelected ? 'light' : 'subtle'}
                          style={
                            isSelected
                              ? {
                                  border: '3px solid',
                                  borderColor: theme.colors.blue[theme.fn.primaryShade()],
                                }
                              : undefined
                          }
                          onClick={() => {
                            if (isSelected) {
                              form.setValue('badgeId', null, { shouldDirty: true });
                            } else {
                              form.setValue('badgeId', cosmetic.id, { shouldDirty: true });
                            }
                          }}
                          sx={{ height: 64, width: 64 }}
                        >
                          <EdgeMedia src={url} width={data.animated ? 'original' : 64} />
                        </Button>
                      </HoverCard.Target>
                      <HoverCard.Dropdown>
                        <Stack spacing={0}>
                          <Text size="sm" weight={500}>
                            {cosmetic.name}
                          </Text>
                        </Stack>
                      </HoverCard.Dropdown>
                    </HoverCard>
                  );
                })}
              </Group>
            ) : (
              <Paper>
                <Center sx={{ width: '100%', height: 72 }}>
                  <Text size="sm" color="dimmed">
                    Your not earned any awards yet.
                  </Text>
                </Center>
              </Paper>
            )}
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
              <Group position="apart">
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
              <Group position="apart">
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
              <Group position="apart">
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
          <Group position="right" align="flex-end">
            <Button radius="xl" size="md" loading={loading} type="submit">
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Form>
    );
  },
});

type ProfilePreviewProps = {
  user?: UserWithProfile;
  badge?: BadgeCosmetic;
  nameplate?: NamePlateCosmetic;
  profileImage?: string | null;
};
function ProfilePreview({ user, badge, nameplate, profileImage }: ProfilePreviewProps) {
  if (!user) {
    return null;
  }

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
    userWithCosmetics.cosmetics.push({ cosmetic: { ...nameplate, type: 'NamePlate' }, data: null });

  return (
    <Stack spacing={4}>
      <Input.Label>Preview</Input.Label>
      <Paper p="sm" withBorder>
        <UserAvatar
          user={userWithCosmetics}
          size="lg"
          subText={user.createdAt ? `Member since ${formatDate(user.createdAt)}` : ''}
          withUsername
        />
      </Paper>
    </Stack>
  );
}

export const openUserProfileEditModal = openModal;
export default Modal;
