import { Stack, Text } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons';

export function SensitiveContent({ showMessage = true }: { showMessage?: boolean }) {
  return (
    <Stack align="center" spacing={0}>
      <IconEyeOff size={20} color="white" />
      <Text color="white">Sensitive Content</Text>
      {showMessage && (
        <Text size="xs" color="white" align="center">
          This is marked as NSFW
        </Text>
      )}
    </Stack>
  );
}
