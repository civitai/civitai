import { Text, Box, Group, Badge, SelectItemProps, BadgeProps } from '@mantine/core';
import { useForm } from '@mantine/form';
import { useHotkeys, useDebouncedState } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconSearch } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useRef, useEffect, useMemo, forwardRef } from 'react';

import { ClearableAutoComplete } from '~/components/ClearableAutoComplete/ClearableAutoComplete';
import { useModelFilters } from '~/hooks/useModelFilters';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type CustomAutocompleteItem = {
  value: string;
  group: 'Models' | 'Users' | 'Tags';
  badge?: React.ReactElement<BadgeProps> | null;
};

const limit = 3;

export function ListSearch({ onSearch }: Props) {
  const router = useRouter();
  const {
    filters: { tag, query, username },
    setFilters,
  } = useModelFilters();
  const searchRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useDebouncedState('', 300);

  const form = useForm({
    initialValues: { query: '' },
  });

  useEffect(() => {
    setValue('');
  }, [router]); // eslint-disable-line

  useEffect(() => {
    form.setValues({
      query:
        router.route === '/' ? query ?? (tag ? `#${tag}` : username ? `@${username}` : '') : '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.route, query, tag, username]);

  useHotkeys([['mod+K', () => searchRef.current?.focus()]]);

  const queryingUsers = value.startsWith('@');
  const canQueryUsers = queryingUsers && value.length > 1;
  const parseUserQuery = (query: string) =>
    query.startsWith('@') ? query.substring(1).toLowerCase().trim() : query.toLowerCase();

  const { data: users } = trpc.user.getAll.useQuery(
    { query: parseUserQuery(value), limit },
    { enabled: !!value.length && canQueryUsers }
  );

  const canQueryTags = value.startsWith('#') ? value.length > 1 : !value.startsWith('@');
  const parseTagQuery = (query: string) =>
    query.startsWith('#') ? query.substring(1).toLowerCase().trim() : query.toLowerCase();

  const { data: tags } = trpc.tag.getAll.useQuery(
    { query: parseTagQuery(value), limit, entityType: [TagTarget.Model] },
    { enabled: !!value.length && canQueryTags }
  );

  const canQueryModels = !value.startsWith('#') && !value.startsWith('@');
  const { data: models } = trpc.model.getAllPagedSimple.useQuery(
    { query: parseTagQuery(value), limit },
    { enabled: !!value.length && canQueryModels }
  );

  const handleSetTag = (query: string) => {
    const parsedQuery = parseTagQuery(query);
    const tag = tags?.items.find((x) => x.name.toLowerCase() === parsedQuery);
    if (!tag) return;
    router.push(`/tag/${tag.name.toLowerCase()}`);
  };

  const handleSetUser = (query: string) => {
    const parsedQuery = parseUserQuery(query);
    const user = users?.find((x) => x.username?.toLowerCase() === parsedQuery);
    if (!user) return;
    router.push(`/user/${user.username}`);
  };

  const handleSetModel = (query: string) => {
    const model = models?.items.find((x) => x.name.toLowerCase() === query.toLowerCase());
    if (!model) return;
    router.push(`/models/${model.id}/${slugit(model.name)}`);
  };

  const handleSetQuery = (query: string) => {
    setFilters((state) => ({ ...state, tag: undefined, query, username: undefined }));
  };

  const handleClear = () => {
    setFilters((state) => ({ ...state, tag: undefined, query: undefined, username: undefined }));
  };

  const autocompleteData = useMemo(
    () =>
      ([] as CustomAutocompleteItem[])
        .concat(
          models?.items.map((model) => ({
            value: model.name,
            group: 'Models',
            badge: model.nsfw ? <Badge color="red">NSFW</Badge> : null,
          })) ?? []
        )
        .concat(
          queryingUsers
            ? users?.map((user) => ({ value: user.username as string, group: 'Users' })) ?? []
            : []
        )
        .concat(tags?.items.map((tag) => ({ value: tag.name, group: 'Tags' })) ?? []),
    [models?.items, queryingUsers, tags?.items, users]
  );

  return (
    <form
      onSubmit={form.onSubmit(({ query }) => {
        if (query.startsWith('#')) handleSetTag(query);
        else if (query.startsWith('@')) handleSetUser(query);
        else handleSetQuery(query);
        searchRef.current?.blur();
      })}
    >
      <ClearableAutoComplete
        {...form.getInputProps('query')}
        ref={searchRef}
        placeholder="Search models, #tags, @users"
        limit={10}
        icon={<IconSearch />}
        data={autocompleteData}
        onClear={handleClear}
        onChange={(query) => {
          form.setValues({ query });
          setValue(query);
          onSearch?.(query);
        }}
        itemComponent={SearchItem}
        onItemSubmit={(item: CustomAutocompleteItem) => {
          const { value, group } = item;
          if (group === 'Models') handleSetModel(value);
          else if (group === 'Users') handleSetUser(value);
          else if (group === 'Tags') handleSetTag(value);
        }}
        filter={(value) => {
          if (value.startsWith('@')) {
            const parsed = parseUserQuery(value.toLowerCase().trim());
            return users?.some((user) => user.username?.toLowerCase().includes(parsed)) ?? false;
          }
          if (value.startsWith('#')) {
            const parsed = parseTagQuery(value.toLowerCase().trim());
            return tags?.items.some((tag) => tag.name.toLowerCase().includes(parsed)) ?? false;
          }

          return true;
        }}
        clearable
      />
    </form>
  );
}

type Props = { onSearch?: (value: string) => void };

const SearchItem = forwardRef<HTMLDivElement, SearchItemProps>(
  ({ group, value, badge, ...props }, ref) => {
    return (
      <Box ref={ref} {...props} key={`${group}-${value}`}>
        <Group noWrap spacing="xs">
          <Text lineClamp={1}>
            {group === 'Users' ? `@ ${value}` : group === 'Tags' ? `# ${value}` : value}
          </Text>
          {badge}
        </Group>
      </Box>
    );
  }
);
SearchItem.displayName = 'SearchItem';

type SearchItemProps = SelectItemProps & CustomAutocompleteItem;
