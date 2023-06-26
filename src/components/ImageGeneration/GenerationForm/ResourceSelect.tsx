import {
  Input,
  InputWrapperProps,
  Button,
  Card,
  Stack,
  Text,
  Group,
  ActionIcon,
  Slider,
  Modal,
  TextInput,
  Badge,
  Loader,
  createStyles,
} from '@mantine/core';
import { useDebouncedValue, usePrevious } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import { IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';
import { trpc } from '~/utils/trpc';

export function ResourceSelect({
  value,
  onChange,
  onRemove,
  types,
  label,
  ...inputWrapperProps
}: {
  value?: Generation.Client.Resource;
  onChange?: (value?: Generation.Client.Resource) => void;
  onRemove?: () => void;
  types?: ModelType[];
} & Omit<InputWrapperProps, 'children' | 'onChange'>) {
  const [opened, setOpened] = useState(false);
  const [strength, setStrength] = useState(value?.strength ?? 1);

  useEffect(() => {
    if (!value) return;
    onChange?.({ ...value, strength });
  }, [strength]); // eslint-disable-line

  const handleStrengthChange = (strength: number) => {
    const rounded = Math.round(strength * 100) / 100;
    setStrength(rounded);
  };

  const handleRemove = () => {
    onChange?.(undefined);
    onRemove?.();
  };

  return (
    <>
      <Input.Wrapper label={value?.modelType ?? label} {...inputWrapperProps}>
        {!value ? (
          <div>
            <Button onClick={() => setOpened(true)} variant="outline" size="xs" fullWidth>
              Add {label}
            </Button>
          </div>
        ) : (
          <Card p="xs">
            <Stack spacing="xs">
              {/* Header */}
              <Group spacing="xs" position="apart">
                <Text lineClamp={1}>
                  {value.modelName} - {value.name}
                </Text>
                <ActionIcon size="xs" variant="subtle" color="red" onClick={handleRemove}>
                  <IconX />
                </ActionIcon>
              </Group>
              {/* LORA */}
              {value.modelType === ModelType.LORA && (
                <Group spacing="xs">
                  <Slider
                    style={{ flex: 1 }}
                    value={strength}
                    onChange={handleStrengthChange}
                    step={0.05}
                    min={-1}
                    max={2}
                  />
                  <Text style={{ width: 30 }} align="right">{`${strength}`}</Text>
                </Group>
              )}
              {/* TEXTUAL INVERSION */}
              {value.modelType === ModelType.TextualInversion && (
                <TrainedWords trainedWords={value.trainedWords} type={value.modelType} />
              )}
            </Stack>
          </Card>
        )}
      </Input.Wrapper>
      {!value && (
        <ResourceSelectModal
          opened={opened}
          onClose={() => setOpened(false)}
          title={`Select ${label}`}
          onSelect={(value) => onChange?.(value)}
          types={types}
          notIds={value ? [value.id] : undefined}
        />
      )}
    </>
  );
}
export const InputResourceSelect = withController(ResourceSelect, ({ field }) => ({
  value: field.value ?? undefined,
}));

export function ResourceSelectModal({
  opened,
  onClose,
  title,
  onSelect,
  types,
  notIds = [],
}: {
  opened: boolean;
  onClose: () => void;
  title?: string;
  onSelect: (value: Generation.Client.Resource) => void;
  types?: ModelType[];
  notIds?: number[];
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);

  const { data = [], isInitialLoading: isLoading } = trpc.generation.getResources.useQuery(
    { types, query: debounced },
    { enabled: debounced.length >= 3 }
  );

  const handleSelect = (value: Generation.Client.Resource) => {
    onSelect(value);
    onClose();
  };

  return (
    <Modal opened={opened} title={title} onClose={onClose} size="sm">
      <Stack>
        <TextInput
          value={search}
          placeholder="Search"
          onChange={(e) => setSearch(e.target.value)}
          rightSection={isLoading ? <Loader size="xs" /> : null}
          autoFocus
        />
        <Stack>
          {data
            .filter((resource) => !notIds.includes(resource.id))
            .map((resource) => (
              <Stack
                spacing={0}
                key={`${resource.modelId}_${resource.id}`}
                onClick={() => handleSelect(resource)}
              >
                <Group position="apart" noWrap>
                  <Text weight={700} lineClamp={1}>
                    {resource.modelName}
                  </Text>
                  <Badge>{resource.modelType}</Badge>
                </Group>
                <Text size="sm">{resource.name}</Text>
              </Stack>
            ))}
        </Stack>
      </Stack>
    </Modal>
  );
}

const useStyles = createStyles((theme) => ({
  resourceSelect: {},
}));
