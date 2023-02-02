import { Button, Alert, Card, Grid, Group, Paper, Stack, Text, Title, Input } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { SessionUser } from 'next-auth';
import { z } from 'zod';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputProfileImageUpload, InputSelect, InputText, useForm } from '~/libs/form';
import { reloadSession } from '~/utils/next-auth-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  username: z
    .string()
    .min(3)
    .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.'),
  image: z.string().nullable(),
});

export function ProfileCard() {
  const currentUser = useCurrentUser();
  const utils = trpc.useContext();

  const { mutate, isLoading, error } = trpc.user.update.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      // await utils.model.getAll.invalidate();
      await utils.review.getAll.invalidate();
      await reloadSession();
      if (user)
        form.reset({
          image: user.image ?? null,
          username: user.username ?? undefined,
        });
    },
  });

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: { ...currentUser },
  });

  return (
    <Card withBorder>
      <Form form={form} onSubmit={(data) => mutate({ id: currentUser?.id, ...data })}>
        <Stack>
          <Title order={2}>Profile</Title>
          {error && (
            <Alert color="red" variant="light">
              {error.data?.code === 'CONFLICT' ? 'That username is already taken' : error.message}
            </Alert>
          )}
          <Grid>
            {currentUser ? (
              <Grid.Col span={12}>
                <ProfilePreview user={currentUser} />
              </Grid.Col>
            ) : null}
            <Grid.Col xs={12} md={8}>
              <InputText name="username" label="Username" required />
            </Grid.Col>
            <Grid.Col xs={12} md={4}>
              <InputSelect
                name="nameplate"
                label={
                  <Group spacing={4} noWrap>
                    <Input.Label>Nameplate Style</Input.Label>
                    <IconBadge
                      tooltip="Select the style for your username"
                      icon={<IconInfoCircle size={14} />}
                    />
                  </Group>
                }
                data={['Supporter', 'Mod']}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <InputProfileImageUpload name="image" label="Profile image" />
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

function ProfilePreview({ user }: ProfilePreviewProps) {
  return (
    <Paper p="sm" withBorder>
      <Stack spacing={4}>
        <Text size="sm" weight={500} color="dimmed">
          Preview
        </Text>
        <UserAvatar user={user} subText={`Last updated`} size="xl" withUsername />
      </Stack>
    </Paper>
  );
}

type ProfilePreviewProps = { user: SessionUser };
