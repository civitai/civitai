import {
  Autocomplete,
  Badge,
  Group,
  lighten,
  Portal,
  TextInput,
  useMantineTheme,
} from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function VotableTagAdd({ addTag, autosuggest }: VotableTagAddProps) {
  const theme = useMantineTheme();
  // Autocomplete logic
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [adding, { open, close }] = useDisclosure(false);

  const { data } = trpc.tag.getAll.useQuery(
    {
      limit: 10,
      entityType: [TagTarget.Image],
      types: ['UserGenerated', 'Label'],
      query: debouncedSearch.trim().toLowerCase(),
      include: ['nsfwLevel'],
    },
    {
      enabled: autosuggest && debouncedSearch.trim().length > 0,
    }
  );

  const handleClose = useCallback(() => {
    close();
    setSearch('');
  }, [close]);

  const handleSubmit = useCallback(() => {
    const value = search.trim().toLowerCase();
    if (value) addTag(value);

    handleClose();
  }, [addTag, handleClose, search]);

  const badgeColor = theme.variantColorResolver({ color: 'blue', variant: 'light', theme });
  const badgeBorder = lighten(badgeColor.background ?? theme.colors.gray[4], 0.05);

  return (
    <Badge
      radius="xs"
      className="cursor-pointer px-[5px]"
      style={{
        backgroundColor: badgeColor.background,
        borderColor: badgeBorder,
        color: badgeColor.color,
      }}
      onClick={!adding ? open : undefined}
    >
      <Group gap={4}>
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : autosuggest ? (
          <Portal>
            <Autocomplete
              variant="unstyled"
              classNames={{ dropdown: 'max-w-[300px]', input: 'uppercase font-bold text-[11px]' }}
              value={search}
              onChange={setSearch}
              data={
                data?.items.map((tag) => ({
                  id: tag.id,
                  value: tag.name,
                  name: getDisplayName(tag.name),
                })) ?? []
              }
              placeholder="Type to search..."
              onOptionSubmit={(item) => {
                addTag(item);
                handleClose();
              }}
              onBlur={handleClose}
              autoFocus
            />
          </Portal>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <TextInput
              variant="unstyled"
              classNames={{ input: 'uppercase font-bold text-[11px]' }}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="Type your tag"
              onKeyDown={getHotkeyHandler([['Enter', handleSubmit]])}
              onBlur={handleClose}
              autoFocus
            />
          </form>
        )}
      </Group>
    </Badge>
  );
}

type VotableTagAddProps = {
  addTag: (tag: string) => void;
  excludeTags?: string[];
  autosuggest?: boolean;
};
