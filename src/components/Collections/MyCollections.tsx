import {
  Badge,
  Center,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CollectionContributorPermission, CollectionType } from '~/shared/utils/prisma/enums';
import { IconFilter, IconPlaylistX, IconSearch } from '@tabler/icons-react';
import { createElement, useMemo, useState } from 'react';
import classes from './MyCollections.module.scss';
import { CollectionInviteList } from '~/components/Collections/CollectionCollaborators/CollectionInviteList';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { CollectionGetAllUserModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { collectionTypeData, useCollectionsPermissionsMap } from './collection.utils';

// Reusable collection nav link component
function CollectionNavLink({
  collection,
  isActive,
  isCollaborator,
  onClick,
}: {
  collection: CollectionGetAllUserModel;
  isActive: boolean;
  isCollaborator: boolean;
  onClick: () => void;
}) {
  return (
    <NavLink
      radius="sm"
      onClick={onClick}
      active={isActive}
      className={classes.navLinkWrapper}
      label={
        <Group gap="xs" justify="space-between" w="100%" wrap="nowrap">
          <Group gap="xs" className={classes.nameGroup} wrap="nowrap">
            {collection.type && (
              <ThemeIcon
                size={18}
                variant="subtle"
                color={collectionTypeData[collection.type].color}
                className={classes.typeIcon}
              >
                {createElement(collectionTypeData[collection.type].icon, { size: 14 })}
              </ThemeIcon>
            )}
            <Text lineClamp={1} inherit className={classes.nameText}>
              {collection.name}
            </Text>
          </Group>
          <Group gap={4} wrap="nowrap">
            {isCollaborator && (
              <Badge size="xs" variant="light" color="blue">
                Shared
              </Badge>
            )}
            {collection.type && (
              <Badge
                size="xs"
                variant="dot"
                color={collectionTypeData[collection.type].color}
                className={classes.typeBadge}
              >
                {collectionTypeData[collection.type].label}
              </Badge>
            )}
          </Group>
        </Group>
      }
    />
  );
}

export function MyCollections({ children, onSelect, sortOrder = 'asc' }: MyCollectionsProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const router = useRouter();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    { permission: CollectionContributorPermission.VIEW },
    { enabled: !!currentUser }
  );

  const selectCollection = (id: number) => {
    router.push(`/collections/${id}`);
    onSelect?.(collections.find((c) => c.id === id)!);
  };

  const filteredCollections = useMemo(() => {
    let filtered = collections;

    // Filter by search query
    if (debouncedQuery) {
      filtered = filtered.filter((c) =>
        c.name.toLowerCase().includes(debouncedQuery.toLowerCase())
      );
    }

    // Filter by type
    if (typeFilter) {
      filtered = filtered.filter((c) => c.type === typeFilter);
    }

    return filtered;
  }, [debouncedQuery, collections, typeFilter]);

  const sortedCollections = useMemo(() => {
    if (!filteredCollections) return [];

    return [...filteredCollections].sort((a, b) =>
      sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    );
  }, [filteredCollections, sortOrder]);

  const noCollections = !isLoading && sortedCollections.length === 0;
  const ownedFilteredCollections = sortedCollections.filter((collection) => collection.isOwner);
  const contributingFilteredCollections = sortedCollections.filter(
    (collection) => !collection.isOwner
  );

  // Owned rows never carry isCollaborator, so only the contributing side needs the lookup.
  const { map: collaboratorPermissionsMap } = useCollectionsPermissionsMap(
    contributingFilteredCollections.map((c) => c.id),
    { enabled: features.collaborativeCollections }
  );

  const FilterBox = (
    <TextInput
      variant="unstyled"
      leftSection={<IconSearch size={20} />}
      onChange={(e) => setQuery(e.target.value)}
      value={query}
      placeholder="Search"
    />
  );

  const TypeFilter = (
    <Select
      placeholder="Filter by type"
      value={typeFilter}
      onChange={setTypeFilter}
      data={Object.values(CollectionType).map((type) => ({
        value: type,
        label: collectionTypeData[type].label,
      }))}
      clearable
      size="xs"
      leftSection={
        typeFilter ? (
          createElement(collectionTypeData[typeFilter as CollectionType].icon, { size: 14 })
        ) : (
          <IconFilter size={14} />
        )
      }
      styles={{
        input: {
          fontWeight: typeFilter ? 500 : 400,
        },
      }}
    />
  );

  const Collections = (
    <Skeleton visible={isLoading} animate>
      {ownedFilteredCollections.map((c) => (
        <CollectionNavLink
          key={c.id}
          collection={c}
          isActive={router.query?.collectionId === c.id.toString()}
          isCollaborator={false}
          onClick={() => selectCollection(c.id)}
        />
      ))}
      {contributingFilteredCollections.length > 0 && (
        <Divider label="Collections you follow" labelPosition="left" mt="md" mb="xs" ml="sm" />
      )}
      {contributingFilteredCollections.map((c) => (
        <CollectionNavLink
          key={c.id}
          collection={c}
          isActive={router.query?.collectionId === c.id.toString()}
          isCollaborator={!!collaboratorPermissionsMap.get(c.id)?.isCollaborator}
          onClick={() => selectCollection(c.id)}
        />
      ))}
      {noCollections && (
        <Center py="xl">
          <Stack gap="xs" align="center">
            <ThemeIcon color="gray" size={48} radius="xl" variant="light">
              <IconPlaylistX size={28} />
            </ThemeIcon>
            <Text c="dimmed" size="sm" ta="center">
              No collections found
            </Text>
            {(typeFilter || debouncedQuery) && (
              <Text size="xs" c="dimmed">
                Try changing your filters
              </Text>
            )}
          </Stack>
        </Center>
      )}
    </Skeleton>
  );

  const InviteList = <CollectionInviteList />;

  if (children) {
    return children({
      FilterBox,
      TypeFilter,
      Collections,
      InviteList,
      collections: sortedCollections,
      isLoading,
      noCollections,
    });
  }

  return (
    <Stack gap={4}>
      {InviteList}
      {FilterBox}
      {TypeFilter}
      <ScrollArea>{Collections}</ScrollArea>
    </Stack>
  );
}

type SortOrder = 'asc' | 'desc';

type MyCollectionsProps = {
  children?: (elements: {
    FilterBox: React.ReactNode;
    TypeFilter: React.ReactNode;
    Collections: React.ReactNode;
    InviteList: React.ReactNode;
    collections: CollectionGetAllUserModel[];
    isLoading: boolean;
    noCollections: boolean;
  }) => JSX.Element;
  onSelect?: (collection: CollectionGetAllUserModel) => void;
  pathnameOverride?: string;
  sortOrder?: SortOrder;
};
