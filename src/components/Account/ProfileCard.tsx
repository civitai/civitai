import { Alert, Button, Card, Grid, Group, Input, Paper, Stack, Title } from '@mantine/core';
import { IconPencilMinus } from '@tabler/icons-react';
import { z } from 'zod';

import { useSession } from 'next-auth/react';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { profilePictureSchema, usernameInputSchema } from '~/server/schema/user.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  id: z.number(),
  username: usernameInputSchema,
});

export function ProfileCard() {
  const queryUtils = trpc.useUtils();
  const session = useCurrentUser();
  const { data } = useSession();

  const currentUser = data?.user;

  const { mutate, isLoading, error } = trpc.user.update.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      await queryUtils.user.getById.invalidate({ id: user.id });
      await queryUtils.userProfile.get.invalidate();
      await session?.refresh();
    },
  });

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: {
      ...data?.user,
    },
    shouldUnregister: false,
  });

  return (
    <Card withBorder>
      <Form
        form={form}
        onSubmit={(data) => {
          const { id, username } = data;
          mutate({
            id,
            username,
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
