import {
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { hideNotification, showNotification } from '@mantine/notifications';
import {
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '@prisma/client';
import { IconArrowLeft, IconCalendar, IconPlus } from '@tabler/icons-react';
import { forwardRef, useEffect, useState } from 'react';
import { z } from 'zod';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import {
  Form,
  InputCheckboxGroup,
  InputCheckbox,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
  InputDatePicker,
} from '~/libs/form';
import {
  AddCollectionItemInput,
  saveCollectionItemInputSchema,
  upsertCollectionInput,
} from '~/server/schema/collection.schema';
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

const useCollectionListStyles = createStyles((theme) => ({
  body: { alignItems: 'center', paddingTop: theme.spacing.xs, paddingBottom: theme.spacing.xs },
  labelWrapper: { flex: 1 },
}));

function CollectionListForm({
  onNewClick,
  onSubmit,
  ...props
}: Props & { onNewClick: VoidFunction; onSubmit: VoidFunction }) {
  const { note, ...target } = props;
  const { classes } = useCollectionListStyles();
  const form = useForm({
    schema: saveCollectionItemInputSchema,
    defaultValues: { ...props, collectionIds: [] },
    shouldUnregister: false,
  });
  const queryUtils = trpc.useContext();

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

  // Needs to be outside the handleSubmit for it to pick up the right value for some reason :shrug:
  const { isDirty } = form.formState;

  const addCollectionItemMutation = trpc.collection.saveItem.useMutation();
  const handleSubmit = (data: AddCollectionItemInput) => {
    if (!isDirty) return onSubmit();

    // We'll avoid re-adding the item into the collection if it already exists, so we must check for that.
    const existingCollectionIds = collectionItems.map((item) => item.collectionId);

    const collectionIds = data.collectionIds.filter(
      (collectionId) => !existingCollectionIds.includes(collectionId) && collectionId
    );
    const removeFromCollectionIds = existingCollectionIds.filter(
      (collectionId) => !data.collectionIds.includes(collectionId)
    );

    if (!collectionIds.length && !removeFromCollectionIds.length) {
      return onSubmit();
    }

    addCollectionItemMutation.mutate(
      { ...data, collectionIds, removeFromCollectionIds },
      {
        async onSuccess(_, { type }) {
          showNotification({
            title: 'Item added',
            message: 'Your item has been added to the selected collections.',
          });

          onSubmit();

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

    const collectionIds = collectionItems.map((collectionItem) =>
      collectionItem.collectionId.toString()
    );

    // Ignoring because CheckboxGroup only accepts string[] to
    // keep track of the selected values but actual schema should be number[]
    // @ts-ignore: See above
    form.reset({ ...props, collectionIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionItems, props.articleId, props.imageId, props.modelId, props.postId]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="xl">
        <Stack spacing={4}>
          <Group spacing="xs" position="apart" noWrap>
            <Text size="sm" weight="bold">
              Your collections
            </Text>
            <Button
              variant="subtle"
              size="xs"
              leftIcon={<IconPlus size={16} />}
              onClick={onNewClick}
              compact
            >
              New collection
            </Button>
          </Group>
          {isLoading ? (
            <Center py="xl">
              <Loader variant="bars" />
            </Center>
          ) : (
            <>
              <ScrollArea.Autosize maxHeight={200}>
                {ownedCollections.length > 0 ? (
                  <InputCheckboxGroup name="collectionIds" orientation="vertical" spacing={4}>
                    {ownedCollections.map((collection) => {
                      const Icon = collectionReadPrivacyData[collection.read].icon;

                      return (
                        <Checkbox
                          key={collection.id}
                          classNames={classes}
                          value={collection.id.toString()}
                          label={
                            <Group spacing="xs" position="apart" w="100%" noWrap>
                              <Text lineClamp={1} inherit>
                                {collection.name}
                              </Text>
                              <Icon size={18} />
                            </Group>
                          }
                        />
                      );
                    })}
                  </InputCheckboxGroup>
                ) : (
                  <Center py="xl">
                    <Text color="dimmed">{`You don't have any ${
                      props.type?.toLowerCase() || ''
                    } collections yet.`}</Text>
                  </Center>
                )}
              </ScrollArea.Autosize>
              {contributingCollections.length > 0 && (
                <>
                  <Text size="sm" weight="bold" mt="md">
                    Collections you contribute to
                  </Text>
                  <ScrollArea.Autosize maxHeight={200}>
                    <InputCheckboxGroup name="collectionIds" orientation="vertical" spacing={4}>
                      {contributingCollections.map((collection) => {
                        const collectionItem = collectionItems.find(
                          (item) => item.collectionId === collection.id
                        );
                        const Icon = collectionReadPrivacyData[collection.read].icon;

                        return (
                          <Checkbox
                            key={collection.id}
                            classNames={classes}
                            value={collection.id.toString()}
                            disabled={collectionItem && !collectionItem.canRemoveItem}
                            label={
                              <Group spacing="xs" position="apart" w="100%" noWrap>
                                <Text lineClamp={1} inherit>
                                  {collection.name}
                                </Text>
                                <Icon size={18} />
                              </Group>
                            }
                          />
                        );
                      })}
                    </InputCheckboxGroup>
                  </ScrollArea.Autosize>
                </>
              )}
            </>
          )}
        </Stack>

        <Group position="right">
          <Button type="submit" loading={addCollectionItemMutation.isLoading}>
            Save
          </Button>
        </Group>
      </Stack>
    </Form>
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
  const queryUtils = trpc.useContext();

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
      async onSuccess() {
        await queryUtils.collection.getAllUser.invalidate();
        await queryUtils.collection.getUserCollectionItemsByItem.invalidate();
        onSubmit();
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
