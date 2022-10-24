import { Popover, Text, Stack, Box, NavLink } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons';
import { useState, useRef } from 'react';
import { trpc } from '~/utils/trpc';
import { ClearableTextInput } from './../ClearableTextInput/ClearableTextInput';
import { useModelStore } from '~/hooks/useModelStore';
import { useForm } from '@mantine/form';

const limit = 3;

export function ListSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useDebouncedState('', 200);

  const filterQuery = useModelStore((state) => state.filters.query);
  const filterTag = useModelStore((state) => state.filters.tag);
  const setFilterTag = useModelStore((state) => state.setTags);
  const setFilterQuery = useModelStore((state) => state.setQuery);

  const form = useForm({
    initialValues: {
      query: filterQuery ?? filterTag ? `#${filterTag}` : '',
    },
  });

  const canQueryTags = query.startsWith('#') ? query.length > 1 : !query.startsWith('@');

  // const canQueryUsers = query.startsWith('@') ? query.length > 1 : !query.startsWith('#');

  // const { data: users } = trpc.user.getAll.useQuery(
  //   { query: query.startsWith('@') ? query.substring(1) : query, limit },
  //   { enabled: !!query.length && canQueryUsers }
  // );

  const parseTagQuery = (query: string) => (query.startsWith('#') ? query.substring(1) : query);
  const { data: tags } = trpc.tag.getAll.useQuery(
    { query: parseTagQuery(query), limit },
    { enabled: !!query.length && canQueryTags, keepPreviousData: true }
  );

  const handleSetTags = (query: string) => {
    const parsedQuery = parseTagQuery(query);
    const tag = tags?.find((x) => x.name === parsedQuery);
    if (!tag) return;
    setFilterTag(tag.name);
    setFilterQuery(undefined);
  };

  const handleSetQuery = (query: string) => {
    setFilterQuery(query);
    setFilterTag(undefined);
  };

  const handleClear = () => {
    setFilterQuery(undefined);
    setFilterTag(undefined);
  };

  const hasQueriedTags = tags?.some((x) => x.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Popover
      opened={!!tags?.length && focused && !!query.length && hasQueriedTags}
      width="target"
      transition="pop"
    >
      <Popover.Target>
        <form
          onSubmit={form.onSubmit(({ query }) => {
            if (query.startsWith('#')) handleSetTags(query);
            else handleSetQuery(query);
            inputRef.current?.blur();
          })}
        >
          <ClearableTextInput
            icon={<IconSearch />}
            placeholder="Search by models, #tags"
            {...form.getInputProps('query')}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              form.setValues({ query: e.target.value });
              setQuery(e.target.value);
            }}
            onClear={handleClear}
            ref={inputRef}
          />
        </form>
      </Popover.Target>
      <Popover.Dropdown px={0}>
        <Stack spacing="lg">
          {/* {!!users?.length && (
            <Stack spacing={5}>
              <Text size="sm" weight={700} color="dimmed" px="xs">
                Users
              </Text>
              <Box>
                {users.map((user) => (
                  <NavLink key={user.id} label={`@ ${user.name}`} />
                ))}
              </Box>
            </Stack>
          )} */}
          {tags?.some((x) => x.name.toLowerCase().includes(query.toLowerCase())) && (
            <Stack spacing={5}>
              <Text size="sm" weight={700} color="dimmed" px="xs">
                Tags
              </Text>
              <Box>
                {tags.map((tag) => (
                  <NavLink
                    key={tag.id}
                    label={`# ${tag.name}`}
                    onClick={() => {
                      form.setValues({ query: `#${tag.name}` });
                      handleSetTags(tag.name);
                    }}
                  />
                ))}
              </Box>
            </Stack>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
