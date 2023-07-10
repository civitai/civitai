import { Group, Text, Anchor, Badge } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';

export function ActionsWrapper({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Group
        px={15}
        py="xs"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
        spacing="xs"
      >
        <Badge color="yellow" variant="light" size="xs">
          Beta
        </Badge>
        <Text size="xs" color="dimmed">
          Expect frequent changes.
        </Text>
        <Anchor
          size="xs"
          component={NextLink}
          onClick={() => closeSpotlight()}
          href="/user/account#settings"
          ml="auto"
        >
          Opt-out
        </Anchor>
      </Group>
      {children}
    </>
  );
}
