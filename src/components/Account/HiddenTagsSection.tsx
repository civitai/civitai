import { Autocomplete, Badge, Card, Loader, Portal, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconX } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';
import { useMemo, useRef, useState } from 'react';
import { BasicMasonryGrid } from '~/components/MasonryGrid/BasicMasonryGrid';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { getTagDisplayName } from '~/libs/tags';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function HiddenTagsSection({ withTitle = true }: { withTitle?: boolean }) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  const tags = useHiddenPreferencesData().hiddenTags;
  const hiddenTags = useMemo(() => {
    const uniqueTags = uniqBy(
      tags.filter((x) => x.hidden && !x.parentId),
      'id'
    );

    return uniqueTags;
  }, [tags]);

  const { data, isLoading } = trpc.tag.getAll.useQuery({
    // entityType: ['Model'],
    query: debouncedSearch.toLowerCase().trim(),
    sort: TagSort.MostHidden,
  });
  const modelTags =
    data?.items
      .filter((x) => !hiddenTags.some((y) => y.id === x.id))
      .map(({ id, name }) => ({ id, value: name })) ?? [];

  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleToggleBlockedTag = async (tag: { id: number; name: string }) => {
    await toggleHiddenMutation.mutateAsync({ kind: 'tag', data: [tag] });
    setSearch('');
  };

  return (
    <Card withBorder>
      {withTitle && (
        <Card.Section withBorder inheritPadding py="xs">
          <Text fw={500}>Hidden Tags</Text>
        </Card.Section>
      )}
      <Card.Section withBorder style={{ marginTop: -1 }}>
        <Autocomplete
          name="tag"
          ref={searchInputRef}
          placeholder="Search tags to hide"
          data={modelTags}
          value={search}
          onChange={setSearch}
          leftSection={isLoading ? <Loader size="xs" /> : <IconSearch size={14} />}
          onOptionSubmit={(value: string) => {
            const record = modelTags.find((x) => x.value === value);
            if (!record) return;
            handleToggleBlockedTag({ id: record.id, name: record.value });
            searchInputRef.current?.focus();
          }}
          variant="unstyled"
          style={{
            zIndex: 400,
          }}
          limit={10}
        />
      </Card.Section>
      <Card.Section inheritPadding py="md">
        <Stack gap={5}>
          <BasicMasonryGrid
            items={hiddenTags}
            render={TagBadge}
            maxHeight={250}
            columnGutter={4}
            columnWidth={140}
          />
          <Text c="dimmed" size="xs">
            {`We'll hide content with these tags throughout the site.`}
          </Text>
        </Stack>
      </Card.Section>
    </Card>
  );
}

function TagBadge({ data, width }: { data: { id: number; name: string }; width: number }) {
  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleToggleBlocked = async (tag: { id: number; name: string }) => {
    await toggleHiddenMutation.mutateAsync({ kind: 'tag', data: [tag] });
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
      {getTagDisplayName(data.name ?? '[deleted]')}
    </Badge>
  );
}
