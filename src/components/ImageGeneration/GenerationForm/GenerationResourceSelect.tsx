import { trpc } from '~/utils/trpc';
import { useState, forwardRef } from 'react';
import { ModelType } from '@prisma/client';
import {
  Card,
  Stack,
  Text,
  Input,
  InputWrapperProps,
  Loader,
  Group,
  Badge,
  ActionIcon,
} from '@mantine/core';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { withController } from '~/libs/form/hoc/withController';
import { IconSearch, IconX } from '@tabler/icons-react';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useFormContext } from 'react-hook-form';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { Generation } from '~/server/services/generation/generation.types';

function GenerationResourceSelect({
  value: initialValue = [],
  onChange,
  limit,
  types,
  notTypes,
  ...inputWrapperProps
}: {
  value?: Generation.Client.Resource[];
  onChange?: (value: Generation.Client.Resource[]) => void;
  limit?: number;
  types?: ModelType[];
  notTypes?: ModelType[];
} & Omit<InputWrapperProps, 'children' | 'onChange'>) {
  const [value, setValue] = useState(initialValue);
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 300);

  const { data, isInitialLoading: isLoading } = trpc.generation.getResources.useQuery(
    { types, notTypes, query: debounced },
    { enabled: debounced.length >= 3 }
  );

  const selectedModelVersionIds = value.map((x) => x.id);
  const autoCompleteData: SearchItemProps[] =
    search.length >= 3 && !!data?.length
      ? data
          .filter((x) => !selectedModelVersionIds.includes(x.id))
          .map((resource) => ({
            value: resource.id.toString(),
            resource,
          }))
      : [];

  const handleClear = () => setSearch('');
  const handleChange = (value: string) => setSearch(value);
  const handleDeselect = (id: number) => {
    const filtered = value.filter((x) => x.id !== id);
    setValue(filtered);
    onChange?.(filtered);
  };
  const handleItemSubmit = ({ resource }: SearchItemProps) => {
    const newValue = [...value, resource];
    setValue(newValue);
    onChange?.(newValue);
    setSearch(search);
  };

  const { formState } = useFormContext();
  const { isSubmitted, isDirty } = formState;
  useDidUpdate(() => {
    if (!isSubmitted && !isDirty) {
      // clear value when form is reset
      setValue(initialValue);
    }
  }, [isDirty]); //eslint-disable-line

  return (
    <Input.Wrapper {...inputWrapperProps}>
      {value.map((resource) => (
        <Card p="xs" withBorder key={resource.id}>
          <Stack spacing={0}>
            <Group position="apart" noWrap>
              <Text weight={700} lineClamp={1}>
                {resource.modelName}
              </Text>
              <Group spacing={4} noWrap>
                <Badge>{resource.modelType}</Badge>
                <ActionIcon
                  color="red"
                  size="sm"
                  variant="light"
                  onClick={() => handleDeselect(resource.id)}
                >
                  <IconX />
                </ActionIcon>
              </Group>
            </Group>
            <Group position="apart">
              <Text size="sm">{resource.name}</Text>
              {/* TODO.Briant - determine if we will be using trained words here. If so, we'll probably need to pull in the version files for their types ([{ type}, { type}, ...]) to pass into the TrainedWords component */}
              <TrainedWords trainedWords={resource.trainedWords} type={resource.modelType} />
            </Group>
          </Stack>
        </Card>
      ))}
      {(!limit || limit > value.length) && (
        <ClearableAutoComplete
          value={search}
          data={autoCompleteData}
          onChange={handleChange}
          onClear={handleClear}
          itemComponent={SearchItem}
          onItemSubmit={handleItemSubmit}
          icon={isLoading ? <Loader size="xs" /> : <IconSearch />}
          clearable
          placeholder={inputWrapperProps.placeholder}
          filter={() => true}
          limit={10}
        />
      )}
    </Input.Wrapper>
  );
}

type SearchItemProps = { value: string; resource: Generation.Client.Resource };
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, resource, ...props }, ref) => {
    console.log({ props });
    return (
      <Stack spacing={0} ref={ref} {...props} key={`${resource.modelId}_${resource.id}`}>
        <Group position="apart" noWrap>
          <Text weight={700} lineClamp={1}>
            {resource.modelName}
          </Text>
          <Badge>{resource.modelType}</Badge>
        </Group>
        <Text size="sm">{resource.name}</Text>
      </Stack>
    );
  }
);
SearchItem.displayName = 'SearchItem';

export const CheckpointSelect = withController(GenerationResourceSelect, ({ field }) => ({
  value: Array.isArray(field.value) ? field.value : [],
}));
