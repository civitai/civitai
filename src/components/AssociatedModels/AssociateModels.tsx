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
import { AssociationType } from '@prisma/client';
import { IconGripVertical, IconSearch, IconTrash, IconUser } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { forwardRef, useEffect, useMemo, useState } from 'react';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { AssociatedResourceModel } from '~/server/selectors/model.selector';
import { ModelGetAssociatedResourcesSimple } from '~/types/router';
import { useDebouncer } from '~/utils/debouncer';
import { trpc } from '~/utils/trpc';

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
  const queryUtils = trpc.useContext();
  const [changed, setChanged] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [query, setQuery] = useState('');

  const {
    data: { models, articles } = { models: [], articles: [] },
    refetch,
    isFetching,
  } = trpc.model.findResourcesToAssociate.useQuery({ query }, { enabled: false });
  const { data = [], isLoading } = trpc.model.getAssociatedResourcesSimple.useQuery({
    fromId,
    type,
  });
  const [associatedResources, setAssociatedResources] = useState<State>(data);

  const { mutate, isLoading: isSaving } = trpc.model.setAssociatedResources.useMutation({
    onSuccess: async () => {
      queryUtils.model.getAssociatedResourcesSimple.setData(
        { fromId, type },
        () => associatedResources as ModelGetAssociatedResourcesSimple
      );
      await queryUtils.model.getAssociatedResourcesCardData.invalidate({ fromId, type });
      setChanged(false);
      onSave?.();
    },
  });

  const debouncer = useDebouncer(500);
  const handleSearchChange = (value: string) => {
    setQuery(value);
    debouncer(() => {
      if (!value.length) return;
      refetch();
    });
  };

  const handleItemSubmit = ({
    item,
    group,
  }: {
    value: string;
    item: (typeof models)[number] | (typeof articles)[number];
    group: 'Models' | 'Articles';
  }) => {
    setChanged(true);
    setAssociatedResources((resources) => [
      ...resources,
      ...(group === 'Models'
        ? [{ resourceType: 'model' as const, item }]
        : [{ resourceType: 'article' as const, item }]),
    ]);
    setQuery('');
  };

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

  const autocompleteData = useMemo(
    () => [
      ...models
        .filter(
          (x) => !associatedResources.map(({ item }) => item?.id).includes(x.id) && x.id !== fromId
        )
        .map((model) => ({ value: model.name, nsfw: model.nsfw, item: model, group: 'Models' })),
      ...articles
        .filter(
          (x) => !associatedResources.map(({ item }) => item?.id).includes(x.id) && x.id !== fromId
        )
        .map((article) => ({
          value: article.title,
          nsfw: article.nsfw,
          item: article,
          group: 'Articles',
        })),
    ],
    [articles, associatedResources, fromId, models]
  );

  useEffect(() => {
    if (!associatedResources.length && data.length) {
      setAssociatedResources(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <Stack>
      {associatedResources.length < limit && (
        <ClearableAutoComplete
          // label={`Add up to ${limit} models`}
          placeholder="Search..."
          icon={<IconSearch />}
          data={autocompleteData}
          value={query}
          onChange={handleSearchChange}
          onItemSubmit={handleItemSubmit}
          itemComponent={SearchItem}
          nothingFound={isFetching ? 'Searching...' : 'Nothing found'}
          limit={20}
          clearable
        />
      )}

      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <Stack spacing={0}>
          <Text align="right">
            {associatedResources.length}/{limit}
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
                <Stack spacing="xs">
                  {associatedResources.map((association) => (
                    <SortableItem key={association.item.id} id={association.item.id}>
                      <Card withBorder p="xs">
                        <Group position="apart">
                          <Group align="center">
                            <IconGripVertical />
                            <Stack spacing="xs">
                              <Text size="md" lineClamp={2}>
                                {'name' in association.item
                                  ? association.item.name
                                  : association.item.title}
                              </Text>
                              <Group spacing="xs">
                                <Badge>
                                  {'type' in association.item ? association.item.type : 'Article'}
                                </Badge>
                                <Badge leftSection={<IconUser size={12} />}>
                                  {association.item.user.username}
                                </Badge>
                                {association.item.nsfw && <Badge color="red">NSFW</Badge>}
                              </Group>
                            </Stack>
                          </Group>
                          <ActionIcon
                            variant="filled"
                            color="red"
                            onClick={() => handleRemove(association.item.id)}
                          >
                            <IconTrash />
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
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(({ value, nsfw, ...props }, ref) => {
  return (
    <Box ref={ref} {...props}>
      <Group noWrap spacing="xs">
        <Text lineClamp={1}>{value}</Text>
        {nsfw && <Badge color="red">NSFW</Badge>}
      </Group>
    </Box>
  );
});
SearchItem.displayName = 'SearchItem';
