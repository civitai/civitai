import { Chip, Group, Anchor, Badge, Stack, Text, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';
import { titleCase } from '~/utils/string-helpers';

const filterOptions = ['all', 'models', 'users', 'articles', 'tags'] as const;

const useStyles = createStyles((theme, _, getRef) => {
  const ref = getRef('iconWrapper');

  return {
    label: {
      '&[data-checked]': {
        '&, &:hover': {
          backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
          color: theme.white,
        },

        [`& .${ref}`]: {
          color: theme.white,
        },
      },
    },

    iconWrapper: { ref },
  };
});

export function ActionsWrapper({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();

  return (
    <>
      <Stack
        spacing={8}
        px={15}
        py="xs"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
      >
        <Text size="xs" color="dimmed" inline>
          Filter Results
        </Text>
        <Chip.Group defaultValue="all" spacing="xs">
          {filterOptions.map((option) => (
            <Chip key={option} classNames={classes} value={option} radius="sm">
              {titleCase(option)}
            </Chip>
          ))}
        </Chip.Group>
        <Group spacing="xs">
          <Badge color="yellow" variant="light" size="xs">
            Beta
          </Badge>
          <Text size="xs" color="dimmed" inline>
            Expect frequent changes.
          </Text>
          <Anchor
            size="xs"
            component={NextLink}
            onClick={() => closeSpotlight()}
            href="/user/account#settings"
            ml="auto"
            inline
          >
            Opt-out
          </Anchor>
        </Group>
      </Stack>
      {children}
    </>
  );
}
