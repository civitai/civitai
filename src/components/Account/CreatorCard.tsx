import { Card, Stack, Title } from '@mantine/core';
import { z } from 'zod';
import { Form, useForm } from '~/libs/form';

const schema = z.object({});

export function CreatorCard() {
  const form = useForm();

  return (
    <Card>
      <Form form={form}>
        <Stack>
          <Title order={2}>Creator Profile</Title>
        </Stack>
      </Form>
    </Card>
  );
}
