import {
  Badge,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Modal,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import {
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { IconArrowLeft, IconCalendar, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import { createElement, forwardRef, useEffect, useState } from 'react';
import type * as z from 'zod';
import {
  Form,
  InputCheckbox,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
  InputDatePicker,
} from '~/libs/form';
import type { AddCollectionItemInput } from '~/server/schema/collection.schema';
import { upsertCollectionInput } from '~/server/schema/collection.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { PrivacyData } from './collection.utils';
import {
  collectionReadPrivacyData,
  collectionTypeData,
  collectionWritePrivacyData,
  useCollectionsPermissionsMap,
} from './collection.utils';
import { getDisplayName } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDefined } from '~/utils/type-guards';
import { closeModal, openModal } from '@mantine/modals';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ReadOnlyAlert } from '~/components/ReadOnlyAlert/ReadOnlyAlert';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import classes from './AddToCollectionModal.module.scss';

const SHOWCASE_COLLECTION_MODAL_ID = 'set-showcase-collection';

type Props = Partial<AddCollectionItemInput> & { createNew?: boolean };

export default function AddToCollectionModal(props: Props) {
  const dialog = useDialogContext();
  const [creating, setCreating] = useState(props.createNew ?? false);
  // Carried over from the picker's search: someone who searched for a collection that doesn't
  // exist is describing the one they want to make.
  const [newCollectionName, setNewCollectionName] = useState('');

  // Create dynamic title based on collection type
  const getModalTitle = () => {
    if (creating) return 'New Collection';
    if (!props.type) return 'Add to Collection';
    const typeData = collectionTypeData[props.type];
    return (
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon size={24} variant="light" color={typeData.color}>
          {createElement(typeData.icon, { size: 16 })}
        </ThemeIcon>
        <Text size="lg" fw={600}>
          Add to {typeData.label} Collection
        </Text>
      </Group>
    );
  };

  return (
    <Modal {...dialog} title={getModalTitle()} size="sm">
      {creating ? (
        <NewCollectionForm
          {...props}
          defaultName={newCollectionName}
          onBack={() => setCreating(false)}
          onSubmit={() => dialog.onClose()}
        />
      ) : (
        <CollectionListForm
          {...props}
          onNewClick={(name) => {
            setNewCollectionName(name ?? '');
            setCreating(true);
          }}
          onSubmit={() => dialog.onClose()}
        />
      )}
    </Modal>
  );
}

type SelectedCollection = {
  collectionId: number;
  tagId?: number | null;
  userId: number;
  read: CollectionReadConfiguration;
};

// Collections closed to new entries render disabled here rather than being filtered out — an
// option that silently vanishes from the picker reads as deleted, not paused.
const COLLABORATION_CLOSED_TOOLTIP = "This collection isn't accepting new entries right now.";

// Reusable collection checkbox item component
function CollectionCheckboxItem({
  collection,
  meta,
  savedState,
  selectedItem,
  disabled,
  disabledReason,
  onToggle,
  onTagChange,
}: {
  collection: {
    id: number;
    name: string;
    read: CollectionReadConfiguration;
    tags?: Array<{ id: number; name: string; filterableOnly?: boolean }>;
  };
  /** Role and owner, for collections that aren't the user's own. */
  meta?: string;
  /** Set only for collections this item is already in — 'removing' once it is unticked. */
  savedState?: 'saved' | 'removing';
  selectedItem?: SelectedCollection;
  // disabled also covers "not yet known" (still loading) so nothing is briefly clickable;
  // disabledReason is true only once we know it's actually closed, for the tooltip.
  disabled?: boolean;
  disabledReason?: boolean;
  onToggle: (selected: boolean) => void;
  onTagChange: (tagId: number | null) => void;
}) {
  const privacy = collectionReadPrivacyData[collection.read];
  const Icon = privacy.icon;
  const availableTags = (collection.tags ?? []).filter(
    (t) => !t.filterableOnly || t.id === selectedItem?.tagId
  );

  return (
    <Stack className={classes.contentWrap} gap={0}>
      <Tooltip label={COLLABORATION_CLOSED_TOOLTIP} disabled={!disabledReason} position="top-start">
        <Checkbox
          classNames={classes}
          checked={!!selectedItem}
          disabled={disabled}
          onChange={() => {
            onToggle(!!selectedItem);
          }}
          label={
            <Group gap="sm" justify="space-between" w="100%" wrap="nowrap">
              <Stack gap={0} className="min-w-0">
                <Group gap={6} wrap="nowrap">
                  <Text lineClamp={1} inherit className={classes.collectionName}>
                    {collection.name}
                  </Text>
                  {savedState && (
                    <Badge
                      size="xs"
                      variant="light"
                      color={savedState === 'removing' ? 'red' : 'gray'}
                      className="shrink-0"
                    >
                      {savedState === 'removing' ? 'Removing' : 'Saved'}
                    </Badge>
                  )}
                </Group>
                {meta && (
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {meta}
                  </Text>
                )}
              </Stack>
              <Tooltip label={privacy.label} position="left" withArrow>
                <ThemeIcon size={20} variant="light" color="gray" className={classes.privacyIcon}>
                  <Icon size={14} />
                </ThemeIcon>
              </Tooltip>
            </Group>
          }
        />
      </Tooltip>
      {selectedItem && availableTags.length > 0 && (
        <Select
          withAsterisk
          placeholder="Select a tag for your entry in the contest"
          size="xs"
          label="Tag your entry"
          value={selectedItem.tagId?.toString() ?? null}
          comboboxProps={{ withinPortal: true, zIndex: 500 }}
          onChange={(value) => onTagChange(value ? parseInt(value, 10) : null)}
          clearable={false}
          allowDeselect={false}
          autoFocus
          data={availableTags.map((tag) => ({
            value: tag.id.toString(),
            label: tag.name,
          }))}
        />
      )}
    </Stack>
  );
}

function CollectionListForm({
  onNewClick,
  onSubmit,
  ...props
}: Props & { onNewClick: (name?: string) => void; onSubmit: VoidFunction }) {
  const { note, ...target } = props;
  const queryUtils = trpc.useUtils();
  const [selectedCollections, setSelectedCollections] = useState<SelectedCollection[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);

  // Model saves also surface active contest collections the user hasn't joined, so they can
  // submit an entry for review without following the collection first.
  const includeActiveContests = props.type === CollectionType.Model;

  const { data: collections = [], isLoading: loadingCollections } =
    trpc.collection.getAllUser.useQuery({
      // Only request collections where the user can actually add items.
      // MANAGE-only contributors on a Private-write collection can configure
      // the collection but can't write to it, so including MANAGE here would
      // surface unsaveable collections in the picker.
      permissions: [
        CollectionContributorPermission.ADD,
        CollectionContributorPermission.ADD_REVIEW,
      ],
      type: props.type,
      includeActiveContests,
      // Active contests only surface for models the user owns, so the server can gate the branch
      // on ownership. Only meaningful when includeActiveContests is true (Model saves).
      contestModelId: props.modelId,
      // Archived collections accept no new entries, so keep them out of the picker entirely.
      excludeArchived: true,
    });

  const { data: collectionItems = [], isLoading: loadingStatus } =
    trpc.collection.getUserCollectionItemsByItem.useQuery({
      ...target,
      excludeArchived: true,
    });

  // Ensures we don't present the user with a list of collections
  // before both things have loaded.
  const isLoading = loadingStatus || loadingCollections;
  const features = useFeatureFlags();
  const { map: permissionsByCollectionId, isLoading: loadingPermissions } =
    useCollectionsPermissionsMap(collections.map((c) => c.id));

  // A checked collection always survives the filter: hiding a row that is still queued for the
  // save is how someone removes an entry without meaning to.
  const matchesSearch = (collection: { id: number; name: string }) =>
    !debouncedSearch ||
    collection.name.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
    selectedCollections.some((c) => c.collectionId === collection.id);

  const visible = collections.filter(matchesSearch);
  const ownedCollections = visible.filter((collection) => collection.isOwner);
  // Active contests are only requested (and thus split out) for model saves; for every other type
  // the flag is off and this group is empty, so contributing behaves exactly as before.
  const activeContestCollections = includeActiveContests
    ? visible.filter(
        (collection) => !collection.isOwner && collection.mode === CollectionMode.Contest
      )
    : [];
  const otherCollections = visible.filter(
    (collection) =>
      !collection.isOwner &&
      !(includeActiveContests && collection.mode === CollectionMode.Contest)
  );
  // Submitting follows, so most of these are collections the user followed by posting to them, not
  // ones they were invited to — one "Shared with you" heading over both is wrong about the follows.
  // Held together until the permission map lands, because splitting on half-loaded data walks rows
  // from one group to the other as it arrives.
  const sharedCollections = loadingPermissions
    ? otherCollections
    : otherCollections.filter((c) => permissionsByCollectionId.get(c.id)?.isCollaborator);
  const followedCollections = loadingPermissions
    ? []
    : otherCollections.filter((c) => !permissionsByCollectionId.get(c.id)?.isCollaborator);
  // While permission data for a collection is unknown, treat it as closed rather than open —
  // it must never be briefly selectable before flipping to disabled once data arrives. A lapse
  // keeps write for the owner and for elevated collaborators, so it only closes the picker for
  // people who actually lost it — otherwise a lapsed owner finds their OWN collection greyed
  // out with the visitor copy.
  const getCollaborationState = (collectionId: number) => {
    const permissions = permissionsByCollectionId.get(collectionId);
    const collaborationDisabled =
      !!permissions?.collaborationDisabled && !permissions?.write && !permissions?.writeReview;
    return {
      disabled: loadingPermissions || collaborationDisabled,
      disabledReason: !loadingPermissions && collaborationDisabled,
    };
  };

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
      { ...props, collections, removeFromCollectionIds },
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
                modalId: SHOWCASE_COLLECTION_MODAL_ID,
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

  const metaFor = (collection: (typeof collections)[number]) => {
    if (collection.isOwner) return undefined;
    const permissions = permissionsByCollectionId.get(collection.id);
    const role = permissions?.isCollaborator
      ? permissions.manage
        ? 'Manager'
        : 'Contributor'
      : null;
    return [role, collection.ownerUsername ? `by ${collection.ownerUsername}` : null]
      .filter(isDefined)
      .join(' · ');
  };

  // What Save will actually do to a collection this item is already in. Without it a row the
  // user is about to remove looks exactly like one they never touched.
  const savedCollectionIds = new Set(collectionItems.map((item) => item.collectionId));
  const savedStateFor = (collectionId: number) => {
    if (!savedCollectionIds.has(collectionId)) return undefined;
    return selectedCollections.some((c) => c.collectionId === collectionId)
      ? ('saved' as const)
      : ('removing' as const);
  };

  const renderItem = (collection: (typeof collections)[number]) => (
    <CollectionCheckboxItem
      key={collection.id}
      collection={collection}
      meta={metaFor(collection)}
      savedState={savedStateFor(collection.id)}
      selectedItem={selectedCollections.find((c) => c.collectionId === collection.id)}
      {...getCollaborationState(collection.id)}
      onToggle={(isSelected) => {
        if (isSelected) {
          setSelectedCollections((curr) => curr.filter((c) => c.collectionId !== collection.id));
        } else {
          setSelectedCollections((curr) => [
            ...curr,
            {
              collectionId: collection.id,
              tagId: collection.tags?.length > 0 ? collection.tags[0].id : null,
              userId: collection.userId,
              read: collection.read,
            },
          ]);
        }
      }}
      onTagChange={(tagId) => {
        setSelectedCollections((curr) =>
          curr.map((c) => (c.collectionId === collection.id ? { ...c, tagId } : c))
        );
      }}
    />
  );

  const groups = [
    { key: 'owned', label: 'Your collections', items: ownedCollections },
    { key: 'shared', label: 'Shared with you', items: sharedCollections },
    { key: 'following', label: 'Collections you follow', items: followedCollections },
    {
      key: 'contests',
      label: 'Active contests',
      description: 'Submit this model as an entry. It will be sent to the contest for review.',
      items: activeContestCollections,
    },
  ].filter((group) => group.items.length > 0);

  // The debounce means the list lags the keystrokes; without this the picker looks like it
  // ignored the last thing typed.
  const searching = search.trim() !== debouncedSearch;

  return (
    <Stack>
      <ReadOnlyAlert />
      <Stack gap="xl">
        <Stack gap={8}>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <TextInput
              className="grow"
              placeholder="Search collections"
              aria-label="Search collections"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && search) {
                  event.stopPropagation();
                  setSearch('');
                }
              }}
              rightSection={
                search ? (
                  <LegacyActionIcon size="sm" variant="subtle" onClick={() => setSearch('')}>
                    <IconX size={14} />
                  </LegacyActionIcon>
                ) : null
              }
              size="xs"
              autoFocus
            />
            <Button
              variant="subtle"
              leftSection={<IconPlus size={16} />}
              onClick={() => onNewClick(search.trim())}
              size="compact-xs"
              className="shrink-0"
              h={30}
            >
              New collection
            </Button>
          </Group>
          {isLoading ? (
            <Center py="xl">
              <Loader type="bars" />
            </Center>
          ) : groups.length === 0 ? (
            <Stack align="center" gap="sm" py="xl" px="md">
              <Text c="dimmed" ta="center">
                {!debouncedSearch
                  ? `You don't have any ${props.type?.toLowerCase() ?? ''} collections yet.`
                  : searching
                  ? 'Searching…'
                  : `No collections match “${debouncedSearch}”.`}
              </Text>
              {!!debouncedSearch && !searching && (
                <Button
                  variant="light"
                  size="compact-sm"
                  leftSection={<IconPlus size={16} />}
                  onClick={() => onNewClick(debouncedSearch)}
                >
                  Create “{debouncedSearch}”
                </Button>
              )}
            </Stack>
          ) : (
            <ScrollArea.Autosize mah={400}>
              {/* The headings carry the grouping on their own — rules between them read as extra
                  structure the list doesn't have. Hierarchy is the gap: tight inside a group,
                  generous between them. */}
              <Stack gap="lg">
                {groups.map((group) => (
                  <Stack key={group.key} gap={4}>
                    <Group gap={6} align="baseline" wrap="nowrap">
                      <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="tracking-wide">
                        {group.label}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {group.items.length}
                      </Text>
                    </Group>
                    {group.description && (
                      <Text size="xs" c="dimmed">
                        {group.description}
                      </Text>
                    )}
                    {group.items.map(renderItem)}
                  </Stack>
                ))}
                {searching && (
                  <Text size="xs" c="dimmed" ta="center" py={4}>
                    Searching…
                  </Text>
                )}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>

        <Group justify="flex-end">
          <Button
            disabled={!features.canWrite}
            loading={addCollectionItemMutation.isPending}
            onClick={handleSubmit}
          >
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
  defaultName = '',
  ...props
}: Props & { onSubmit: VoidFunction; onBack: VoidFunction; defaultName?: string }) {
  const currentUser = useCurrentUser();
  const isMember = !!currentUser?.tier && currentUser.tier !== 'free';
  const form = useForm({
    schema: upsertCollectionInput,
    defaultValues: {
      type: CollectionType.Model,
      ...props,
      name: defaultName,
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
      withCloseButton: false,
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
            modalId: SHOWCASE_COLLECTION_MODAL_ID,
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
      <Stack gap="xl">
        <Stack gap={4}>
          <Group justify="space-between">
            <Text size="sm" fw="bold">
              New Collection
            </Text>
            <Button
              variant="subtle"
              leftSection={<IconArrowLeft size={16} />}
              onClick={onBack}
              size="compact-xs"
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
            renderOption={(item) => {
              const data =
                collectionReadPrivacyData[item.option.value as CollectionReadConfiguration];
              return <SelectItem {...data} {...item} />;
            }}
          />
          {(isMember || currentUser?.isModerator) && (
            <InputSelect
              name="write"
              label="Who can add to this collection"
              data={Object.values(collectionWritePrivacyData)}
            />
          )}

          {currentUser?.isModerator && (
            <>
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
                    leftSection={<IconCalendar size={16} />}
                    clearable
                  />
                  <Text size="xs" c="dimmed">
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
        <Group justify="flex-end">
          <Button type="submit" loading={upsertCollectionMutation.isPending}>
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
        <Group align="center" wrap="nowrap">
          <Icon size={18} />
          <div>
            <Text size="sm">{label}</Text>
            <Text size="xs" style={{ opacity: 0.7 }}>
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
    onSuccess: () => closeModal(SHOWCASE_COLLECTION_MODAL_ID),
  });

  const handleSetShowcase = () => {
    setShowcaseCollectionMutation.mutate({ id: modelId, collectionId });
  };

  return (
    <div className="flex flex-col gap-4">
      <Text>Would you like to set this collection as this model&apos;s showcase collection?</Text>
      <div className="flex justify-end gap-2">
        <Button variant="default" onClick={() => closeModal(SHOWCASE_COLLECTION_MODAL_ID)}>
          No
        </Button>
        <Button onClick={handleSetShowcase} loading={setShowcaseCollectionMutation.isPending}>
          Yes
        </Button>
      </div>
    </div>
  );
}
