import {
  Alert,
  Button,
  Card,
  Grid,
  Group,
  Stack,
  Title,
  Text,
  TextInput,
  Popover,
} from '@mantine/core';
import { IconPencilMinus, IconInfoSquareRounded } from '@tabler/icons-react';
import { z } from 'zod';

import { useSession } from 'next-auth/react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openUserProfileEditModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CryptoTransactions } from '~/components/Account/CryptoTransactions';
import { features } from 'process';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const schema = z.object({
  id: z.number(),
  username: usernameInputSchema,
});

export function ProfileCard() {
  const queryUtils = trpc.useUtils();
  const session = useCurrentUser();
  const { data } = useSession();
  const features = useFeatureFlags();

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
          <Group justify="space-between">
            <Title order={2}>Account Info</Title>
            <Button
              leftSection={<IconPencilMinus size={16} />}
              onClick={() => {
                openUserProfileEditModal();
              }}
              style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
              size="compact-sm"
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
            <Grid.Col span={12}>
              <InputText name="username" label="Name" required />
            </Grid.Col>
            <Grid.Col span={12}>
              <TextInput
                value={currentUser?.email ?? ''}
                label={
                  <Group gap="sm">
                    <Text className="font-medium" size="sm">
                      Account Email
                    </Text>
                    <Popover width={300} withArrow withinPortal shadow="sm">
                      <Popover.Target>
                        <IconInfoSquareRounded
                          size={16}
                          style={{ cursor: 'pointer', opacity: 0.7 }}
                        />
                      </Popover.Target>
                      <Popover.Dropdown>
                        <Stack gap="xs">
                          <Text size="sm" fw={500}>
                            What is this email?
                          </Text>
                          <Text size="xs" lh={1.3}>
                            This is the email address associated with your account. You cannot edit
                            it here.
                          </Text>
                          <Text size="xs" lh={1.3} c="dimmed">
                            If you need to update this address, please contact support@civitai.com
                          </Text>
                        </Stack>
                      </Popover.Dropdown>
                    </Popover>
                  </Group>
                }
                disabled
                styles={{
                  root: { flex: 1 },
                }}
              />
            </Grid.Col>
            <Grid.Col span={12}>
              <Stack>
                <Button
                  type="submit"
                  loading={isLoading}
                  disabled={!form.formState.isDirty}
                  fullWidth
                >
                  Save
                </Button>
                {features.coinbaseOnramp && (
                  <Button
                    color="teal"
                    compact
                    onClick={() => {
                      dialogStore.trigger({
                        component: CryptoTransactions,
                      });
                    }}
                  >
                    View Crypto Transactions
                  </Button>
                )}
              </Stack>
            </Grid.Col>
          </Grid>
        </Stack>
      </Form>
    </Card>
  );
}
