import {
  ActionIcon,
  Autocomplete,
  Badge,
  Card,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { invalidateModeratedContentDebounced } from '~/utils/query-invalidation-utils';

import { trpc } from '~/utils/trpc';

export function HiddenUsersSection() {
  const queryUtils = trpc.useContext();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data: blocked = [], isLoading: loadingBlockedUsers } =
    trpc.user.getHiddenUsers.useQuery();
  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: !loadingBlockedUsers && debouncedSearch !== '' }
  );
  const users =
    data?.filter((x) => x.username).map(({ id, username }) => ({ id, value: username ?? '' })) ??
    [];

  const toggleBlockedUserMutation = trpc.user.toggleHide.useMutation({
    async onMutate({ targetUserId, username }) {
      await queryUtils.user.getHiddenUsers.cancel();

      const prevHidden = queryUtils.user.getHiddenUsers.getData();

      const alreadyHidden = prevHidden?.some((user) => user.id === targetUserId);
      queryUtils.user.getHiddenUsers.setData(undefined, (old = []) =>
        alreadyHidden
          ? old.filter((item) => item.id !== targetUserId)
          : [...old, { id: targetUserId, username: username ?? '', image: null, deletedAt: null }]
      );

      return { prevHidden };
    },
    async onSuccess() {
      invalidateModeratedContentDebounced(queryUtils, ['user']);
    },
    onError(_error, _variables, context) {
      queryUtils.user.getHiddenUsers.setData(undefined, context?.prevHidden);
    },
  });
  const handleToggleBlocked = ({ id, username }: { id: number; username?: string | null }) => {
    toggleBlockedUserMutation.mutate({ targetUserId: id, username });
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
