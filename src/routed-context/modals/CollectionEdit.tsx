import { Button, Center, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { z } from 'zod';

import { useEffect } from 'react';
import { collectionReadPrivacyData } from '~/components/Collections/collection.utils';
import {
  Form,
  InputCheckbox,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { UpsertCollectionInput, upsertCollectionInput } from '~/server/schema/collection.schema';
import { trpc } from '~/utils/trpc';
import { createRoutedContext } from '../create-routed-context';

export default createRoutedContext({
  authGuard: true,
  schema: z.object({
    collectionId: z.number(),
  }),
  Element: ({ context, props: { collectionId } }) => {
    const queryUtils = trpc.useContext();
    const { data, isLoading } = trpc.collection.getById.useQuery(
      { id: collectionId },
      { enabled: !!collectionId }
    );

    const form = useForm({
      schema: upsertCollectionInput,
      shouldUnregister: false,
    });

    const upsertCollectionMutation = trpc.collection.upsert.useMutation();
    const handleSubmit = (data: UpsertCollectionInput) => {
      upsertCollectionMutation.mutate(
        { ...data },
        {
          onSuccess: async () => {
            await queryUtils.collection.getInfinite.invalidate();
            await queryUtils.collection.getById.invalidate({ id: collectionId });
            context.close();
          },
        }
      );
    };

    useEffect(() => {
      if (data && data.collection) {
        const result = upsertCollectionInput.safeParse(data.collection);
        console.log({ result, data: data.collection });
        if (result.success) form.reset({ ...result.data });
        else console.error(result.error);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data]);

    return (
      <Modal opened={context.opened} onClose={context.close} title="Edit collection">
        {isLoading ? (
          <Center py="xl">
            <Loader variant="bars" />
          </Center>
        ) : data?.collection ? (
          <Form form={form} onSubmit={handleSubmit}>
            <Stack spacing="xs">
              <InputSimpleImageUpload name="image" label="Cover Image" />
              <InputText
                name="name"
                label="Name"
                placeholder="e.g.: Video Game Characters"
                withAsterisk
              />
              <InputTextArea
                name="description"
                label="Description"
                placeholder="e.g.: My favorite video game characters"
                rows={3}
                autosize
              />
              <InputSelect
                name="read"
                label="Privacy"
                data={Object.values(collectionReadPrivacyData)}
                // itemComponent={SelectItem}
              />
              <InputCheckbox name="nsfw" label="This collection contains mature content" mt="xs" />
              <Group position="right">
                <Button type="submit" loading={upsertCollectionMutation.isLoading}>
                  Save
                </Button>
              </Group>
            </Stack>
          </Form>
        ) : (
          <Center py="xl">
            <Text color="dimmed">Collection not found</Text>
          </Center>
        )}
      </Modal>
    );
  },
});
