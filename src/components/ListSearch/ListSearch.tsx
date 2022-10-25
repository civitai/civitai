import { Popover, Text, Stack, Box, NavLink } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons';
import { useState, useRef, useEffect } from 'react';
import { trpc } from '~/utils/trpc';
import { ClearableTextInput } from './../ClearableTextInput/ClearableTextInput';
import { useForm } from '@mantine/form';
import { useRouter } from 'next/router';
import { useModelFilters } from '~/hooks/useModelFilters';

const limit = 3;

export function ListSearch() {
  const router = useRouter();
  const {
    filters: { tag, query },
    setFilters,
  } = useModelFilters();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useDebouncedState('', 200);

  const form = useForm({
    initialValues: {
      query: '',
    },
  });

  useEffect(() => {
    form.setValues({ query: router.route === '/' ? (query ?? tag ? `#${tag}` : '') : '' });
  }, [router.route, query, tag]); //eslint-disable-line

  // const canQueryUsers = query.startsWith('@') ? query.length > 1 : !query.startsWith('#');

  // const { data: users } = trpc.user.getAll.useQuery(
  //   { query: query.startsWith('@') ? query.substring(1) : query, limit },
  //   { enabled: !!query.length && canQueryUsers }
  // );

  const canQueryTags = value.startsWith('#') ? value.length > 1 : !value.startsWith('@');
  const parseTagQuery = (query: string) =>
    query.startsWith('#') ? query.substring(1).toLowerCase() : query.toLowerCase();

  const { data: tags } = trpc.tag.getAll.useQuery(
    { query: parseTagQuery(value), limit },
    { enabled: !!value.length && canQueryTags, keepPreviousData: true }
  );

  const handleSetTags = (query: string) => {
    const parsedQuery = parseTagQuery(query);
    const tag = tags?.find((x) => x.name.toLowerCase() === parsedQuery);
    if (!tag) return;
    setFilters((state) => ({ ...state, tag: tag.name, query: undefined }));
  };

  const handleSetQuery = (query: string) => {
    setFilters((state) => ({ ...state, tag: undefined, query }));
  };

  const handleClear = () => {
    setFilters((state) => ({ ...state, tag: undefined, query: undefined }));
  };

  const hasQueriedTags = tags?.some((x) => {
    const parsedQuery = parseTagQuery(value);
    return !!parsedQuery.length ? x.name.toLowerCase().includes(parsedQuery) : false;
  });

  return (
    <Popover
      opened={!!tags?.length && focused && !!value.length && hasQueriedTags}
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
              setValue(e.target.value);
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
          {tags?.some((x) => x.name.toLowerCase().includes(parseTagQuery(value))) && (
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
