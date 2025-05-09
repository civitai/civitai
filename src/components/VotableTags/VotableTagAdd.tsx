import { Autocomplete, Badge, createStyles, Group, TextInput } from '@mantine/core';
import { getHotkeyHandler, useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function VotableTagAdd({ addTag, autosuggest }: VotableTagAddProps) {
  // Autocomplete logic
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [adding, { open, close }] = useDisclosure(false);

  // Style
  const { classes } = useStyles();

  const { data, isFetching } = trpc.tag.getAll.useQuery(
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

  return (
    <Badge radius="xs" className={classes.badge} px={5} onClick={!adding ? open : undefined}>
      <Group gap={4}>
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : autosuggest ? (
          <Autocomplete
            variant="unstyled"
            classNames={{ dropdown: classes.dropdown, input: classes.input }}
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
            onItemSubmit={(item) => {
              addTag(item.value);
              handleClose();
            }}
            onBlur={handleClose}
            withinPortal
            autoFocus
          />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <TextInput
              variant="unstyled"
              classNames={{ input: classes.input }}
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

const useStyles = createStyles((theme) => {
  const badgeColor = theme.fn.variant({ color: 'blue', variant: 'light' });
  const badgeBorder = theme.fn.lighten(badgeColor.background ?? theme.colors.gray[4], 0.05);
  return {
    badge: {
      cursor: 'pointer',
      backgroundColor: badgeColor.background,
      borderColor: badgeBorder,
      color: badgeColor.color,
    },
    inner: {
      display: 'flex',
    },
    createOption: {
      fontSize: theme.fontSizes.sm,
      padding: theme.spacing.xs,
      borderRadius: theme.radius.sm,

      '&:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
      },
    },
    input: {
      textTransform: 'uppercase',
      fontWeight: 'bold',
      fontSize: 11,
    },
    dropdown: {
      maxWidth: '300px !important',
    },
  };
});
