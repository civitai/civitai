import { AppShell, Center, MantineProvider, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconHourglass } from '@tabler/icons';
import { Meta } from '~/components/Meta/Meta';

export const MaintenanceMode = () => {
  return (
    <>
      <Meta
        title="We'll be right back | Civitai"
        description="We're adjusting a few things, be back in a few minutes..."
      />
      <Center p="xl" sx={{ height: '100vh' }}>
        <Stack align="center">
          <ThemeIcon size={128} radius={100}>
            <IconHourglass size={80} />
          </ThemeIcon>
          <Text align="center" size="xl" weight={500}>
            {`We're adjusting a few things, be back in a few minutes...`}
          </Text>
        </Stack>
      </Center>
    </>
  );
};
