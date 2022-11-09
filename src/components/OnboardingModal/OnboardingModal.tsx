import { ContextModalProps } from '@mantine/modals';
import { Button, Checkbox, Stack, TextInput, Text, Alert } from '@mantine/core';
import { useForm, zodResolver } from '@mantine/form';
import { z } from 'zod';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import { reloadSession } from './../../utils/next-auth-helpers';

const schema = z.object({
  username: z.string(),
  tos: z.boolean(),
});

export default function OnboardingModal({ context, id }: ContextModalProps) {
  const session = useSession();
  const { username = '', tos = false } = session.data?.user ?? {};
  const { mutate, isLoading, error } = trpc.user.update.useMutation();
  const form = useForm<z.infer<typeof schema>>({
    validate: zodResolver(schema),
    initialValues: { username, tos },
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    mutate(
      { ...session.data?.user, ...values },
      {
        onSuccess: async () => {
          await reloadSession();
          context.closeModal(id);
        },
      }
    );
  };

  if (!session.data?.user) {
    context.closeModal(id);
    return null;
  }

  return (
    <Stack>
      <Alert variant="light">Please verify your username and agree to the terms of service</Alert>

      <form onSubmit={form.onSubmit(handleSubmit, console.error)}>
        <Stack>
          <TextInput label="Username" required {...form.getInputProps('username')} />
          <Checkbox
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
            {...form.getInputProps('tos')}
          />
          {error && (
            <Alert color="red" variant="light">
              {error.message}
            </Alert>
          )}
          <Button type="submit" loading={isLoading}>
            Submit
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}
