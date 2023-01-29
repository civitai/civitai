import { Card, Group, Title, Button, Stack } from '@mantine/core';
import { signOut, useSession } from 'next-auth/react';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, InputText, useForm } from '~/libs/form';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function RemoveAccountCard() {
  const user = useCurrentUser();
  const utils = trpc.useContext();

  const { mutate, isLoading, error } = trpc.user.delete.useMutation({
    async onSuccess(user) {
      showSuccessNotification({ message: 'Your account has been removed' });
      signOut();
    },
  });

  const schema = z.object({
    username: z.string().superRefine((val, ctx) => {
      if (val !== user?.username) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'username must match',
        });
      }
    }),
  });

  const form = useForm({ schema });

  return (
    <Card>
      <Title order={2}>Remove Account</Title>
      <Form form={form}>
        <Stack>
          <InputText name="username" description="Enter your username exactly" />
          <Group position="right">
            <Button color="red">Remove Account</Button>
          </Group>
        </Stack>
      </Form>
    </Card>
  );
}
