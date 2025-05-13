import { ActionIcon, Group, useComputedColorScheme } from '@mantine/core';
import { IconMoonStars, IconSun } from '@tabler/icons-react';

export function ColorSchemeToggle() {
  const { colorScheme, toggleColorScheme } = useComputedColorScheme();

  return (
    <Group justify="center">
      <ActionIcon
        onClick={() => toggleColorScheme()}
        size="lg"
        variant="outline"
        color={colorScheme === 'dark' ? 'yellow' : 'blue'}
      >
        {colorScheme === 'dark' ? (
          <IconSun size={20} stroke={1.5} />
        ) : (
          <IconMoonStars size={20} stroke={1.5} />
        )}
      </ActionIcon>
    </Group>
  );
}
