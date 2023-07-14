import { NavLink, ScrollArea, Stack, TextInput, createStyles, Skeleton, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { CollectionContributorPermission } from '@prisma/client';
import { IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useCollectionQueryParams } from '~/components/Collections/collection.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function MyCollections() {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const currentUser = useCurrentUser();
  const { collectionId, set } = useCollectionQueryParams();
  const { classes } = useStyles();
  const { data: collections = [], isLoading } = trpc.collection.getAllUser.useQuery(
    { permission: CollectionContributorPermission.VIEW },
    { enabled: !!currentUser }
  );

  const selectCollection = (id: number) => {
    set({ collectionId: id });
  };

  const filteredCollections = useMemo(
    () => collections.filter((c) => c.name.toLowerCase().includes(debouncedQuery.toLowerCase())),
    [debouncedQuery, collections]
  );

  return (
    <Stack spacing={4}>
      <Text weight={500}>My Collections</Text>
      <TextInput
        icon={<IconSearch />}
        onChange={(e) => setQuery(e.target.value)}
        value={query}
        placeholder="Filter"
      />
      <ScrollArea>
        <Skeleton visible={isLoading} animate>
          {filteredCollections.map((c) => (
            <NavLink
              key={c.id}
              className={classes.navItem}
              onClick={() => selectCollection(c.id)}
              active={collectionId === c.id}
              label={<Text>{c.name}</Text>}
            ></NavLink>
          ))}
        </Skeleton>
      </ScrollArea>
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  navItem: {
    borderRadius: theme.radius.sm,
  },
  header: {},
}));
