import { Center, useMantineTheme } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';

export function SocialIconChat() {
  const theme = useMantineTheme();
  const { background } = theme.fn.variant({ color: 'gray', variant: 'filled' });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      <IconSend />
    </Center>
  );
}
