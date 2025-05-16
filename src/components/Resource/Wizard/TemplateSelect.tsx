import {
  Center,
  Divider,
  Loader,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { trpc } from '~/utils/trpc';

export function TemplateSelect({ userId, onSelect }: Props) {
  const [query, setQuery] = useDebouncedState('', 300);

  const {
    data: models = [],
    isLoading,
    isRefetching,
  } = trpc.model.getAllInfiniteSimple.useQuery({ userId, query }, { keepPreviousData: true });

  return (
    <Stack gap={0}>
      <Stack gap={8} px="sm" pt={8}>
        <Text size="sm" weight={600}>
          Your models
        </Text>
        <TextInput
          placeholder="Search models"
          defaultValue={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          leftSection={<IconSearch size={18} />}
          rightSection={isLoading || isRefetching ? <Loader size="xs" /> : undefined}
        />
      </Stack>
      <Divider mx={-4} mt="sm" />
      {models.length ? (
        <ScrollArea.Autosize mah={300}>
          <Stack gap={0} mt={4}>
            {models.map((model) => (
              <Link key={model.id} href={`?templateId=${model.id}`} shallow>
                <UnstyledButton
                  className="hover:bg-gray-100 dark:hover:bg-gray-700"
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
          <Text c="dimmed" size="sm">
            No models found
          </Text>
        </Center>
      )}
    </Stack>
  );
}

type Props = { userId: number; onSelect: (id: number) => void };
