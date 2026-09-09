import { Autocomplete, Badge, Card, Group, Loader, Portal, Select, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { toHideableOptions } from '~/components/Account/hidden-users-options';
import { BasicMasonryGrid } from '~/components/MasonryGrid/BasicMasonryGrid';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { SettingsSection } from '~/components/Account/SettingsLayout';

import { trpc } from '~/utils/trpc';

export function HiddenUsersSection({ flat }: { flat?: boolean } = {}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [sort, setSort] = useState<string>('newest');

  const { hiddenUsers, blockedUsers } = useHiddenPreferencesData();

  const sortedHiddenUsers = useMemo(() => {
    if (sort === 'newest') return hiddenUsers;
    if (sort === 'oldest') return [...hiddenUsers].reverse();

    const users = [...hiddenUsers];
    if (sort === 'alphaAsc') {
      return users.sort((a, b) =>
        (a.username ?? '').localeCompare(b.username ?? '', undefined, { sensitivity: 'base' })
      );
    }
    if (sort === 'alphaDesc') {
      return users.sort((a, b) =>
        (b.username ?? '').localeCompare(a.username ?? '', undefined, { sensitivity: 'base' })
      );
    }
    
    return users;
  }, [hiddenUsers, sort]);

  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: debouncedSearch !== '' }
  );
  const options = toHideableOptions(data, blockedUsers);

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

  const sortField = (
    <Select
      size="xs"
      value={sort}
      onChange={(val) => setSort(val ?? 'newest')}
      data={[
        { label: 'Recently Added', value: 'newest' },
        { label: 'Oldest Added', value: 'oldest' },
        { label: 'A-Z', value: 'alphaAsc' },
        { label: 'Z-A', value: 'alphaDesc' },
      ]}
      style={{ width: 160 }}
    />
  );

  const searchField = (
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
    />
  );

  if (flat)
    return (
      <SettingsSection
        title="Hidden users"
        description="Their models, images and comments are hidden from you."
        action={sortField}
      >
        <div className="flex flex-col gap-3">
          {searchField}
          <BasicMasonryGrid
            items={sortedHiddenUsers}
            render={UserBadge}
            maxHeight={250}
            columnGutter={4}
            columnWidth={140}
          />
        </div>
      </SettingsSection>
    );

  return (
    <Card withBorder>
      <Card.Section withBorder inheritPadding py="xs">
        <Group justify="space-between">
          <Text fw={500}>Hidden Users</Text>
          <Select
            size="xs"
            value={sort}
            onChange={(val) => setSort(val ?? 'newest')}
            data={[
              { label: 'Recently Added', value: 'newest' },
              { label: 'Oldest Added', value: 'oldest' },
              { label: 'A-Z', value: 'alphaAsc' },
              { label: 'Z-A', value: 'alphaDesc' },
            ]}
            style={{ width: 160 }}
          />
        </Group>
      </Card.Section>
      <Card.Section withBorder style={{ marginTop: -1 }}>
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
      </Card.Section>
      <Card.Section inheritPadding py="md">
        <Stack gap={5}>
          <BasicMasonryGrid
            items={sortedHiddenUsers}
            render={UserBadge}
            maxHeight={250}
            columnGutter={4}
            columnWidth={140}
          />
          <Text c="dimmed" size="xs">
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
      style={{ paddingRight: 3 }}
      w={width}
      rightSection={
        <LegacyActionIcon
          size="xs"
          color="blue"
          radius="xl"
          variant="transparent"
          onClick={() => handleToggleBlocked(data)}
        >
          <IconX size={10} />
        </LegacyActionIcon>
      }
    >
      {data.username ?? '[deleted]'}
    </Badge>
  );
}
