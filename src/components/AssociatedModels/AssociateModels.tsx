import {
  closestCenter,
  DndContext,
  DragEndEvent,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  Stack,
  Text,
  Card,
  Group,
  Button,
  ActionIcon,
  Center,
  Loader,
  Alert,
  Badge,
  SelectItemProps,
  Box,
} from '@mantine/core';
import { AssociationType } from '~/shared/utils/prisma/enums';
import { IconGripVertical, IconTrash, IconUser } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { forwardRef, useEffect, useState } from 'react';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { AssociatedResourceModel } from '~/server/selectors/model.selector';
import { ModelGetAssociatedResourcesSimple } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { QuickSearchDropdown, QuickSearchDropdownProps } from '../Search/QuickSearchDropdown';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  getIsSafeBrowsingLevel,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';

type State = Array<Omit<ModelGetAssociatedResourcesSimple[number], 'id'> & { id?: number }>;

export function AssociateModels({
  fromId,
  type,
  onSave,
  limit = 10,
}: {
  fromId: number;
  type: AssociationType;
  onSave?: () => void;
  limit?: number;
}) {
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
  const [searchMode, setSearchMode] = useState<'me' | 'all'>('all');

  const { mutate, isLoading: isSaving } = trpc.model.setAssociatedResources.useMutation({
    onSuccess: async () => {
      queryUtils.model.getAssociatedResourcesSimple.setData(
        { fromId, type, browsingLevel: allBrowsingLevelsFlag },
        () => associatedResources as ModelGetAssociatedResourcesSimple
      );
      await queryUtils.model.getAssociatedResourcesCardData.invalidate({ fromId, type });
      setChanged(false);
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
    setChanged(!isEqual(data, models));
  };

  const handleReset = () => {
    setChanged(false);
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

  return (
    <Stack>
      {associatedResources.length < limit && (
        <QuickSearchDropdown
          supportedIndexes={['models', 'articles']}
          onItemSelected={handleSelect}
          filters={onlyMe && currentUser ? `user.username='${currentUser.username}'` : undefined}
          rightSectionWidth={100}
          rightSection={
            <Button size="xs" variant="light" onClick={toggleSearchMode} compact>
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
      ) : (
        <Stack spacing={0}>
          <Text align="right" color="dimmed" size="xs">
            You can select {limit - associatedResources.length} more resources
          </Text>
          {!!associatedResources.length ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={associatedResources.map(({ item }) => item.id)}
                strategy={verticalListSortingStrategy}
              >
                <Stack spacing={4}>
                  {associatedResources.map((association) => (
                    <SortableItem key={association.item.id} id={association.item.id}>
                      <Card withBorder pl={4} pr={6} pt={4} pb={6}>
                        <Group position="apart">
                          <Group align="center" spacing="xs">
                            <IconGripVertical />
                            <Stack spacing={4}>
                              <Text size="md" lineClamp={2}>
                                {'name' in association.item
                                  ? association.item.name
                                  : association.item.title}
                              </Text>
                              <Group spacing={4}>
                                <Badge size="xs">
                                  {'type' in association.item ? association.item.type : 'Article'}
                                </Badge>
                                <Badge size="xs" pl={4}>
                                  <Group spacing={2}>
                                    <IconUser size={12} strokeWidth={2.5} />
                                    {association.item.user.username}
                                  </Group>
                                </Badge>
                                {!getIsSafeBrowsingLevel(association.item.nsfwLevel) && (
                                  <Badge color="red" size="xs">
                                    NSFW
                                  </Badge>
                                )}
                              </Group>
                            </Stack>
                          </Group>
                          <ActionIcon
                            variant="outline"
                            color="red"
                            onClick={() => handleRemove(association.item.id)}
                          >
                            <IconTrash size={20} />
                          </ActionIcon>
                        </Group>
                      </Card>
                    </SortableItem>
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          ) : (
            <Alert>There are no {type.toLowerCase()} resources associated with this model</Alert>
          )}
        </Stack>
      )}
      {changed && (
        <Group position="right">
          <Button variant="default" onClick={handleReset}>
            Reset
          </Button>
          <Button onClick={handleSave} loading={isSaving}>
            Save Changes
          </Button>
        </Group>
      )}
    </Stack>
  );
}

type SearchItemProps = SelectItemProps & { item: AssociatedResourceModel; nsfw: boolean };
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, item, nsfw, ...props }, ref) => {
    return (
      <Box ref={ref} {...props}>
        <Group noWrap spacing="xs">
          <Stack spacing={0}>
            <Text lineClamp={1} lh={1}>
              {value}
            </Text>
            <Text size="xs" color="dimmed" lineClamp={1} lh={1}>
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
