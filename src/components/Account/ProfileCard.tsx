import {
  ActionIcon,
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
  Tooltip,
} from '@mantine/core';
import {
  IconPencilMinus,
  IconInfoSquareRounded,
  IconMail,
  IconMailCheck,
  IconEye,
  IconEyeOff,
} from '@tabler/icons-react';
import { useDisclosure } from '@mantine/hooks';
import React from 'react';
import * as z from 'zod';

import { useSession } from '~/providers/SessionProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { usernameInputSchema } from '~/server/schema/user.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';
import { SettingsSection } from '~/components/Account/SettingsLayout';
import { maskEmail } from '~/components/Account/mask-email';
import { showErrorNotification } from '~/utils/notifications';

const schema = z.object({
  id: z.number(),
  username: usernameInputSchema,
});

const emailChangeSchema = z.object({
  newEmail: z.string().email('Please enter a valid email address'),
});

export function ProfileCard({ flat }: { flat?: boolean } = {}) {
  const queryUtils = trpc.useUtils();
  const session = useCurrentUser();
  const { data } = useSession();
  const [emailModalOpened, { open: openEmailModal, close: closeEmailModal }] = useDisclosure();
  const [emailRevealed, setEmailRevealed] = React.useState(false);
  const [verificationSent, setVerificationSent] = React.useState(false);

  const resendEmailVerification = trpc.user.resendEmailVerification.useMutation({
    onSuccess: () => setVerificationSent(true),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not send the verification email',
        error: new Error(error.message),
      }),
  });

  const currentUser = data?.user;

  const {
    mutate,
    isPending: isLoading,
    error,
  } = trpc.user.update.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your profile has been saved' });
      await queryUtils.user.getById.invalidate({ id: user.id });
      await queryUtils.userProfile.get.invalidate();
      await session?.refresh();
    },
  });

  const {
    mutate: requestEmailChange,
    isPending: isEmailChangeLoading,
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

  const formBody = (
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
        {!flat && (
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
        )}
        {error && (
          <Alert color="red" variant="light">
            {error.data?.code === 'CONFLICT' ? 'That username is already taken' : error.message}
          </Alert>
        )}
        {flat ? (
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex-1">
              <InputText name="username" label="Username" required />
            </div>
            <div className="flex-1">
              <TextInput
                label="Account email"
                value={
                  currentUser?.email
                    ? emailRevealed
                      ? currentUser.email
                      : maskEmail(currentUser.email)
                    : ''
                }
                disabled
                readOnly
                rightSection={
                  <Tooltip label={emailRevealed ? 'Hide email' : 'Show email'} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="gray"
                      aria-label={emailRevealed ? 'Hide email address' : 'Show email address'}
                      onClick={() => setEmailRevealed((current) => !current)}
                    >
                      {emailRevealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                    </ActionIcon>
                  </Tooltip>
                }
              />
            </div>
          </div>
        ) : (
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
                  value={
                    currentUser?.email
                      ? emailRevealed
                        ? currentUser.email
                        : maskEmail(currentUser.email)
                      : ''
                  }
                  disabled
                  styles={{
                    root: { flex: 1 },
                  }}
                  rightSection={
                    <Tooltip label={emailRevealed ? 'Hide email' : 'Show email'} withArrow>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        aria-label={emailRevealed ? 'Hide email address' : 'Show email address'}
                        onClick={() => setEmailRevealed((current) => !current)}
                      >
                        {emailRevealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                      </ActionIcon>
                    </Tooltip>
                  }
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
        )}
        {flat && (
          <Group justify="flex-end" gap="sm">
            {/* `emailVerified`, deliberately NOT `requiresEmailVerification`: the accounts that
                cannot verify any other way are the unstamped ones the gate — and so the banner
                that carries the only other resend button — excludes. Offering the action makes no
                claim about what the account is allowed to do, so the two predicates differ here on
                purpose. */}
            {!currentUser?.emailVerified && (
              <Button
                variant="default"
                size="compact-sm"
                leftSection={<IconMailCheck size={14} />}
                onClick={() => resendEmailVerification.mutate()}
                loading={resendEmailVerification.isPending}
                disabled={verificationSent}
              >
                {verificationSent ? 'Verification sent' : 'Verify email'}
              </Button>
            )}
            <Button
              variant="default"
              size="compact-sm"
              leftSection={<IconMail size={14} />}
              onClick={openEmailModal}
            >
              Change email
            </Button>
            <Button
              type="submit"
              size="compact-sm"
              loading={isLoading}
              disabled={!form.formState.isDirty}
            >
              Save changes
            </Button>
          </Group>
        )}
      </Stack>
    </Form>
  );

  return (
    <Card withBorder={!flat} p={flat ? 0 : undefined} bg={flat ? 'transparent' : undefined}>
      {flat ? <SettingsSection title="Account info">{formBody}</SettingsSection> : formBody}

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
