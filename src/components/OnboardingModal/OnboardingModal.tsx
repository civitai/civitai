import { Button, Stack, Text, Alert } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Form, InputCheckbox, InputSwitch, InputText, useForm } from '~/libs/form';
import { reloadSession } from '~/utils/next-auth-helpers';
import { trpc } from '~/utils/trpc';
import { toStringList } from '~/utils/array-helpers';

const schema = z.object({
  username: z
    .string()
    .min(3)
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
  const { data: session } = useSession();
  const [alerts, setAlerts] = useState<string[]>([]);

  const { mutate, isLoading, error } = trpc.user.update.useMutation();

  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { ...session?.user, showNsfw: true, blurNsfw: true },
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    mutate(
      { ...session?.user, ...values },
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
    if (!session?.user?.email) alerts.push('verify your email');
    if (!session?.user?.username) alerts.push('verify your username');
    if (!session?.user?.tos) alerts.push('agree to the terms of service');

    setAlerts(alerts);
  }, [session?.user]);

  if (!session?.user) {
    context.closeModal(id);
    return null;
  }

  return (
    <Stack>
      {alerts.length > 0 ? <Alert variant="light">{`Please ${toStringList(alerts)}`}</Alert> : null}

      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          {!session?.user?.email && (
            <InputText name="email" label="Email" type="email" withAsterisk />
          )}
          {/* TODO - only accept [a-z][0-9] */}
          <InputText name="username" label="Username" withAsterisk />
          <InputSwitch
            name="showNsfw"
            label="Show me NSFW content"
            description="If you are not of legal age to view NSFW content, please do not enable this option"
          />
          <InputSwitch
            name="blurNsfw"
            label="Blur NSFW content"
            visible={({ showNsfw }) => !!showNsfw}
          />
          {!session.user.tos && (
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
