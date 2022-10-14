import { ActionIcon, Group, useMantineColorScheme } from '@mantine/core';
import { IconMoonStars, IconSun } from '@tabler/icons';

export function ColorSchemeToggle() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <Group position="center">
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
