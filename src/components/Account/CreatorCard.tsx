import { Card, Stack } from '@mantine/core';
import { Form, useForm } from '~/libs/form';

export function CreatorCard() {
  const form = useForm();

  return (
    <Card>
      <Form form={form}>
        <Stack></Stack>
      </Form>
    </Card>
  );
}
