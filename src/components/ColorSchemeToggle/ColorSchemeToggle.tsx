import { ActionIcon, Group, useMantineColorScheme } from '@mantine/core';
import { IconMoonStars, IconSun } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ColorSchemeToggle() {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  return (
    <Group justify="center">
      <LegacyActionIcon
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
      </LegacyActionIcon>
    </Group>
  );
}
