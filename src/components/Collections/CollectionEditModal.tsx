import { Button, Center, Group, Loader, Modal, Stack, Text } from '@mantine/core';

import { useEffect } from 'react';
import {
  collectionReadPrivacyData,
  collectionWritePrivacyData,
} from '~/components/Collections/collection.utils';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputNumber,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { UpsertCollectionInput, upsertCollectionInput } from '~/server/schema/collection.schema';
import { trpc } from '~/utils/trpc';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionMode, CollectionType } from '@prisma/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getDisplayName } from '~/utils/string-helpers';
import { IconCalendar } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useRouter } from 'next/router';
import { isDefined } from '~/utils/type-guards';

export default function CollectionEditModal({ collectionId }: { collectionId?: number }) {
  const router = useRouter();
  const dialog = useDialogContext();
  const queryUtils = trpc.useContext();
  const currentUser = useCurrentUser();
  const { data, isLoading: queryLoading } = trpc.collection.getById.useQuery(
    { id: collectionId as number },
    { enabled: !!collectionId }
  );

  const isLoading = queryLoading && !!collectionId;

  const form = useForm({
    schema: upsertCollectionInput,
    shouldUnregister: false,
    defaultValues: {
      type: CollectionType.Model,
    },
  });

  const mode = form.watch('mode');

  const upsertCollectionMutation = trpc.collection.upsert.useMutation();
  const handleSubmit = (data: UpsertCollectionInput) => {
    upsertCollectionMutation.mutate(
      { ...data, mode: data.mode || null },
      {
        onSuccess: async (collection) => {
          await queryUtils.collection.getInfinite.invalidate();
          if (collectionId) {
            await queryUtils.collection.getById.invalidate({ id: collectionId });
          } else {
            // Redirect to collection page:
            await queryUtils.collection.getAllUser.invalidate();
            router.push(`/collections/${collection.id}`);
          }

          dialog.onClose();
        },
      }
    );
  };

  useEffect(() => {
    if (data && data.collection) {
      const result = upsertCollectionInput.safeParse({
        ...data.collection,
        type: data.collection.type ?? CollectionType.Model,
        mode: data.collection.mode,
        metadata: data.collection.metadata ?? {},
      });
      if (result.success) form.reset({ ...result.data });
      else console.error(result.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const permissions = data?.permissions ?? { manage: false, write: false };
  const canEdit = data?.collection && permissions.manage;
  const isCreate = !collectionId;

  return (
    <Modal {...dialog} title={isCreate ? 'Create collection' : 'Edit collection'}>
      {isLoading ? (
        <Center py="xl">
          <Loader variant="bars" />
        </Center>
      ) : canEdit || isCreate ? (
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
            />
            {isCreate && (
              <InputSelect
                name="type"
                label="Collection Type"
                data={[
                  ...Object.values(CollectionType).map((value) => ({
                    value,
                    label: getDisplayName(value),
                  })),
                ]}
                clearable
              />
            )}

            {currentUser?.isModerator && (
              <>
                <InputSelect
                  name="write"
                  label="Add permissions"
                  data={Object.values(collectionWritePrivacyData)}
                />
                <InputSelect
                  name="mode"
                  label="Mode"
                  data={[
                    ...Object.values(CollectionMode)
                      .map((value) =>
                        [CollectionMode.Bookmark].some((v) => v === value)
                          ? undefined
                          : {
                              value,
                              label: getDisplayName(value),
                            }
                      )
                      .filter(isDefined),
                  ]}
                  clearable
                />
                {mode === CollectionMode.Contest && (
                  <>
                    <InputDatePicker
                      name="metadata.endsAt"
                      label="End Date"
                      placeholder="Select an end date"
                      icon={<IconCalendar size={16} />}
                      clearable
                    />
                    <Text size="xs" color="dimmed">
                      This is only used to stop recurring job updating the random indexes. We
                      suggest you add this in to save some resources, but this value will not be
                      shown to end-users.
                    </Text>
                    <InputDatePicker
                      name="metadata.submissionStartDate"
                      label="Submission Start Date"
                      placeholder="Select an start date"
                      icon={<IconCalendar size={16} />}
                      clearable
                    />
                    <InputDatePicker
                      name="metadata.submissionEndDate"
                      label="Submission End Date"
                      placeholder="Select an start date"
                      icon={<IconCalendar size={16} />}
                      clearable
                    />
                    <InputNumber
                      name="metadata.maxItemsPerUser"
                      label="Max items per user"
                      placeholder="Leave blank for unlimited"
                      clearable
                    />
                  </>
                )}
              </>
            )}
            <InputCheckbox name="nsfw" label="This collection contains mature content" mt="xs" />
            <Group position="right">
              <Button type="submit" loading={upsertCollectionMutation.isLoading}>
                Save
              </Button>
            </Group>
          </Stack>
        </Form>
      ) : (
        <NotFound />
      )}
    </Modal>
  );
}
