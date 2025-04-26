import {
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import {
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { IconArrowLeft, IconCalendar, IconPlus } from '@tabler/icons-react';
import { forwardRef, useEffect, useState } from 'react';
import { z } from 'zod';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import {
  Form,
  InputCheckbox,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
  InputDatePicker,
} from '~/libs/form';
import { AddCollectionItemInput, upsertCollectionInput } from '~/server/schema/collection.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  PrivacyData,
  collectionReadPrivacyData,
  collectionWritePrivacyData,
} from './collection.utils';
import { getDisplayName } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDefined } from '~/utils/type-guards';
import { closeAllModals, openModal } from '@mantine/modals';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';
import classes from './AddToCollectionModal.module.scss';

type Props = Partial<AddCollectionItemInput> & { createNew?: boolean };

const { openModal: openAddToCollectionModal, Modal } = createContextModal<Props>({
  name: 'addToCollection',
  title: 'Add to Collection',
  size: 'sm',
  Element: ({ context, props }) => {
    const [creating, setCreating] = useState(props.createNew ?? false);

    return creating ? (
      <NewCollectionForm
        {...props}
        onBack={() => setCreating(false)}
        onSubmit={() => context.close()}
      />
    ) : (
      <CollectionListForm
        {...props}
        onNewClick={() => setCreating(true)}
        onSubmit={() => context.close()}
      />
    );
  },
});

export { openAddToCollectionModal };
export default Modal;

type SelectedCollection = {
  collectionId: number;
  tagId?: number | null;
  userId: number;
  read: CollectionReadConfiguration;
};

