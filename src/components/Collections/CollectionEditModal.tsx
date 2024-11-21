import { Button, Center, Divider, Group, Input, Loader, Modal, Stack, Text } from '@mantine/core';

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
  InputTags,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { UpsertCollectionInput, upsertCollectionInput } from '~/server/schema/collection.schema';
import { trpc } from '~/utils/trpc';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CollectionMode, CollectionType, TagTarget } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getDisplayName } from '~/utils/string-helpers';
import { IconCalendar } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useRouter } from 'next/router';
import { isDefined } from '~/utils/type-guards';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

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
    <Modal {...dialog} size="lg" title={isCreate ? 'Create collection' : 'Edit collection'}>
      {isLoading ? (
        <Center py="xl">
          <Loader variant="bars" />
        </Center>
      ) : canEdit || isCreate ? (
        <Form form={form} onSubmit={handleSubmit}>
          <Stack spacing="sm">
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
                    <Divider label="Contest Details" />
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
                    {data?.collection?.type === CollectionType.Image && (
                      <InputCheckbox
                        name="metadata.existingEntriesDisabled"
                        label="Existing entries disabled"
                        description="Makes it so that the + button takes you directly to the create flow, bypassing existing images selection. Users can still circumbent this by following the collection & selecting an image."
                      />
                    )}
                    <InputTags
                      name="tags"
                      label={
                        <Group spacing={4} noWrap>
                          <Input.Label>Tags</Input.Label>
                          <InfoPopover type="hover" size="xs" iconProps={{ size: 14 }}>
                            <Text>
                              When submitting items to this collection, users will be able to tag
                              their submission with one of the provided tag. This will make
                              filtering and searching these entries much easier. At the moment, only
                              1 tag per item is allowed.
                            </Text>
                          </InfoPopover>
                        </Group>
                      }
                      target={[TagTarget.Collection]}
                    />
                    <Divider label="Judging details" />

                    {data?.collection?.type === CollectionType.Image && (
                      <InputCheckbox
                        name="metadata.judgesApplyBrowsingLevel"
                        label="Judges apply NSFW Rating"
                        description="This will make it so that people with Manage permission on the collection apply NSFW rating to the submissions. Subsmissions made to this collection will not be publicly visible until they're rated."
                      />
                    )}
                    {data?.collection?.type === CollectionType.Image && (
                      <InputCheckbox
                        name="metadata.judgesCanScoreEntries"
                        label="Judges can score entries"
                        description="Judges / Moderators of this collection will be able to leave a 1-10 score on each entry in this collection."
                      />
                    )}
                    <InputDatePicker
                      name="metadata.votingPeriodStart"
                      label="Sets a start date for Reactions on the entries"
                      description="This will lock the reactions on these entries. Use with care, ideally only when the contest rely on reactions from users. Leaving this blank makes it so that they're always reactable."
                      placeholder="Select a voting period start date"
                      icon={<IconCalendar size={16} />}
                      clearable
                    />
                  </>
                )}
              </>
            )}

            <Divider label="Extras" />
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
