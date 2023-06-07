import { trpc } from '~/utils/trpc';
import { useState, useEffect, forwardRef } from 'react';
import { useDebouncer } from '~/utils/debouncer';
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
import { GenerationResourceModel } from '~/server/services/generation';
import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { withController } from '~/libs/form/hoc/withController';
import { IconSearch, IconX } from '@tabler/icons-react';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';

function CheckpointSelectComponent({
  value: initialValue,
  onChange,
  ...inputWrapperProps
}: {
  value?: GenerationResourceModel;
  onChange?: (value: GenerationResourceModel) => void;
} & Omit<InputWrapperProps, 'children' | 'onChange'>) {
  const debouncer = useDebouncer(300);
  const [value, setValue] = useState(initialValue);
  const [search, setSearch] = useState('');

  const { data, isFetching, refetch } = trpc.generation.getResources.useQuery(
    { type: ModelType.Checkpoint, query: search },
    { enabled: false }
  );

  const autoCompleteData =
    search.length >= 3 && !!data?.length
      ? data.map((resource) => ({
          value: resource.name,
          resource,
        }))
      : [];

  const handleClear = () => setSearch('');
  const handleChange = (value: string) => setSearch(value);
  const handleDeselect = () => setValue(undefined);
  const handleItemSubmit = ({ resource }: SearchItemProps) => {
    setValue(resource);
    onChange?.(resource);
    handleClear();
  };

  useEffect(() => {
    if (search.length >= 3) debouncer(refetch);
  }, [search, debouncer, refetch]);

  return (
    <Input.Wrapper {...inputWrapperProps}>
      {!value ? (
        <ClearableAutoComplete
          value={search}
          data={autoCompleteData}
          onChange={handleChange}
          onClear={handleClear}
          itemComponent={SearchItem}
          onItemSubmit={handleItemSubmit}
          icon={isFetching ? <Loader size="xs" /> : <IconSearch />}
          clearable
          placeholder={inputWrapperProps.placeholder}
          filter={() => true}
          limit={10}
        />
      ) : (
        <Card p="xs" withBorder>
          <Stack spacing={0}>
            <Group position="apart" noWrap>
              <Text weight={700} lineClamp={1}>
                {value.modelName}
              </Text>
              <Group spacing={4} noWrap>
                <Badge>{value.modelType}</Badge>
                <ActionIcon color="red" size="sm" variant="light" onClick={handleDeselect}>
                  <IconX />
                </ActionIcon>
              </Group>
            </Group>
            <Group position="apart">
              <Text size="sm">{value.name}</Text>
              {/* TODO.Briant - determine if we will be using trained words here. If so, we'll probably need to pull in the version files for their types ([{ type}, { type}, ...]) to pass into the TrainedWords component */}
              <TrainedWords trainedWords={value.trainedWords} type={value.modelType} />
            </Group>
          </Stack>
        </Card>
      )}
    </Input.Wrapper>
  );
}

type SearchItemProps = { value: string; resource: GenerationResourceModel };
const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ value, resource, ...props }, ref) => {
    return (
      <Stack spacing={0} ref={ref} {...props} key={`${resource.modelId}_${resource.id}`}>
        <Group position="apart" noWrap>
          <Text weight={700} lineClamp={1}>
            {resource.modelName}
          </Text>
          <Badge>{resource.modelType}</Badge>
        </Group>
        <Group position="apart">
          <Text size="sm">{resource.name}</Text>
          {/* <Group spacing={4} align="flex-end">
            {resource.trainedWords.map((x, i) => (
              <Badge key={i} color="violet" size="xs">
                {x}
              </Badge>
            ))}
          </Group> */}
        </Group>
      </Stack>
    );
  }
);
SearchItem.displayName = 'SearchItem';

export const CheckpointSelect = withController(CheckpointSelectComponent);
