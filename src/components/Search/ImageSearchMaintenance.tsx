import { Center, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconPhotoOff } from '@tabler/icons-react';

export const IMAGE_SEARCH_MAINTENANCE_MESSAGE =
  'Image search has been temporarily disabled for maintenance.';

export function ImageSearchMaintenanceNotice() {
  return (
    <Center>
      <Stack gap="md" align="center" maw={800}>
        <ThemeIcon size={128} radius={100} className="opacity-50">
          <IconPhotoOff size={80} />
        </ThemeIcon>
        <Title order={1} lh={1} ta="center">
          Image search unavailable
        </Title>
        <Text align="center">{IMAGE_SEARCH_MAINTENANCE_MESSAGE}</Text>
      </Stack>
    </Center>
  );
}
