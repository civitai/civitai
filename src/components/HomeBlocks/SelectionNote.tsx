import { Text } from '@mantine/core';

export function SelectionNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <div className="mt-2 border-t border-gray-4 pt-2 dark:border-dark-4">
      <Text size="xs" fw={600} c="dimmed">
        How this is chosen
      </Text>
      <Text size="xs" c="dimmed">
        {note}
      </Text>
    </div>
  );
}
