import { Badge, createStyles, Group, TextInput } from '@mantine/core';
import { getHotkeyHandler, useDisclosure } from '@mantine/hooks';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';

export function VotableTagAdd({ addTag }: VotableTagAddProps) {
  // Autocomplete logic
  const [search, setSearch] = useState('');
  const [adding, { open, close }] = useDisclosure(false);

  // Style
  const { classes } = useStyles();

  return (
    <Badge radius="xs" className={classes.badge} px={5} onClick={!adding ? open : undefined}>
      <Group spacing={4}>
        <IconPlus size={14} strokeWidth={2.5} />
        {!adding ? (
          <span>Tag</span>
        ) : (
          <TextInput
            variant="unstyled"
            classNames={{ input: classes.input }}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Type your tag"
            onKeyDown={getHotkeyHandler([
              [
                'Enter',
                () => {
                  const value = search.trim().toLowerCase();
                  if (value) addTag(value);

                  close();
                  setSearch('');
                },
              ],
            ])}
            onBlur={() => {
              close();
              setSearch('');
            }}
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
