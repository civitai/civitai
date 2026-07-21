import {
  Autocomplete,
  Badge,
  Button,
  Center,
  Checkbox,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconCloudOff, IconSearch, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { CosmeticsFiltersDropdown } from '~/components/Cosmetics/CosmeticsFiltersDropdown';
import { useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import type { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type CosmeticRow = ReturnType<typeof useQueryCosmeticsPaged>['cosmetics'][number];
type SelectedUser = { id: number; username: string };

function RemovableBadge({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge
      variant="light"
      style={{ paddingRight: 3 }}
      rightSection={
        <LegacyActionIcon
          size="xs"
          color="blue"
          radius="xl"
          variant="transparent"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <IconX size={10} />
        </LegacyActionIcon>
      }
    >
      {label}
    </Badge>
  );
}

function UserMultiSelect({
  selectedUsers,
  onAdd,
  onRemove,
}: {
  selectedUsers: Map<number, SelectedUser>;
  onAdd: (user: SelectedUser) => void;
  onRemove: (userId: number) => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data, isLoading, isFetching } = trpc.user.getAll.useQuery(
    { query: debouncedSearch.trim(), limit: 10 },
    { enabled: debouncedSearch.trim().length > 0 }
  );
  const options =
    data
      ?.filter((x) => x.username && !selectedUsers.has(x.id))
      .map(({ id, username }) => ({ id, value: username as string })) ?? [];

  return (
    <Stack gap="xs">
      <Autocomplete
        ref={searchInputRef}
        label={`Users (${selectedUsers.size} selected)`}
        placeholder="Search users by username"
        data={options}
        value={search}
        onChange={setSearch}
        leftSection={isLoading && isFetching ? <Loader size="xs" /> : <IconSearch size={14} />}
        onOptionSubmit={(value: string) => {
          const option = options.find((x) => x.value === value);
          if (!option) return;
          onAdd({ id: option.id, username: option.value });
          setSearch('');
          searchInputRef.current?.focus();
        }}
      />
      {selectedUsers.size > 0 && (
        <Group gap={4}>
          {[...selectedUsers.values()].map((user) => (
            <RemovableBadge
              key={user.id}
              label={user.username}
              onRemove={() => onRemove(user.id)}
            />
          ))}
        </Group>
      )}
    </Stack>
  );
}

export default function GrantCosmeticsPage() {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticsInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);

  const { cosmetics, pagination, isLoading, isRefetching } =
    useQueryCosmeticsPaged(debouncedFilters);

  // Maps keep selections (with display info) alive across pages/searches
  const [selectedCosmetics, setSelectedCosmetics] = useState<Map<number, CosmeticRow>>(new Map());
  const [selectedUsers, setSelectedUsers] = useState<Map<number, SelectedUser>>(new Map());

  const toggleCosmetic = (cosmetic: CosmeticRow) => {
    setSelectedCosmetics((curr) => {
      const next = new Map(curr);
      if (next.has(cosmetic.id)) next.delete(cosmetic.id);
      else next.set(cosmetic.id, cosmetic);
      return next;
    });
  };

  const allOnPageSelected =
    cosmetics.length > 0 && cosmetics.every((c) => selectedCosmetics.has(c.id));
  const someOnPageSelected = cosmetics.some((c) => selectedCosmetics.has(c.id));

  const toggleAllOnPage = () => {
    setSelectedCosmetics((curr) => {
      const next = new Map(curr);
      if (allOnPageSelected) for (const c of cosmetics) next.delete(c.id);
      else for (const c of cosmetics) next.set(c.id, c);
      return next;
    });
  };

  const grantMutation = trpc.cosmetic.grantToUsers.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Cosmetics granted',
        message: `${result.newlyGranted} of ${result.totalPairs} grants applied${
          result.alreadyOwned > 0 ? `, ${result.alreadyOwned} already owned` : ''
        }.`,
      });
      setSelectedCosmetics(new Map());
      setSelectedUsers(new Map());
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to grant cosmetics',
        error: new Error(error.message),
      });
    },
  });

  const revokeMutation = trpc.cosmetic.revokeFromUsers.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Cosmetics revoked',
        message: `${result.revoked} cosmetic${result.revoked === 1 ? '' : 's'} removed.`,
      });
      setSelectedCosmetics(new Map());
      setSelectedUsers(new Map());
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to revoke cosmetics',
        error: new Error(error.message),
      });
    },
  });

  const handleRevoke = () => {
    const cosmeticList = [...selectedCosmetics.values()];
    const userList = [...selectedUsers.values()];
    if (!cosmeticList.length || !userList.length) return;

    openConfirmModal({
      title: 'Revoke cosmetics',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Remove <strong>{cosmeticList.length}</strong> cosmetic
            {cosmeticList.length === 1 ? '' : 's'} from <strong>{userList.length}</strong> user
            {userList.length === 1 ? '' : 's'}?
          </Text>
          <Text size="sm">
            <strong>Cosmetics:</strong> {cosmeticList.map((c) => c.name).join(', ')}
          </Text>
          <Text size="sm">
            <strong>Users:</strong> {userList.map((u) => u.username).join(', ')}
          </Text>
          <Text size="xs" c="dimmed">
            Equipped cosmetics are unequipped and removed. Users that don&apos;t own a cosmetic are
            skipped.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Revoke', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      centered: true,
      onConfirm: () => {
        revokeMutation.mutate({
          cosmeticIds: cosmeticList.map((c) => c.id),
          userIds: userList.map((u) => u.id),
        });
      },
    });
  };

  const handleGrant = () => {
    const cosmeticList = [...selectedCosmetics.values()];
    const userList = [...selectedUsers.values()];
    if (!cosmeticList.length || !userList.length) return;
    const totalGrants = cosmeticList.length * userList.length;

    openConfirmModal({
      title: 'Grant cosmetics',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Grant <strong>{cosmeticList.length}</strong> cosmetic
            {cosmeticList.length === 1 ? '' : 's'} × <strong>{userList.length}</strong> user
            {userList.length === 1 ? '' : 's'} (<strong>{totalGrants}</strong> grants)?
          </Text>
          <Text size="sm">
            <strong>Cosmetics:</strong> {cosmeticList.map((c) => c.name).join(', ')}
          </Text>
          <Text size="sm">
            <strong>Users:</strong> {userList.map((u) => u.username).join(', ')}
          </Text>
          <Text size="xs" c="dimmed">
            Users that already own a cosmetic are skipped gracefully.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Grant', cancel: 'Cancel' },
      centered: true,
      onConfirm: () => {
        grantMutation.mutate({
          cosmeticIds: cosmeticList.map((c) => c.id),
          userIds: userList.map((u) => u.id),
        });
      },
    });
  };

  return (
    <>
      <Meta title="Grant Cosmetics" deIndex />
      <Container size="lg">
        <Stack gap={0} mb="xl">
          <Title order={1}>Grant Cosmetics</Title>
          <Text size="sm" c="dimmed">
            Select one or more cosmetics from the list below, add one or more users, and grant (or
            revoke) every selected cosmetic to every selected user. Already-owned cosmetics are
            skipped gracefully when granting.
          </Text>
        </Stack>

        <Paper withBorder p="md" radius="md" mb="xl">
          <Stack>
            <Group align="flex-start" grow>
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Cosmetics ({selectedCosmetics.size} selected)
                </Text>
                {selectedCosmetics.size > 0 ? (
                  <Group gap={4}>
                    {[...selectedCosmetics.values()].map((cosmetic) => (
                      <RemovableBadge
                        key={cosmetic.id}
                        label={cosmetic.name}
                        onRemove={() => toggleCosmetic(cosmetic)}
                      />
                    ))}
                  </Group>
                ) : (
                  <Text size="sm" c="dimmed">
                    Select cosmetics from the list below
                  </Text>
                )}
              </Stack>
              <UserMultiSelect
                selectedUsers={selectedUsers}
                onAdd={(user) => setSelectedUsers((curr) => new Map(curr).set(user.id, user))}
                onRemove={(userId) =>
                  setSelectedUsers((curr) => {
                    const next = new Map(curr);
                    next.delete(userId);
                    return next;
                  })
                }
              />
            </Group>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {selectedCosmetics.size > 0 && selectedUsers.size > 0
                  ? `Grant ${selectedCosmetics.size} cosmetic${
                      selectedCosmetics.size === 1 ? '' : 's'
                    } × ${selectedUsers.size} user${selectedUsers.size === 1 ? '' : 's'} (${
                      selectedCosmetics.size * selectedUsers.size
                    } grants)`
                  : 'Select at least one cosmetic and one user'}
              </Text>
              <Group gap="xs">
                <Button
                  color="red"
                  variant="light"
                  disabled={!selectedCosmetics.size || !selectedUsers.size}
                  loading={revokeMutation.isPending}
                  onClick={handleRevoke}
                >
                  Revoke Cosmetics
                </Button>
                <Button
                  disabled={!selectedCosmetics.size || !selectedUsers.size}
                  loading={grantMutation.isPending}
                  onClick={handleGrant}
                >
                  Grant Cosmetics
                </Button>
              </Group>
            </Group>
          </Stack>
        </Paper>

        <Group justify="space-between" mb="md">
          <TextInput
            label="Filter by name"
            value={filters.name ?? ''}
            onChange={(e) => setFilters({ ...filters, name: e.target.value || undefined, page: 1 })}
            size="sm"
            miw={300}
          />
          <CosmeticsFiltersDropdown
            setFilters={(f) => setFilters({ ...filters, ...f, page: 1 })}
            filters={filters}
          />
        </Group>

        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : cosmetics.length ? (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>
                    <Checkbox
                      checked={allOnPageSelected}
                      indeterminate={someOnPageSelected && !allOnPageSelected}
                      onChange={toggleAllOnPage}
                      aria-label="Select all cosmetics on this page"
                    />
                  </Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Sample</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cosmetics.map((cosmetic) => {
                  const isSelected = selectedCosmetics.has(cosmetic.id);
                  return (
                    <Table.Tr
                      key={cosmetic.id}
                      style={
                        isSelected
                          ? { backgroundColor: 'var(--mantine-color-blue-light)' }
                          : undefined
                      }
                    >
                      <Table.Td>
                        <Checkbox
                          checked={isSelected}
                          onChange={() => toggleCosmetic(cosmetic)}
                          aria-label={`Select ${cosmetic.name}`}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={0} maw={350}>
                          <Text>{cosmetic.name}</Text>
                          <Text c="dimmed" size="sm">
                            {cosmetic.description}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light">{getDisplayName(cosmetic.type)}</Badge>
                      </Table.Td>
                      <Table.Td>
                        <CosmeticSample cosmetic={cosmetic} />
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            {pagination && pagination.totalPages > 1 && (
              <Group className="mt-4" justify="space-between">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  value={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </div>
        ) : (
          <Stack align="center">
            <ThemeIcon size={62} radius={100}>
              <IconCloudOff />
            </ThemeIcon>
            <Text align="center">No cosmetics found. Try adjusting your filters.</Text>
          </Stack>
        )}
      </Container>
    </>
  );
}
