import { Autocomplete, Badge, createStyles, Group } from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { TagTarget } from '@prisma/client';
import { IconPlus } from '@tabler/icons';
import { useState } from 'react';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function VotableTagAdd({ addTag }: VotableTagAddProps) {
  // Autocomplete logic
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [adding, { open, close }] = useDisclosure(false);
  const { data, isFetching } = trpc.tag.getAll.useQuery(
    {
      limit: 10,
      entityType: [TagTarget.Image],
      types: ['UserGenerated', 'Label'],
      query: debouncedSearch.trim().toLowerCase(),
    },
    {
      enabled: debouncedSearch.trim().length > 0,
    }
  );

  // Style
  const { classes } = useStyles();

  return (
    <Badge radius="xs" className={classes.badge} px={5} onClick={!adding ? open : undefined}>
      <Group spacing={4}>
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : (
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
            nothingFound={isFetching ? 'Searching...' : 'Nothing found'}
            placeholder="Type to search..."
            onItemSubmit={(item) => {
              addTag(item.value);
              setSearch('');
            }}
            onBlur={() => {
              close();
              setSearch('');
            }}
            withinPortal
            autoFocus
          />
        )}
      </Group>
    </Badge>
  );
}

type VotableTagAddProps = {
  addTag: (tag: string) => void;
  excludeTags?: string[];
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
