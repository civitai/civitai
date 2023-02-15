import {
  Button,
  Alert,
  Card,
  Center,
  Grid,
  Group,
  Input,
  Paper,
  Stack,
  Text,
  Title,
  ThemeIcon,
  HoverCard,
  ScrollArea,
  LoadingOverlay,
  Tooltip,
  Box,
  Popover,
} from '@mantine/core';
import { IconInfoCircle, IconRosette } from '@tabler/icons';
import { useEffect } from 'react';
import { z } from 'zod';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputProfileImageUpload, InputSelect, InputText, useForm } from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BadgeCosmetic, NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { formatDate } from '~/utils/date-helpers';
import { reloadSession } from '~/utils/next-auth-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  id: z.number(),
  username: z
    .string()
    .min(3, 'Your username must be at least 3 characters long')
    .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.'),
  image: z.string().nullable(),
  nameplateId: z.number().nullish(),
  badgeId: z.number().nullish(),
});

export function ProfileCard() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: cosmetics, isLoading: loadingCosmetics } = trpc.user.getCosmetics.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  const { data: equippedCosmetics } = trpc.user.getCosmetics.useQuery(
    { equipped: true },
    { enabled: !!currentUser }
  );

  const { mutate, isLoading, error } = trpc.user.update.useMutation({
    async onSuccess(user, { badgeId, nameplateId }) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      // await utils.model.getAll.invalidate();
      await queryUtils.review.getAll.invalidate();
      await queryUtils.comment.getAll.invalidate();
      await reloadSession();

      if (user)
        form.reset({
          ...user,
          image: user.image ?? null,
          username: user.username ?? undefined,
          badgeId: badgeId ?? null,
          nameplateId: nameplateId ?? null,
        });
    },
  });

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: { ...currentUser },
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
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equippedCosmetics]);

  const formUser = form.watch();
  const { nameplates = [], badges = [] } = cosmetics || {};
  const selectedBadge = badges.find((badge) => badge.id === formUser.badgeId);
  const selectedNameplate = nameplates.find((nameplate) => nameplate.id === formUser.nameplateId);

  return (
    <Card withBorder>
      <Form form={form} onSubmit={(data) => mutate({ ...data })}>
        <Stack>
          <Title order={2}>Profile</Title>
          {error && (
            <Alert color="red" variant="light">
              {error.data?.code === 'CONFLICT' ? 'That username is already taken' : error.message}
            </Alert>
          )}
          <Grid>
            {currentUser && (
              <Grid.Col span={12}>
                <ProfilePreview
                  user={{ ...formUser, createdAt: currentUser.createdAt }}
                  badge={selectedBadge}
                  nameplate={selectedNameplate}
                />
              </Grid.Col>
            )}
            <Grid.Col xs={12} md={7}>
              <InputText name="username" label="Username" required />
            </Grid.Col>
            <Grid.Col xs={12} md={5}>
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
                disabled={loadingCosmetics}
                clearable
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <InputProfileImageUpload name="image" label="Profile Image" />
            </Grid.Col>
            <Grid.Col span={12}>
              <Stack spacing={0}>
                <Group position="apart">
                  <Group spacing={4}>
                    <Input.Label>Badge</Input.Label>
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
                          Badges
                        </Text>
                        <Text size="sm">
                          Badges appear next your username and can even include special effects. You
                          can earn badges by being a subscriber or earning trophies on the site.
                        </Text>
                      </Popover.Dropdown>
                    </Popover>
                  </Group>
                  {selectedBadge && (
                    <Button
                      color="red"
                      variant="subtle"
                      size="xs"
                      onClick={() => form.setValue('badgeId', null, { shouldDirty: true })}
                      compact
                    >
                      Remove badge
                    </Button>
                  )}
                </Group>
                <Group spacing="xs" align="stretch" noWrap>
                  {selectedBadge?.data.url ? (
                    <EdgeImage src={selectedBadge.data.url} width={96} />
                  ) : (
                    <Paper
                      withBorder
                      sx={{
                        width: 96,
                        height: 96,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <IconRosette style={{ opacity: 0.5 }} size={48} stroke={1.5} />
                    </Paper>
                  )}
                  <Paper
                    component={ScrollArea}
                    p="xs"
                    sx={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'stretch',
                      flex: '1 1 0 !important',
                    }}
                    withBorder
                  >
                    <LoadingOverlay visible={loadingCosmetics} />
                    {badges.length > 0 ? (
                      <Group spacing={8} noWrap>
                        {badges.map((cosmetic) => (
                          <HoverCard
                            key={cosmetic.id}
                            position="top"
                            width={300}
                            openDelay={300}
                            withArrow
                            withinPortal
                          >
                            <HoverCard.Target>
                              <Button
                                key={cosmetic.id}
                                p={4}
                                variant={selectedBadge?.id === cosmetic.id ? 'light' : 'subtle'}
                                onClick={() =>
                                  form.setValue('badgeId', cosmetic.id, { shouldDirty: true })
                                }
                                sx={{ height: '100%' }}
                              >
                                <EdgeImage src={cosmetic.data.url as string} width={64} />
                              </Button>
                            </HoverCard.Target>
                            <HoverCard.Dropdown>
                              <Stack spacing={0}>
                                <Text size="sm" weight={500}>
                                  {cosmetic.name}
                                </Text>
                                {cosmetic.description && (
                                  <Text size="sm" sx={{ lineHeight: 1.2 }}>
                                    {cosmetic.description}
                                  </Text>
                                )}
                                <Text size="xs" color="dimmed" mt="xs">
                                  {`Acquired on ${formatDate(cosmetic.obtainedAt)}`}
                                </Text>
                              </Stack>
                            </HoverCard.Dropdown>
                          </HoverCard>
                        ))}
                      </Group>
                    ) : (
                      <Center sx={{ width: '100%', height: 72 }}>
                        <Text size="sm" color="dimmed">
                          Your earned badges will appear here
                        </Text>
                      </Center>
                    )}
                  </Paper>
                </Group>
              </Stack>
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

function ProfilePreview({ user, badge, nameplate }: ProfilePreviewProps) {
  const userWithCosmetics: UserWithCosmetics = {
    ...user,
    cosmetics: [],
    deletedAt: null,
  };
  if (badge) userWithCosmetics.cosmetics.push({ cosmetic: { ...badge, type: 'Badge' } });
  if (nameplate)
    userWithCosmetics.cosmetics.push({ cosmetic: { ...nameplate, type: 'NamePlate' } });

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
};
