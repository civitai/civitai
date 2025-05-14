import { Center, useMantineTheme } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';

export function SocialIconChat() {
  const theme = useMantineTheme();
  const { background } = theme.variantColorResolver({ color: 'gray', variant: 'filled', theme });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      <IconSend />
    </Center>
  );
}
