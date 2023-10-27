import {
  NavLink,
  ScrollArea,
  Stack,
  TextInput,
  createStyles,
  Skeleton,
  Text,
  ThemeIcon,
  Group,
  Divider,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CollectionContributorPermission } from '@prisma/client';
import { IconPlaylistX, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CollectionGetAllUserModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';

export function MyCollections({ children, onSelect }: MyCollectionsProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { classes } = useStyles();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    { permission: CollectionContributorPermission.VIEW },
    { enabled: !!currentUser }
  );

  const selectCollection = (id: number) => {
    router.push(`/collections/${id}`);
    onSelect?.(collections.find((c) => c.id === id)!);
  };

  const filteredCollections = useMemo(
    () =>
      !debouncedQuery
        ? collections
        : collections.filter((c) => c.name.toLowerCase().includes(debouncedQuery.toLowerCase())),
    [debouncedQuery, collections]
  );
  const noCollections = !isLoading && filteredCollections.length === 0;
  const ownedFilteredCollections = filteredCollections.filter((collection) => collection.isOwner);
  const contributingFilteredCollections = filteredCollections.filter(
    (collection) => !collection.isOwner
  );

  const FilterBox = (
    <TextInput
      variant="unstyled"
      icon={<IconSearch size={20} />}
      onChange={(e) => setQuery(e.target.value)}
      value={query}
      placeholder="Filter"
    />
  );

  const Collections = (
    <Skeleton visible={isLoading} animate>
      {ownedFilteredCollections.map((c) => (
        <NavLink
          key={c.id}
          className={classes.navItem}
          onClick={() => selectCollection(c.id)}
          active={router.query?.collectionId === c.id.toString()}
          label={<Text>{c.name}</Text>}
        ></NavLink>
      ))}
      {contributingFilteredCollections.length > 0 && <Divider label="Following" mt="sm" />}
      {contributingFilteredCollections.map((c) => (
        <NavLink
          key={c.id}
          className={classes.navItem}
          onClick={() => selectCollection(c.id)}
          active={router.query?.collectionId === c.id.toString()}
          label={<Text>{c.name}</Text>}
        ></NavLink>
      ))}
      {noCollections && (
        <Group>
          <ThemeIcon color="gray" size="md" radius="xl">
            <IconPlaylistX size={20} />
          </ThemeIcon>
          <Text color="dimmed">No collections found</Text>
        </Group>
      )}
    </Skeleton>
  );

  if (children) {
    return children({
      FilterBox,
      Collections,
      collections: filteredCollections,
      isLoading,
      noCollections,
    });
  }

  return (
    <Stack spacing={4}>
      {FilterBox}
      <ScrollArea>{Collections}</ScrollArea>
    </Stack>
  );
}

type MyCollectionsProps = {
  children?: (elements: {
    FilterBox: React.ReactNode;
    Collections: React.ReactNode;
    collections: CollectionGetAllUserModel[];
    isLoading: boolean;
    noCollections: boolean;
  }) => JSX.Element;
  onSelect?: (collection: CollectionGetAllUserModel) => void;
  pathnameOverride?: string;
};

const useStyles = createStyles((theme) => ({
  navItem: {
    borderRadius: theme.radius.sm,
  },
  header: {},
}));
