import { IconPlaylistAdd } from '@tabler/icons-react';
import { Center, useMantineTheme } from '@mantine/core';

export function SocialIconCollect() {
  const theme = useMantineTheme();
  const { background } = theme.fn.variant({ color: 'gray', variant: 'filled' });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      <IconPlaylistAdd />
    </Center>
  );
}
