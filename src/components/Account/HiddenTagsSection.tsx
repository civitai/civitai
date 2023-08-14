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

export function HiddenTagsSection() {
  const queryUtils = trpc.useContext();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const { data: moderationTags } = trpc.system.getModeratedTags.useQuery();
  const { data: hiddenTags = [], isLoading: loadingBlockedTags } = trpc.user.getTags.useQuery({
    type: 'Hide',
  });
  const { tags: userHiddenTags } = useHiddenPreferences();

  const blockedTags = hiddenTags.filter(
    (x) => !moderationTags?.some((m) => m.id === x.id) && userHiddenTags.get(x.id)
  );

  const { data, isLoading } = trpc.tag.getAll.useQuery(
    {
      entityType: ['Model'],
      query: debouncedSearch.toLowerCase().trim(),
    },
    { enabled: !loadingBlockedTags }
  );
  const modelTags = data?.items.map(({ id, name }) => ({ id, value: name })) ?? [];

  const handleToggleBlockedTag = async (tagId: number) => {
    await hiddenPreferences.toggleTags({ tagIds: [tagId] });

    invalidateModeratedContentDebounced(queryUtils, ['tag']); // TODO - remove this once frontend filtering is finished

    const prevBlockedTags = queryUtils.user.getTags.getData({ type: 'Hide' }) ?? [];
    const removing = prevBlockedTags.some((tag) => tag.id === tagId);

    queryUtils.user.getTags.setData({ type: 'Hide' }, (old = []) => {
      if (removing) return old.filter((tag) => tag.id !== tagId);

      const { models, ...addedTag } = data?.items.find((tag) => tag.id === tagId) ?? {
        id: tagId,
        name: '',
      };
      return [...old, addedTag];
    });
    setSearch('');
  };

  return (
    <>
      <Card.Section withBorder sx={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search tags to hide"
          data={modelTags}
          value={search}
          onChange={setSearch}
          icon={isLoading ? <Loader size="xs" /> : <IconSearch size={14} />}
          onItemSubmit={(item: { value: string; id: number }) => {
            handleToggleBlockedTag(item.id);
            searchInputRef.current?.focus();
          }}
          withinPortal
          variant="unstyled"
        />
      </Card.Section>
      <Card.Section inheritPadding pt="md">
        <Stack spacing={5}>
          <Skeleton visible={loadingBlockedTags}>
            {blockedTags.length > 0 && (
              <Group spacing={4}>
                {blockedTags.map((tag) => (
                  <Badge
                    key={tag.id}
                    sx={{ paddingRight: 3 }}
                    rightSection={
                      <ActionIcon
                        size="xs"
                        color="blue"
                        radius="xl"
                        variant="transparent"
                        onClick={() => handleToggleBlockedTag(tag.id)}
                      >
                        <IconX size={10} />
                      </ActionIcon>
                    }
                  >
                    {tag.name}
                  </Badge>
                ))}
              </Group>
            )}
          </Skeleton>
          <Text color="dimmed" size="xs">
            {`We'll hide content with these tags throughout the site.`}
          </Text>
        </Stack>
      </Card.Section>
    </>
  );
}
