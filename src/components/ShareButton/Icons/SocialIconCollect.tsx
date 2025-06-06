import { IconBookmark } from '@tabler/icons-react';
import { Center, useMantineTheme } from '@mantine/core';

export function SocialIconCollect() {
  const theme = useMantineTheme();
  const { background } = theme.variantColorResolver({ color: 'gray', variant: 'filled', theme });

  return (
    <Center style={{ height: '100%', width: '100%', background, borderRadius: '100%' }}>
      <IconBookmark />
    </Center>
  );
}
