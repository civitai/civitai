import { ActionIcon, Autocomplete, Badge, Card, Loader, Portal, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { BasicMasonryGrid } from '~/components/MasonryGrid/BasicMasonryGrid';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { trpc } from '~/utils/trpc';

export function HiddenUsersSection() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const hiddenUsers = useHiddenPreferencesData().hiddenUsers;

  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: debouncedSearch !== '' }
  );
  const options =
    data?.filter((x) => x.username).map(({ id, username }) => ({ id, value: username ?? '' })) ??
    [];

  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleToggleBlocked = async ({
    id,
    username,
  }: {
    id: number;
    username?: string | null;
  }) => {
    await toggleHiddenMutation.mutateAsync({ kind: 'user', data: [{ id, username }] });
    setSearch('');
  };

  return (
    <Card withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Text weight={500}>Hidden Users</Text>
      </Card.Section>
      <Card.Section withBorder sx={{ marginTop: -1 }}>
        <Portal reuseTargetNode>
          <Autocomplete
            name="tag"
            ref={searchInputRef}
            placeholder="Search users to hide"
            data={options}
            value={search}
            onChange={setSearch}
            leftSection={isLoading && isFetching ? <Loader size="xs" /> : <IconSearch size={14} />}
            onOptionSubmit={(value: string) => {
              const { id } = options.find((x) => x.value === value) ?? {};
              if (!id) return;
              handleToggleBlocked({ id, username: value });
              searchInputRef.current?.focus();
            }}
            variant="unstyled"
          />
        </Portal>
      </Card.Section>
      <Card.Section inheritPadding py="md">
        <Stack gap={5}>
          <BasicMasonryGrid
            items={hiddenUsers}
            render={UserBadge}
            maxHeight={250}
            columnGutter={4}
            columnWidth={140}
          />
          <Text color="dimmed" size="xs">
            {`We'll hide content from these users throughout the site.`}
          </Text>
        </Stack>
      </Card.Section>
    </Card>
  );
}

function UserBadge({
  data,
  width,
}: {
  data: { id: number; username?: string | null };
  width: number;
}) {
  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleToggleBlocked = async ({
    id,
    username,
  }: {
    id: number;
    username?: string | null;
  }) => {
    await toggleHiddenMutation.mutateAsync({ kind: 'user', data: [{ id, username }] });
  };

  return (
    <Badge
      key={data.id}
      sx={{ paddingRight: 3 }}
      w={width}
      rightSection={
        <ActionIcon
          size="xs"
          color="blue"
          radius="xl"
          variant="transparent"
          onClick={() => handleToggleBlocked(data)}
        >
          <IconX size={10} />
        </ActionIcon>
      }
    >
      {data.username ?? '[deleted]'}
    </Badge>
  );
}
