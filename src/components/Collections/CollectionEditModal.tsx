import { Button, Center, Divider, Group, Input, Loader, Modal, Stack, Text } from '@mantine/core';

import { useEffect, useState } from 'react';
import {
  collectionReadPrivacyData,
  collectionWritePrivacyData,
  useCollection,
  useMutateCollection,
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

  const {
    collection,
    permissions: queryPermissions,
    isLoading: queryLoading,
  } = useCollection(collectionId as number, {
    enabled: !!collectionId,
  });
  const [youtubeAuthUrl, setYoutubeAuthUrl] = useState<string | null>(null);
  const { getYoutubeAuthUrl, getYoutubeAuthUrlLoading } = useMutateCollection();

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
    if (collection) {
      const result = upsertCollectionInput.safeParse({
        ...collection,
        type: collection.type ?? CollectionType.Model,
        mode: collection.mode,
        metadata: collection.metadata ?? {},
      });
      if (result.success) form.reset({ ...result.data });
      else console.error(result.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);

  const getYoutubeUrlHandler = async () => {
    if (!collection) {
      return;
    }

    if (youtubeAuthUrl) {
      window.location.href = youtubeAuthUrl;
    } else {
      const url = await getYoutubeAuthUrl({ id: collection.id as number });
      setYoutubeAuthUrl(url);
    }
  };

  const permissions = queryPermissions ?? { manage: false, write: false };
  const canEdit = !!collection && permissions.manage;
  const isCreate = !collectionId;
  const isImageCollection = collection?.type === CollectionType.Image;
  const isPostCollection = collection?.type === CollectionType.Post;  
  const isContestMode = collection?.mode === CollectionMode.Contest;

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
                {isContestMode && (
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
                    {isImageCollection && (
                      <InputCheckbox
                        name="metadata.existingEntriesDisabled"
                        label="Existing entries disabled"
                        description="Makes it so that the + button takes you directly to the create flow, bypassing existing images selection. Users can still circumbent this by following the collection & selecting an image."
                      />
                    )}
                    {isImageCollection && (
                      <InputCheckbox
                        name="metadata.disableFollowOnSubmission"
                        label="Submitting an entry will not follow the collection"
                      />
                    )}
                    <InputDatePicker
                      name="metadata.votingPeriodStart"
                      label="When voting for this contest will start"
                      description="This will lock the ratings on these entries. Use with care. Leaving this blank makes it so that they're always reactable."
                      placeholder="Select a voting period start date"
                      icon={<IconCalendar size={16} />}
                      clearable
                    />
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
                    <InputCheckbox
                      name="metadata.disableTagRequired"
                      label="Tags are not required"
                      description="If enabled, users will be able to submit items without a tag even when tags are setup."
                    />
                    <Divider label="Judging details" />

                    {isImageCollection && (
                      <InputCheckbox
                        name="metadata.judgesApplyBrowsingLevel"
                        label="Judges apply NSFW Rating"
                        description="This will make it so that people with Manage permission on the collection apply NSFW rating to the submissions. Subsmissions made to this collection will not be publicly visible until they're rated."
                      />
                    )}
                    {isImageCollection && (
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

                    {isImageCollection && (
                      <>
                        <Divider label="Youtube Support" />
                        <Input.Wrapper
                          label="Add Youtube Support"
                          description="By enabling youtube support, videos that are longer than 30s will be uploaded to youtube and youtube will be used to play them on the site. Note channels are exclusive to the collection and cannot be used in other collections."
                          descriptionProps={{ mb: 12 }}
                        >
                          {collection.metadata?.youtubeSupportEnabled ? (
                            <Text size="sm" color="primary">
                              Youtube support is enabled for this collection.
                            </Text>
                          ) : (
                            <Button
                              onClick={getYoutubeUrlHandler}
                              loading={getYoutubeAuthUrlLoading}
                            >
                              {youtubeAuthUrl ? 'Sign in with Youtube' : 'Enable Youtube Support'}
                            </Button>
                          )}
                        </Input.Wrapper>
                      </>
                    )}
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
