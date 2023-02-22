import {
  Input,
  InputWrapperProps,
  Autocomplete,
  Badge,
  createStyles,
  Group,
  Center,
} from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus } from '@tabler/icons';
import { trpc } from '~/utils/trpc';

type TagProps = {
  id?: number;
  name: string;
};

type TagsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: TagProps[];
  onChange?: (value: TagProps[]) => void;
  target: TagTarget[];
};
// !important - output must remain in the format {id, name}[]
export function TagsInput({ value = [], onChange, target, ...props }: TagsInputProps) {
  const { classes } = useStyles();
  const [search, setSearch] = useDebouncedState<string | undefined>(undefined, 300);

  //TODO.tags - default query trending tags
  const { data, isLoading } = trpc.tag.getAll.useQuery(
    { limit: 10, entityType: target, query: search?.toLowerCase() },
    { enabled: !!search?.length }
  );

  const handleAddTag = (item: { id?: number; value: string }) => {
    const updated = [...value, { id: item.id, name: item.value }];
    onChange?.(updated);
  };

  return (
    <Input.Wrapper {...props}>
      <Group>
        {value.map((tag, index) => (
          <Badge key={index} size="lg">
            {tag.name}
          </Badge>
        ))}
        <Badge
          size="lg"
          className={classes.badge}
          leftSection={
            <Center>
              <IconPlus />
            </Center>
          }
        >
          <Autocomplete
            variant="unstyled"
            data={data?.items?.map((tag) => ({ id: tag.id, value: tag.name })) ?? []}
            withinPortal
            onChange={(value) => setSearch(value)}
            onItemSubmit={handleAddTag}
          />
        </Badge>
      </Group>
    </Input.Wrapper>
  );
}

const useStyles = createStyles((theme) => ({
  badge: {
    textTransform: 'none',
  },
}));
