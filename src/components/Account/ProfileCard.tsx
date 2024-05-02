import { Alert, Button, Card, Grid, Group, Input, Paper, Stack, Title } from '@mantine/core';
import { IconPencilMinus } from '@tabler/icons-react';
import { useEffect } from 'react';
import { z } from 'zod';

import { useSession } from 'next-auth/react';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { profilePictureSchema, usernameInputSchema } from '~/server/schema/user.schema';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  id: z.number(),
  username: usernameInputSchema,
  image: z.string().nullable(),
  nameplateId: z.number().nullish(),
  badgeId: z.number().nullish(),
  leaderboardShowcase: z.string().nullish(),
  profilePicture: profilePictureSchema.nullish(),
});

export function ProfileCard() {
  const queryUtils = trpc.useUtils();
  const session = useCurrentUser();
  const { data } = useSession();
  const currentUser = data?.user;

  const { data: cosmetics, isLoading: loadingCosmetics } = trpc.user.getCosmetics.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  const { data: equippedCosmetics } = trpc.user.getCosmetics.useQuery(
    { equipped: true },
    { enabled: !!currentUser }
  );
  const { data: user } = trpc.user.getById.useQuery(
    { id: currentUser?.id ?? 0 },
    { enabled: !!currentUser }
  );
  const { data: leaderboards = [], isLoading: loadingLeaderboards } =
    trpc.leaderboard.getLeaderboards.useQuery(undefined, {
      trpc: { context: { skipBatch: true } },
    });

  const { mutate, isLoading, error } = trpc.user.update.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      await queryUtils.user.getById.invalidate({ id: user.id });
      await queryUtils.user.getCosmetics.invalidate({ equipped: true });
      await session?.refresh();
    },
  });

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: {
      ...data?.user,
      profilePicture: user?.profilePicture
        ? (user.profilePicture as z.infer<typeof schema>['profilePicture'])
        : user?.image
        ? { url: user.image, type: 'image' as const }
        : undefined,
    },
    shouldUnregister: false,
  });

  useEffect(() => {
    if (equippedCosmetics && currentUser) {
      const { badges, nameplates } = equippedCosmetics;
      const [selectedBadge] = badges;
      const [selectedNameplate] = nameplates;

      form.reset({
        ...currentUser,
        nameplateId: selectedNameplate?.id ?? null,
        badgeId: selectedBadge?.id ?? null,
        profilePicture: user?.profilePicture
          ? (user.profilePicture as z.infer<typeof schema>['profilePicture'])
          : user?.image
          ? { url: user.image, type: 'image' as const }
          : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, currentUser, equippedCosmetics]);

  const formUser = form.watch();
  const { nameplates = [], badges = [] } = cosmetics || {};
  const selectedBadge = badges.find((badge) => badge.id === formUser.badgeId);
  const selectedNameplate = nameplates.find((nameplate) => nameplate.id === formUser.nameplateId);

  const leaderboardOptions = leaderboards
    .filter((board) => board.public)
    .map(({ title, id }) => ({
      label: titleCase(title),
      value: id,
    }));

  return (
    <Card withBorder>
      <Form
        form={form}
        onSubmit={(data) => {
          const { id, username, nameplateId, badgeId, image, profilePicture, leaderboardShowcase } =
            data;
          mutate({
            id,
            username,
            nameplateId: nameplateId ? nameplateId : null,
            image,
            profilePicture,
            badgeId,
            leaderboardShowcase:
              leaderboardShowcase !== currentUser?.leaderboardShowcase
                ? leaderboardShowcase
                : undefined,
          });
        }}
      >
        <Stack>
          <Group position="apart">
            <Title order={2}>Account Info</Title>
            <Button
              leftIcon={<IconPencilMinus size={16} />}
              onClick={() => {
                openUserProfileEditModal({});
              }}
              sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
              radius="xl"
              compact
            >
              Customize profile
            </Button>
          </Group>
          {error && (
            <Alert color="red" variant="light">
              {error.data?.code === 'CONFLICT' ? 'That username is already taken' : error.message}
            </Alert>
          )}
          <Grid>
            <Grid.Col xs={12}>
              <InputText name="username" label="Name" required />
            </Grid.Col>
            <Grid.Col span={12}>
              <Button
                type="submit"
                loading={isLoading}
                disabled={!form.formState.isDirty}
                fullWidth
              >
                Save
              </Button>
            </Grid.Col>
          </Grid>
        </Stack>
      </Form>
    </Card>
  );
}

function ProfilePreview({ user, badge, nameplate, profileImage }: ProfilePreviewProps) {
  const userWithCosmetics: UserWithCosmetics = {
    ...user,
    image: profileImage ?? user.image,
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
          size="md"
          subText={user.createdAt ? `Member since ${formatDate(user.createdAt)}` : ''}
          withUsername
        />
      </Paper>
    </Stack>
  );
}

type ProfilePreviewProps = {
  user: z.infer<typeof schema> & { createdAt?: Date };
  badge?: BadgeCosmetic;
  nameplate?: NamePlateCosmetic;
  profileImage?: string | null;
};
