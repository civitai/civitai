import {
  Center,
  Divider,
  Loader,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  option: {
    ...theme.fn.focusStyles(),

    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
    },
  },
}));

export function TemplateSelect({ userId, onSelect }: Props) {
  const { classes } = useStyles();
  const [query, setQuery] = useDebouncedState('', 300);

  const {
    data: models = [],
    isLoading,
    isRefetching,
  } = trpc.model.getAllInfiniteSimple.useQuery({ userId, query }, { keepPreviousData: true });

  return (
    <Stack spacing={0}>
      <Stack spacing={8} px="sm" pt={8}>
        <Text size="sm" weight={600}>
          Your models
        </Text>
        <TextInput
          placeholder="Search models"
          defaultValue={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          icon={<IconSearch size={18} />}
          rightSection={isLoading || isRefetching ? <Loader size="xs" /> : undefined}
        />
      </Stack>
      <Divider mx={-4} mt="sm" />
      {models.length ? (
        <ScrollArea.Autosize maxHeight={300}>
          <Stack spacing={0} mt={4}>
            {models.map((model) => (
              <Link key={model.id} href={`?templateId=${model.id}`} shallow>
                <UnstyledButton
                  className={classes.option}
                  py="xs"
                  px="sm"
                  onClick={() => onSelect(model.id)}
                >
                  <Text size="sm" lineClamp={2}>
                    {model.name}
                  </Text>
                </UnstyledButton>
              </Link>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      ) : (
        <Center p="sm" mt={4}>
          <Text color="dimmed" size="sm">
            No models found
          </Text>
        </Center>
      )}
    </Stack>
  );
}

type Props = { userId: number; onSelect: (id: number) => void };
