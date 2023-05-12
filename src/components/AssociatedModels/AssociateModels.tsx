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
import { IconGripVertical, IconSearch, IconTrash, IconUser } from '@tabler/icons';
import { isEqual } from 'lodash-es';
import { forwardRef, useState } from 'react';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { AssociatedResourceModel } from '~/server/selectors/model.selector';
import { useDebouncer } from '~/utils/debouncer';
import { trpc } from '~/utils/trpc';

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

  const { data: models = [], refetch } = trpc.model.findModelsToAssociate.useQuery(
    { query },
    { enabled: false }
  );
  const { data = [], isLoading } = trpc.model.getAssociatedModelsSimple.useQuery(
    { fromId, type },
    {
      // initialData: demoData, // TODO.remove once db is ready
      onSuccess: (data) => {
        setAssociatedModels(data);
      },
    }
  );
  const [associatedModels, setAssociatedModels] = useState(data);

  const { mutate, isLoading: isSaving } = trpc.model.setAssociatedModels.useMutation({
    onSuccess: () => {
      queryUtils.model.getAssociatedModelsSimple.setData({ fromId, type }, () => associatedModels);
      queryUtils.model.getAssociatedModelsCardData.invalidate({ fromId, type });
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

  const handleItemSubmit = (item: { value: string; model: AssociatedResourceModel }) => {
    const model = models.find((x) => x.id === item.model.id);
    if (model) {
      setChanged(true);
      setAssociatedModels((models) => [...models, model]);
    }
    setQuery('');
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      const models = [...associatedModels];
      const ids = models.map(({ id }): UniqueIdentifier => id);
      const oldIndex = ids.indexOf(active.id);
      const newIndex = ids.indexOf(over.id);
      const sorted = arrayMove(models, oldIndex, newIndex);
      setAssociatedModels(sorted);
      setChanged(!isEqual(data, sorted));
    }
  };

  const handleRemove = (id: number) => {
    const models = [...associatedModels.filter((x) => x.id !== id)];
    setAssociatedModels(models);
    setChanged(!isEqual(data, models));
  };

  const handleReset = () => {
    setChanged(false);
    setAssociatedModels(data);
  };
  const handleSave = () => {
    // console.log({ associatedModels });
    mutate({ fromId, type, associatedIds: associatedModels.map((x) => x.id) });
  };

  return (
    <Stack>
      {associatedModels.length < limit && (
        <ClearableAutoComplete
          // label={`Add up to ${limit} models`}
          placeholder="Search..."
          icon={<IconSearch />}
          data={models
            .filter((x) => !associatedModels.map((x) => x.id).includes(x.id) && x.id !== fromId)
            .map((model) => ({ value: model.name, model }))}
          value={query}
          onChange={handleSearchChange}
          onItemSubmit={handleItemSubmit}
          itemComponent={SearchItem}
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
            {associatedModels.length}/{limit}
          </Text>
          {!!associatedModels.length ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={associatedModels.map((x) => x.id)}
                strategy={verticalListSortingStrategy}
              >
                <Stack spacing="xs">
                  {associatedModels.map((model) => (
                    <SortableItem key={model.id} id={model.id}>
                      <Card withBorder p="xs">
                        <Group position="apart">
                          <Group align="center">
                            <IconGripVertical />
                            <Stack spacing="xs">
                              <Text size="md" lineClamp={2}>
                                {model.name}
                              </Text>
                              <Group spacing="xs">
                                <Badge>{model.type}</Badge>
                                <Badge leftSection={<IconUser size={12} />}>
                                  {model.user.username}
                                </Badge>
                                {model.nsfw && <Badge color="red">NSFW</Badge>}
                              </Group>
                            </Stack>
                          </Group>
                          <ActionIcon
                            variant="filled"
                            color="red"
                            onClick={() => handleRemove(model.id)}
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
            <Alert>There are no {type.toLowerCase()} models associated with this model</Alert>
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

type SearchItemProps = SelectItemProps & { model: AssociatedResourceModel };
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, model, ...props }, ref) => {
    return (
      <Box ref={ref} {...props} key={model.id}>
        <Group noWrap spacing="xs">
          <Text lineClamp={1}>{model.name}</Text>
          {model.nsfw && <Badge color="red">NSFW</Badge>}
        </Group>
      </Box>
    );
  }
);
SearchItem.displayName = 'SearchItem';
