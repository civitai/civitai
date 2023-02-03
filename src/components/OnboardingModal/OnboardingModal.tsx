import { Button, Stack, Text, Alert } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Form, InputCheckbox, InputSwitch, InputText, useForm } from '~/libs/form';
import { reloadSession } from '~/utils/next-auth-helpers';
import { trpc } from '~/utils/trpc';
import { toStringList } from '~/utils/array-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const schema = z.object({
  username: z
    .string()
    .min(3, 'Your username must be at least 3 characters long')
    .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.'),
  tos: z.preprocess(
    (val) => (val === false ? null : val),
    z.boolean({
      invalid_type_error: 'You have to agree to the terms of service to use the app',
      required_error: 'You have to agree to the terms of service to use the app',
    })
  ),
  email: z
    .string({
      invalid_type_error: 'Please provide an email',
      required_error: 'Please provide an email',
    })
    .email(),
  blurNsfw: z.boolean(),
  showNsfw: z.boolean(),
});

export default function OnboardingModal({ context, id }: ContextModalProps) {
  const user = useCurrentUser();
  const [alerts, setAlerts] = useState<string[]>([]);

  const { mutate, isLoading, error } = trpc.user.update.useMutation();

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { ...user, showNsfw: true, blurNsfw: true },
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    if (user)
      mutate(
        { ...user, ...values },
        {
          onSuccess: async () => {
            await reloadSession();
            context.closeModal(id);
            setAlerts([]);
          },
        }
      );
  };

  useEffect(() => {
    const alerts: string[] = [];
    if (!user?.email) alerts.push('verify your email');
    if (!user?.username) alerts.push('verify your username');
    if (!user?.tos) alerts.push('agree to the terms of service');

    setAlerts(alerts);
  }, [user]);

  if (!user) {
    context.closeModal(id);
    return null;
  }

  return (
    <Stack>
      {alerts.length > 0 ? (
        <Alert variant="light">{`Please take a moment to review your user settings below and ${toStringList(
          alerts
        )}`}</Alert>
      ) : null}
      <Text mt={-12} mb={-10} size="xs" color="dimmed">
        You can change these at any time from your Account Settings
      </Text>

      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          {!user?.email && <InputText name="email" label="Email" type="email" withAsterisk />}
          <InputText name="username" label="Username" withAsterisk />
          <InputSwitch
            name="showNsfw"
            label="Show me adult content"
            description="If you are not of legal age to view adult content, please do not enable this option"
          />
          <InputSwitch
            name="blurNsfw"
            label="Blur adult content"
            visible={({ showNsfw }) => !!showNsfw}
          />

          {!user?.tos && (
            <InputCheckbox
              name="tos"
              label={
                <span>
                  By using this site you agree to the{' '}
                  <Link href="/content/tos" passHref>
                    <Text component={'a'} variant="link" target="_blank">
                      terms of service
                    </Text>
                  </Link>
                </span>
              }
            />
          )}
          {error && (
            <Alert color="red" variant="light">
              {error.message}
            </Alert>
          )}
          <Button type="submit" loading={isLoading}>
            Submit
          </Button>
        </Stack>
      </Form>
    </Stack>
  );
}
