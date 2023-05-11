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
import { Stack, Text, Card, Group, Button, ActionIcon, Center, Loader, Alert } from '@mantine/core';
import { AssociationType } from '@prisma/client';
import { IconGripVertical, IconSearch, IconTrash } from '@tabler/icons';
import { isEqual } from 'lodash-es';
import { useEffect, useState } from 'react';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { IsClient } from '~/components/IsClient/IsClient';
import { AssociatedResourceModel } from '~/server/selectors/model.selector';
import { useDebouncer } from '~/utils/debouncer';
import { trpc } from '~/utils/trpc';

export function AssociateModels({
  fromId,
  type,
  onSave,
}: {
  fromId: number;
  type: AssociationType;
  onSave?: () => void;
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

  const handleItemSubmit = (item: { value: string; id: number }) => {
    const model = models.find((x) => x.id === item.id);
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
      <ClearableAutoComplete
        placeholder="Search..."
        icon={<IconSearch />}
        data={models.map((model) => ({ value: model.name, id: model.id }))}
        value={query}
        onChange={handleSearchChange}
        onItemSubmit={handleItemSubmit}
        clearable
      />

      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!associatedModels.length ? (
        <IsClient>
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
                    <Card withBorder>
                      <Group position="apart">
                        <Group align="start">
                          <IconGripVertical />
                          <Text size="md" lineClamp={2}>
                            {model.name}
                          </Text>
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
        </IsClient>
      ) : (
        <Alert>There are no {type.toLowerCase()} models associated with this model</Alert>
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

const demoData = [
  {
    id: 48139,
    name: 'LowRA',
    type: 'LORA',
    nsfw: false,
    user: {
      id: 4055,
      username: 'XpucT',
      deletedAt: null,
      image:
        'https://cdn.discordapp.com/avatars/481774648799789056/03814a5155fa29296f2c9c2b6f0adfe0.png',
    },
  },
  {
    id: 51686,
    name: 'GlowingRunesAI',
    type: 'LORA',
    nsfw: false,
    user: {
      id: 91602,
      username: 'konyconi',
      deletedAt: null,
      image:
        'https://lh3.googleusercontent.com/a/AEdFTp7h2SYiaEktwSXe7YgztLujHzR5moKuVCHgTCsy=s96-c',
    },
  },
  {
    id: 5415,
    name: 'Cornflower X Feat. Offset Noise - Stylized Anime Model',
    type: 'Checkpoint',
    nsfw: false,
    user: {
      id: 129412,
      username: 'Toooajk',
      deletedAt: null,
      image: 'c7e5fd0c-1a2c-4700-328b-a740b980ec00',
    },
  },
  {
    id: 21726,
    name: 'POV Spitroast Blowjob + Creampie LoRA',
    type: 'LORA',
    nsfw: true,
    user: {
      id: 220490,
      username: 'KinkAI',
      deletedAt: null,
      image: '1a4ca30a-6877-42bf-1b59-3e2edf3f1f00',
    },
  },
  {
    id: 12344,
    name: 'Blowbang LoRA',
    type: 'LORA',
    nsfw: true,
    user: {
      id: 16870,
      username: 'SysDeep',
      deletedAt: null,
      image: '2b4bd79e-5927-4ed5-2c3f-51bddf29c800',
    },
  },
] as AssociatedResourceModel[];
