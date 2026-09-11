import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { ComboboxItem } from '@mantine/core';
import { Stack, Text, Card, Group, Button, Center, Loader, Badge, Box, Chip } from '@mantine/core';
import type { AssociationType } from '~/shared/utils/prisma/enums';
import { IconGripVertical, IconTrash, IconUser } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { forwardRef, useEffect, useState } from 'react';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import type { AssociatedResourceModel } from '~/server/selectors/model.selector';
import type { ModelGetAssociatedResourcesSimple } from '~/types/router';
import { trpc } from '~/utils/trpc';
import type { QuickSearchDropdownProps } from '../Search/QuickSearchDropdown';
import { QuickSearchDropdown } from '../Search/QuickSearchDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  getIsSafeBrowsingLevel,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { constants } from '~/server/common/constants';
import { selectNewlyAddedModelIds } from '~/server/services/model-association.utils';
import { showWarningNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';

type State = Array<Omit<ModelGetAssociatedResourcesSimple[number], 'id'> & { id?: number }>;

export function AssociateModels({
  fromId,
  type,
  ownerId,
  onSave,
}: {
  fromId: number;
  type: AssociationType;
  ownerId: number;
  onSave?: () => void;
}) {
  const limit = constants.modelAssociations.limit;
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [changed, setChanged] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const { data = [], isLoading } = trpc.model.getAssociatedResourcesSimple.useQuery({
    fromId,
    type,
    browsingLevel: allBrowsingLevelsFlag,
  });
  const [associatedResources, setAssociatedResources] = useState<State>(data);
  const [linkBack, setLinkBack] = useState<number[]>([]);
  const [searchMode, setSearchMode] = useState<'me' | 'all'>('all');

  const { mutate, isPending: isSaving } = trpc.model.setAssociatedResources.useMutation({
    onSuccess: async (result) => {
      const declined = result.reciprocal.skipped.filter((x) => x.reason !== 'alreadyLinked');
      if (declined.length)
        showWarningNotification({
          title: 'Some links back were not added',
          message: `${declined.length} of the resources you added could not be linked back — either they belong to someone else, or their own suggested resources are already full.`,
        });

      // Refetch instead of seeding the cache with the local rows. They carry no association
      // ids, and staleTime is Infinity, so writing them back leaves the next open of this
      // modal unable to tell a saved resource from a newly added one.
      await Promise.all([
        queryUtils.model.getAssociatedResourcesSimple.invalidate({
          fromId,
          type,
          browsingLevel: allBrowsingLevelsFlag,
        }),
        queryUtils.model.getAssociatedResourcesCardData.invalidate({ fromId, type }),
      ]);
      setChanged(false);
      setLinkBack([]);
      onSave?.();
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      const resources = [...associatedResources];
      const ids: UniqueIdentifier[] = resources.map(({ item }) => item.id);
      const oldIndex = ids.indexOf(active.id);
      const newIndex = ids.indexOf(over.id);
      const sorted = arrayMove(resources, oldIndex, newIndex);
      setAssociatedResources(sorted);
      setChanged(!isEqual(data, sorted));
    }
  };

  const handleSelect: QuickSearchDropdownProps['onItemSelected'] = (item, data) => {
    setChanged(true);
    setAssociatedResources((resources) => {
      if (item.entityType === 'Model') {
        const itemData = data as SearchIndexDataMap['models'][number];
        return resources.some((r) => r.item.id === item.entityId) || item.entityId === fromId
          ? resources
          : [...resources, { resourceType: 'model' as const, item: itemData }];
      }

      const itemData = data as SearchIndexDataMap['articles'][number];
      return resources.some((r) => r.item.id === item.entityId) || item.entityId === fromId
        ? resources
        : [...resources, { resourceType: 'article' as const, item: itemData }];
    });
  };

  const handleRemove = (id: number) => {
    const models = [...associatedResources.filter(({ item }) => item.id !== id)];
    setAssociatedResources(models);
    // Drop the tick too: re-adding the row in the same edit would otherwise arrive
    // pre-ticked and write a back-link the user never asked for in this composition.
    setLinkBack((current) => current.filter((modelId) => modelId !== id));
    setChanged(!isEqual(data, models));
  };

  const handleReset = () => {
    setChanged(false);
    setLinkBack([]);
    setAssociatedResources(data);
  };

  const handleSave = () => {
    mutate({
      fromId,
      type,
      associations: associatedResources.map(({ id, resourceType, item }) => ({
        id,
        resourceType,
        resourceId: item.id,
      })),
      reciprocal: linkBack.filter((id) => reciprocalEligible.has(id)),
    });
  };

  const toggleSearchMode = () => setSearchMode((current) => (current === 'me' ? 'all' : 'me'));

  useEffect(() => {
    if (!associatedResources.length && data.length) {
      setAssociatedResources(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const onlyMe = searchMode === 'me';

  // The model ids this model already points at, taken from the saved list rather than from
  // whether a row carries an association id. Same question the server asks, same answer.
  const savedTargetIds = new Set(
    data.filter(({ resourceType }) => resourceType === 'model').map(({ item }) => item.id)
  );
  const newlyAdded = selectNewlyAddedModelIds(
    associatedResources.map(({ resourceType, item }) => ({ resourceType, resourceId: item.id })),
    savedTargetIds
  );
  const newlyAddedIds = new Set(newlyAdded);
  // A row can be linked back only if it is newly added AND the creator owns it. The first half
  // comes from the shared derivation the server also uses; the second is the same ownership
  // rule the server re-derives from the database, which remains the authority.
  const reciprocalEligible = new Set(
    associatedResources
      .filter(({ item }) => newlyAddedIds.has(item.id) && item.user.id === ownerId)
      .map(({ item }) => item.id)
  );
  const toggleLinkBack = (modelId: number) => {
    setChanged(true);
    setLinkBack((current) =>
      current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId]
    );
  };

  return (
    <Stack>
      {associatedResources.length < limit && (
        <QuickSearchDropdown
          supportedIndexes={['models', 'articles']}
          onItemSelected={handleSelect}
          filters={
            onlyMe && currentUser?.username ? `user.username='${currentUser.username}'` : undefined
          }
          rightSectionWidth={100}
          rightSection={
            <Button variant="light" onClick={toggleSearchMode} size="compact-xs">
              {onlyMe ? 'Only mine' : 'Everywhere'}
            </Button>
          }
          dropdownItemLimit={25}
          clearable={false}
        />
      )}

      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !associatedResources.length ? (
        <Text align="center" c="dimmed" size="sm" py="lg">
          No {type.toLowerCase()} resources yet — search above to add one
        </Text>
      ) : (
        <Stack gap="xs">
          <Text c="dimmed" size="xs">
            {associatedResources.length} of {limit} selected
          </Text>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={associatedResources.map(({ item }) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <Stack gap={4}>
                {associatedResources.map((association) => (
                  <SortableItem key={association.item.id} id={association.item.id} cursor="grab">
                    <Card
                      withBorder
                      pl={4}
                      pr={6}
                      pt={4}
                      pb={6}
                      className={
                        newlyAddedIds.has(association.item.id)
                          ? 'border-blue-5 dark:border-blue-5'
                          : undefined
                      }
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Group align="center" gap="xs" wrap="nowrap">
                          <IconGripVertical
                            size={20}
                            className="shrink-0 text-gray-6 dark:text-dark-2"
                          />
                          <Stack gap={4}>
                            <Text size="md" lineClamp={2}>
                              {'name' in association.item
                                ? association.item.name
                                : association.item.title}
                            </Text>
                            <Group gap={4}>
                              <Badge size="md" radius="xl" variant="light">
                                {'type' in association.item
                                  ? getDisplayName(association.item.type)
                                  : 'Article'}
                              </Badge>
                              {!reciprocalEligible.has(association.item.id) && (
                                <Badge size="md" radius="xl" pl={4} color="gray" variant="light">
                                  <Group gap={2}>
                                    <IconUser size={12} strokeWidth={2.5} />
                                    {association.item.user.username}
                                  </Group>
                                </Badge>
                              )}
                              {!getIsSafeBrowsingLevel(association.item.nsfwLevel) && (
                                <Badge color="red" size="md" radius="xl">
                                  NSFW
                                </Badge>
                              )}
                              {reciprocalEligible.has(association.item.id) && (
                                <Chip
                                  size="xs"
                                  checked={linkBack.includes(association.item.id)}
                                  onChange={() => toggleLinkBack(association.item.id)}
                                >
                                  Link back
                                </Chip>
                              )}
                            </Group>
                          </Stack>
                        </Group>
                        <LegacyActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Remove resource"
                          onClick={() => handleRemove(association.item.id)}
                        >
                          <IconTrash size={20} />
                        </LegacyActionIcon>
                      </Group>
                    </Card>
                  </SortableItem>
                ))}
              </Stack>
            </SortableContext>
          </DndContext>
        </Stack>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={handleReset} disabled={!changed || isSaving}>
          Reset
        </Button>
        <Button onClick={handleSave} loading={isSaving} disabled={!changed}>
          Save Changes
        </Button>
      </Group>
    </Stack>
  );
}

type SearchItemProps = ComboboxItem & { item: AssociatedResourceModel; nsfw: boolean };
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, item, nsfw, ...props }, ref) => {
    return (
      <Box ref={ref} {...props}>
        <Group wrap="nowrap" gap="xs">
          <Stack gap={0}>
            <Text lineClamp={1} lh={1}>
              {value}
            </Text>
            <Text size="xs" c="dimmed" lineClamp={1} lh={1}>
              by {item.user.username}
            </Text>
          </Stack>
          {nsfw && (
            <Badge color="red" ml="auto">
              NSFW
            </Badge>
          )}
        </Group>
      </Box>
    );
  }
);
SearchItem.displayName = 'SearchItem';