function CollectionListForm({
  onNewClick,
  onSubmit,
  ...props
}: Props & { onNewClick: VoidFunction; onSubmit: VoidFunction }) {
  const { note, ...target } = props;
  const queryUtils = trpc.useUtils();
  const [selectedCollections, setSelectedCollections] = useState<SelectedCollection[]>([]);

  const { data: collections = [], isLoading: loadingCollections } =
    trpc.collection.getAllUser.useQuery({
      permissions: [
        CollectionContributorPermission.ADD,
        CollectionContributorPermission.ADD_REVIEW,
        CollectionContributorPermission.MANAGE,
      ],
      type: props.type,
    });

  const { data: collectionItems = [], isLoading: loadingStatus } =
    trpc.collection.getUserCollectionItemsByItem.useQuery({
      ...target,
    });

  // Ensures we don't present the user with a list of collections
  // before both things have loaded.
  const isLoading = loadingStatus || loadingCollections;
  const ownedCollections = collections.filter((collection) => collection.isOwner);
  const contributingCollections = collections.filter((collection) => !collection.isOwner);
  const features = useFeatureFlags();

  const addCollectionItemMutation = trpc.collection.saveItem.useMutation();
  const handleSubmit = () => {
    // We'll avoid re-adding the item into the collection if it already exists, so we must check for that.
    const existingCollectionIds = collectionItems.map((item) => item.collectionId);

    const collections = selectedCollections.filter(
      (c) => !existingCollectionIds.includes(c.collectionId) && c.collectionId
    );
    const removeFromCollectionIds = existingCollectionIds.filter(
      (collectionId) => !selectedCollections.some((c) => c.collectionId === collectionId)
    );

    if (!collections.length && !removeFromCollectionIds.length) {
      return onSubmit();
    }

    addCollectionItemMutation.mutate(
      { ...props, collections: selectedCollections, removeFromCollectionIds },
      {
        async onSuccess(result, { type, modelId, collections }) {
          const added = result.status === 'added';
          showNotification({
            title: added ? 'Item added' : 'Item removed',
            message: added
              ? 'Your item has been added to the selected collections.'
              : 'Your item has been removed from the selected collections.',
          });

          onSubmit();

          // Ask the user if they want to set this collection as the showcase collection for the model only
          if (
            added &&
            result.isOwner &&
            type === CollectionType.Model &&
            modelId &&
            collections.length === 1
          ) {
            const [collection] = collections;
            if (collection.read === CollectionReadConfiguration.Public) {
              openModal({
                title: 'Set Showcase Collection',
                centered: true,
                children: (
                  <ConfirmSetShowcaseCollection
                    modelId={modelId}
                    collectionId={collection.collectionId}
                  />
                ),
              });
            }
          }

          // TODO.optimization: Invalidate only the collection that was updated
          await queryUtils.collection.getUserCollectionItemsByItem.invalidate();
          // await endpointTarget?.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Unable to update item',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  useEffect(() => {
    if (collectionItems.length === 0) return;

    const existingSelectedCollections = collectionItems.map((collectionItem) => ({
      collectionId: collectionItem.collectionId,
      tagId: collectionItem.tagId,
      userId: collectionItem.collection.userId,
      read: collectionItem.collection.read,
    }));

    setSelectedCollections(existingSelectedCollections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionItems, props.articleId, props.imageId, props.modelId, props.postId]);

  return (
    <Stack>
      <ReadOnlyAlert />
      <Stack spacing="xl">
        <Stack spacing={4}>
          <Group position="apart">
            <Text size="sm" weight={500}>
              Your Collections
            </Text>
            <Button
              variant="subtle"
              size="xs"
              leftIcon={<IconPlus size={16} />}
              onClick={onNewClick}
            >
              New Collection
            </Button>
          </Group>
          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : (
            <ScrollArea.Autosize maxHeight={300}>
              <Stack spacing={4}>
                {ownedCollections.map((collection) => (
                  <Checkbox
                    key={collection.id}
                    label={
                      <Group spacing={4} noWrap>
                        <Text size="sm" weight={500}>
                          {collection.name}
                        </Text>
                        <Text size="xs" className={classes.description}>
                          {collection.description}
                        </Text>
                      </Group>
                    }
                    checked={selectedCollections.some((c) => c.collectionId === collection.id)}
                    onChange={(e) => {
                      if (e.currentTarget.checked) {
                        setSelectedCollections([
                          ...selectedCollections,
                          {
                            collectionId: collection.id,
                            userId: collection.userId,
                            read: collection.read,
                          },
                        ]);
                      } else {
                        setSelectedCollections(
                          selectedCollections.filter((c) => c.collectionId !== collection.id)
                        );
                      }
                    }}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>
        <Group position="right">
          <Button variant="default" leftIcon={<IconArrowLeft size={16} />} onClick={onSubmit}>
            Cancel
          </Button>
          <Button loading={addCollectionItemMutation.isLoading} onClick={handleSubmit}>
            Save
          </Button>
        </Group>
      </Stack>
    </Stack>
  );
}

const NOTIFICATION_ID = 'create-collection';
function NewCollectionForm({
  onSubmit,
  onBack,
  ...props
}: Props & { onSubmit: VoidFunction; onBack: VoidFunction }) {
  const currentUser = useCurrentUser();
  const form = useForm({
    schema: upsertCollectionInput,
    defaultValues: {
      type: CollectionType.Model,
      ...props,
      name: '',
      description: '',
      read: CollectionReadConfiguration.Private,
      write: CollectionWriteConfiguration.Private,
    },
    shouldUnregister: false,
  });
  const queryUtils = trpc.useUtils();

  const upsertCollectionMutation = trpc.collection.upsert.useMutation();
  const handleSubmit = (data: z.infer<typeof upsertCollectionInput>) => {
    showNotification({
      id: NOTIFICATION_ID,
      loading: true,
      disallowClose: true,
      autoClose: false,
      message: 'Creating collection...',
    });

    upsertCollectionMutation.mutate(data, {
      async onSuccess(result, { type, modelId }) {
        await queryUtils.collection.getAllUser.invalidate();
        await queryUtils.collection.getUserCollectionItemsByItem.invalidate();
        onSubmit();

        if (
          type === CollectionType.Model &&
          modelId &&
          result.read === CollectionReadConfiguration.Public &&
          result.isOwner
        ) {
          openModal({
            title: 'Set Showcase Collection',
            centered: true,
            children: <ConfirmSetShowcaseCollection modelId={modelId} collectionId={result.id} />,
          });
        }

        showSuccessNotification({
          title: 'Collection created',
          message: 'Your collection has been created.',
        });
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to create collection',
          error: new Error(error.message),
        });
      },
      onSettled() {
        hideNotification(NOTIFICATION_ID);
      },
    });
  };

  const mode = form.watch('mode');

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Stack spacing={4}>
          <Group position="apart">
            <Text size="sm" weight="bold">
              New Collection
            </Text>
            <Button
              variant="subtle"
              size="xs"
              leftIcon={<IconArrowLeft size={16} />}
              onClick={onBack}
              compact
            >
              Back to selection
            </Button>
          </Group>
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
            itemComponent={SelectItem}
          />
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
                    This is only used to stop recurring job updating the random indexes. We suggest
                    you add this in to save some resources, but this value will not be shown to
                    end-users.
                  </Text>
                </>
              )}
            </>
          )}
          <InputCheckbox name="nsfw" label="This collection contains mature content" mt="xs" />
        </Stack>
        <Group position="right">
          <Button type="submit" loading={upsertCollectionMutation.isLoading}>
            Create
          </Button>
        </Group>
      </Stack>
    </Form>
  );
}

const SelectItem = forwardRef<HTMLDivElement, PrivacyData>(
  ({ label, description, icon: Icon, ...otherProps }, ref) => {
    return (
      <div ref={ref} {...otherProps}>
        <Group align="center" noWrap>
          <Icon size={18} />
          <div>
            <Text size="sm">{label}</Text>
            <Text size="xs" sx={{ opacity: 0.7 }}>
              {description}
            </Text>
          </div>
        </Group>
      </div>
    );
  }
);
SelectItem.displayName = 'SelectItem';

function ConfirmSetShowcaseCollection({
  modelId,
  collectionId,
}: {
  modelId: number;
  collectionId: number;
}) {
  const setShowcaseCollectionMutation = trpc.model.setCollectionShowcase.useMutation({
    onSuccess: () => closeAllModals(),
  });

  const handleSetShowcase = () => {
    setShowcaseCollectionMutation.mutate({ id: modelId, collectionId });
  };

  return (
    <div className="flex flex-col gap-4">
      <Text>Would you like to set this collection as this model&apos;s showcase collection?</Text>
      <div className="flex justify-end gap-2">
        <Button variant="default">No</Button>
        <Button onClick={handleSetShowcase} loading={setShowcaseCollectionMutation.isLoading}>
          Yes
        </Button>
      </div>
    </div>
  );
}

