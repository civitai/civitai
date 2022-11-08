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

export function ListSearch({ onSearch }: Props) {
  const router = useRouter();
  const {
    filters: { tag, query, user },
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
    form.setValues({
      query: router.route === '/' ? query ?? (tag ? `#${tag}` : user ? `@${user}` : '') : '',
    });
  }, [router.route, query, tag]); //eslint-disable-line

  const canQueryUsers = value.startsWith('@') ? value.length > 1 : !value.startsWith('#');
  const parseUserQuery = (query: string) =>
    query.startsWith('@') ? query.substring(1).toLowerCase() : query.toLowerCase();

  const { data: users } = trpc.user.getAll.useQuery(
    { query: parseUserQuery(value), limit },
    { enabled: !!value.length && canQueryUsers, keepPreviousData: true }
  );

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
    setFilters((state) => ({ ...state, tag: tag.name, query: undefined, user: undefined }));
  };

  const handleSetUsers = (query: string) => {
    const parsedQuery = parseUserQuery(query);
    const user = users?.find((x) => x.username?.toLowerCase() === parsedQuery);
    if (!user) return;
    setFilters((state) => ({
      ...state,
      tag: undefined,
      query: undefined,
      user: user.username || undefined,
    }));
  };

  const handleSetQuery = (query: string) => {
    setFilters((state) => ({ ...state, tag: undefined, query, user: undefined }));
  };

  const handleClear = () => {
    setFilters((state) => ({ ...state, tag: undefined, query: undefined, user: undefined }));
  };

  const hasQueriedTags = tags?.some((x) => {
    const parsedQuery = parseTagQuery(value);
    return !!parsedQuery.length ? x.name.toLowerCase().includes(parsedQuery) : false;
  });

  const hasQueriedUsers = users?.some((x) => {
    const parsedQuery = parseUserQuery(value);
    return !!parsedQuery.length ? x.username?.toLowerCase().includes(parsedQuery) : false;
  });

  return (
    <Popover
      opened={focused && !!value.length && (hasQueriedTags || hasQueriedUsers)}
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
            placeholder="Search"
            {...form.getInputProps('query')}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              const query = e.target.value;
              form.setValues({ query });
              setValue(query);
              onSearch?.(query);
            }}
            onClear={handleClear}
            ref={inputRef}
          />
        </form>
      </Popover.Target>
      <Popover.Dropdown px={0}>
        <Stack spacing="lg">
          {users?.some((x) => x.username?.toLowerCase().includes(parseUserQuery(value))) && (
            <Stack spacing={5}>
              <Text size="sm" weight={700} color="dimmed" px="xs">
                Users
              </Text>
              <Box>
                {users.map(
                  ({ id, username }) =>
                    username && (
                      <NavLink
                        key={id}
                        label={`@ ${username}`}
                        onClick={() => {
                          form.setValues({ query: `@${username}` });
                          handleSetUsers(username);
                        }}
                      />
                    )
                )}
              </Box>
            </Stack>
          )}
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

type Props = { onSearch?: (value: string) => void };
