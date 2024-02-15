import { Box, useMantineTheme } from '@mantine/core';
import { Adunit } from '~/components/Ads/AdUnit';

export default function Test() {
  const theme = useMantineTheme();
  return (
    <Box py="xl">
      <Adunit
        py="xl"
        sx={(theme) => ({
          background: theme.colorScheme === 'light' ? theme.colors.gray[2] : undefined,
        })}
        sfw={{
          type: 'ascendeum',
          adunit: 'Leaderboard_A',
          breakpoints: [
            { sizes: ['300x100'] },
            { minWidth: theme.breakpoints.md, sizes: ['728x90'] },
            { minWidth: theme.breakpoints.lg, sizes: ['970x90'] },
          ],
        }}
        nsfw={{
          type: 'exoclick',
          breakpoints: [{ sizes: '300x100' }, { minWidth: theme.breakpoints.md, sizes: '728x90' }],
        }}
      />
    </Box>
  );
}
