import { Button, Stack, Text, Alert } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { z } from 'zod';

import { Form, InputCheckbox, InputSwitch, InputText, useForm } from '~/libs/form';
import { reloadSession } from '~/utils/next-auth-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  username: z.string(),
  tos: z.boolean(),
  email: z.string().email().nullable(),
  blurNsfw: z.boolean(),
  showNsfw: z.boolean(),
});

export default function OnboardingModal({ context, id }: ContextModalProps) {
  const { data: session } = useSession();
  const { mutate, isLoading, error } = trpc.user.update.useMutation();

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues: session?.user,
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    mutate(
      { ...session?.user, ...values },
      {
        onSuccess: async () => {
          await reloadSession();
          context.closeModal(id);
        },
      }
    );
  };

  if (!session?.user) {
    context.closeModal(id);
    return null;
  }

  return (
    <Stack>
      <Alert variant="light">Please verify your username and agree to the terms of service</Alert>

      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          {!session?.user.email ? (
            <InputText name="email" label="Email" type="email" withAsterisk required />
          ) : null}
          <InputText name="username" label="Username" withAsterisk required />
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
          {!session.user.tos ? (
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
              required
            />
          ) : null}
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
