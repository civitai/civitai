import {
  Badge,
  Center,
  Group,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import clsx from 'clsx';
import { CollectionContributorPermission, CollectionType } from '~/shared/utils/prisma/enums';
import {
  IconChevronDown,
  IconFilter,
  IconPlaylistX,
  IconSearch,
  IconUsers,
} from '@tabler/icons-react';
import { createElement, useMemo, useState } from 'react';
import { CollectionInviteList } from '~/components/Collections/CollectionCollaborators/CollectionInviteList';
import { CollectionListMenu } from '~/components/Collections/CollectionListMenu';
import { CollectionListRow } from '~/components/Collections/CollectionListRow';
import {
  buildCollectionSections,
  roleLabelFor,
  sortCollections,
} from '~/components/Collections/collection-list.utils';
import { useCollectionListPreferences } from '~/components/Collections/useCollectionListPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CollectionGetAllUserModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { collectionTypeData, useCollectionsPermissionsMap } from './collection.utils';
import classes from './MyCollections.module.scss';

function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={clsx(classes.sectionHeader, 'w-full')}
    >
      <Group gap={6} px="xs" py={6} wrap="nowrap">
        <IconChevronDown
          size={14}
          className={clsx(classes.sectionChevron, collapsed && classes.sectionChevronCollapsed)}
        />
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" className="tracking-wide">
          {label}
        </Text>
        <Badge size="xs" variant="light" color="gray">
          {count}
        </Badge>
      </Group>
    </UnstyledButton>
  );
}

export function MyCollections({ children, onSelect }: MyCollectionsProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    { permission: CollectionContributorPermission.VIEW },
    { enabled: !!currentUser }
  );

  const selectCollection = (id: number) => {
    router.push(`/collections/${id}`);
    onSelect?.(collections.find((c) => c.id === id)!);
  };

  const nonOwnedIds = useMemo(
    () => collections.filter((c) => !c.isOwner).map((c) => c.id),
    [collections]
  );
  const { map: permissionsMap, isLoading: permissionsLoading } =
    useCollectionsPermissionsMap(nonOwnedIds);

  const { view, setView, sort, setSort, collapsed, toggleSection } = useCollectionListPreferences();

  const sections = useMemo(() => {
    const filtered = collections.filter((c) => {
      if (debouncedQuery && !c.name.toLowerCase().includes(debouncedQuery.toLowerCase()))
        return false;
      if (typeFilter && c.type !== typeFilter) return false;
      if (roleFilter) {
        const role = c.isOwner ? 'Owner' : roleLabelFor(permissionsMap.get(c.id)) ?? 'Follower';
        if (role !== roleFilter) return false;
      }
      return true;
    });

    return buildCollectionSections(sortCollections(filtered, sort), permissionsMap);
  }, [collections, debouncedQuery, typeFilter, roleFilter, permissionsMap, sort]);

  const visibleCollections = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  const noCollections = !isLoading && visibleCollections.length === 0;

  const FilterBox = (
    <TextInput
      variant="unstyled"
      leftSection={<IconSearch size={20} />}
      onChange={(e) => setQuery(e.target.value)}
      value={query}
      placeholder="Search collections"
    />
  );

  const TypeFilter = (
    <Select
      placeholder="All types"
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

  const ListMenu = (
    <CollectionListMenu sort={sort} setSort={setSort} view={view} setView={setView} />
  );

  const RoleFilter = (
    <Select
      placeholder="Any role"
      value={roleFilter}
      onChange={setRoleFilter}
      data={['Owner', 'Manager', 'Contributor', 'Follower']}
      clearable
      size="xs"
      leftSection={<IconUsers size={14} />}
    />
  );

  const Filters = (
    <Group gap="xs" grow wrap="nowrap">
      {TypeFilter}
      {RoleFilter}
    </Group>
  );

  const Collections = (
    <Skeleton visible={isLoading || permissionsLoading} animate>
      {sections.map(
        ({ key, label, rows }) =>
          rows.length > 0 && (
            <div key={key}>
              <SectionHeader
                label={label}
                count={rows.length}
                collapsed={collapsed.includes(key)}
                onToggle={() => toggleSection(key)}
              />
              {!collapsed.includes(key) &&
                rows.map((c) => (
                  <CollectionListRow
                    key={c.id}
                    collection={c}
                    view={view}
                    isActive={router.query?.collectionId === c.id.toString()}
                    roleLabel={roleLabelFor(permissionsMap.get(c.id))}
                    onClick={() => selectCollection(c.id)}
                  />
                ))}
            </div>
          )
      )}
      {noCollections && (
        <Center py="xl">
          <Stack gap="xs" align="center">
            <ThemeIcon color="gray" size={48} radius="xl" variant="light">
              <IconPlaylistX size={28} />
            </ThemeIcon>
            <Text c="dimmed" size="sm" ta="center">
              No collections found
            </Text>
            {(typeFilter || roleFilter || debouncedQuery) && (
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
      Filters,
      ListMenu,
      Collections,
      InviteList,
      collections: visibleCollections,
      isLoading: isLoading || permissionsLoading,
      noCollections,
    });
  }

  return (
    <Stack gap={4}>
      {InviteList}
      <Group gap="xs" wrap="nowrap">
        <div style={{ flex: 1 }}>{FilterBox}</div>
        {ListMenu}
      </Group>
      {Filters}
      <ScrollArea>{Collections}</ScrollArea>
    </Stack>
  );
}

type MyCollectionsProps = {
  children?: (elements: {
    FilterBox: React.ReactNode;
    Filters: React.ReactNode;
    ListMenu: React.ReactNode;
    Collections: React.ReactNode;
    InviteList: React.ReactNode;
    collections: CollectionGetAllUserModel[];
    isLoading: boolean;
    noCollections: boolean;
  }) => JSX.Element;
  onSelect?: (collection: CollectionGetAllUserModel) => void;
  pathnameOverride?: string;
};
