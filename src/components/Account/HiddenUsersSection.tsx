import {
  ActionIcon,
  Autocomplete,
  Badge,
  Card,
  Group,
  Loader,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { useHiddenPreferences } from '~/providers/HiddenPreferencesProvider';
import { hiddenPreferences } from '~/store/hidden-preferences.store';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';

import { trpc } from '~/utils/trpc';

export function HiddenUsersSection() {
  const queryUtils = trpc.useContext();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { users: userHiddenUsers } = useHiddenPreferences();
  const { data: hiddenUsers = [], isLoading: loadingBlockedUsers } =
    trpc.user.getHiddenUsers.useQuery();

  const blocked = hiddenUsers.filter((x) => userHiddenUsers.get(x.id));
  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: !loadingBlockedUsers && debouncedSearch !== '' }
  );
  const users =
    data?.filter((x) => x.username).map(({ id, username }) => ({ id, value: username ?? '' })) ??
    [];

  const handleToggleBlocked = async ({
    id,
    username,
  }: {
    id: number;
    username?: string | null;
  }) => {
    await hiddenPreferences.toggleEntity({ entityType: 'user', entityId: id });
    invalidateModeratedContentDebounced(queryUtils, ['user']); // TODO - remove this once frontend filtering is finished

    const prevHidden = queryUtils.user.getHiddenUsers.getData();
    const alreadyHidden = prevHidden?.some((user) => user.id === id);
    queryUtils.user.getHiddenUsers.setData(undefined, (old = []) =>
      alreadyHidden
        ? old.filter((item) => item.id !== id)
        : [...old, { id: id, username: username ?? '', image: null, deletedAt: null }]
    );

    setSearch('');
  };

  return (
    <>
      <Card.Section withBorder sx={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search users to hide"
          data={users}
          value={search}
          onChange={setSearch}
          icon={isLoading && isFetching ? <Loader size="xs" /> : <IconSearch size={14} />}
          onItemSubmit={({ id, value: username }: { value: string; id: number }) => {
            handleToggleBlocked({ id, username });
            searchInputRef.current?.focus();
          }}
          withinPortal
          variant="unstyled"
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md">
        <Stack spacing={5}>
          <Skeleton visible={loadingBlockedUsers}>
            {blocked.length > 0 && (
              <Group spacing={4}>
                {blocked.map((user) => (
                  <Badge
                    key={user.id}
                    sx={{ paddingRight: 3 }}
                    rightSection={
                      <ActionIcon
                        size="xs"
                        color="blue"
                        radius="xl"
                        variant="transparent"
                        onClick={() => handleToggleBlocked(user)}
                      >
                        <IconX size={10} />
                      </ActionIcon>
                    }
                  >
                    {user.username}
                  </Badge>
                ))}
              </Group>
            )}
          </Skeleton>
          <Text color="dimmed" size="xs">
            {`We'll hide content from these users throughout the site.`}
          </Text>
        </Stack>
      </Card.Section>
    </>
  );
}
