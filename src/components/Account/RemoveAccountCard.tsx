import { Card } from '@mantine/core';
import { signOut, useSession } from 'next-auth/react';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Form, useForm } from '~/libs/form';
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

  const form = useForm({
    schema: z.object({ displayName: z.string() }),
  });

  return (
    <Card>
      <Form form={form}></Form>
    </Card>
  );
}
