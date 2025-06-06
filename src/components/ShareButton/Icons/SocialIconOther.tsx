import { Center, useMantineTheme } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';

export function SocialIconOther() {
  const theme = useMantineTheme();
  const { background } = theme.variantColorResolver({ color: 'gray', variant: 'filled', theme });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      <IconDots />
    </Center>
  );
}
