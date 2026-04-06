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
  Modal,
} from '@mantine/core';
import { IconPencilMinus, IconInfoSquareRounded, IconMail } from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import * as z from 'zod';

import { useSession } from 'next-auth/react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';

const schema = z.object({
  id: z.number(),
  username: usernameInputSchema,
});

const emailChangeSchema = z.object({
  newEmail: z.string().email('Please enter a valid email address'),
});

export function ProfileCard() {
  const queryUtils = trpc.useUtils();
  const session = useCurrentUser();
  const { data } = useSession();
  const [emailModalOpened, { open: openEmailModal, close: closeEmailModal }] = useDisclosure();

  const currentUser = data?.user;

  const { mutate, isLoading, error } = trpc.user.update.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      await queryUtils.user.getById.invalidate({ id: user.id });
      await queryUtils.userProfile.get.invalidate();
      await session?.refresh();
    },
  });

  const {
    mutate: requestEmailChange,
    isLoading: isEmailChangeLoading,
    error: emailChangeError,
  } = trpc.user.requestEmailChange.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        message:
          'Verification email sent! Please check your inbox and click the verification link.',
      });
      closeEmailModal();
      emailForm.reset();
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

  const emailForm = useForm({
    schema: emailChangeSchema,
    mode: 'onChange',
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
              <InputText name="username" label="Username" required />
            </Grid.Col>
            <Grid.Col span={12}>
              <Stack gap="xs">
                <Group gap="sm">
                  <Text className="font-medium" size="sm">
                    Account Email
                  </Text>
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconMail size={14} />}
                    onClick={openEmailModal}
                  >
                    Change Email
                  </Button>
                </Group>
                <TextInput
                  value={currentUser?.email ?? ''}
                  disabled
                  styles={{
                    root: { flex: 1 },
                  }}
                />
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

      {/* Email Change Modal */}
      <Modal
        opened={emailModalOpened}
        onClose={closeEmailModal}
        title="Change Email Address"
        size="md"
      >
        <Form
          form={emailForm}
          onSubmit={(data) => {
            requestEmailChange({ newEmail: data.newEmail });
          }}
        >
          <Stack>
            {emailChangeError && (
              <Alert color="red" variant="light">
                {emailChangeError.message}
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              Enter your new email address. We&rsquo;ll send you a verification link to confirm the
              change. Verification codes expire in 15 minutes.
            </Text>
            <InputText
              name="newEmail"
              label="New Email Address"
              placeholder="Enter your new email"
              required
            />
            <Group justify="flex-end" gap="sm">
              <Button variant="outline" onClick={closeEmailModal}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={isEmailChangeLoading}
                disabled={!emailForm.formState.isValid}
              >
                Send Verification Email
              </Button>
            </Group>
          </Stack>
        </Form>
      </Modal>
    </Card>
  );
}
