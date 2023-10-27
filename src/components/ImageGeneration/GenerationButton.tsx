import { Group, Text, Button, ButtonProps } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { useGenerationStore } from '~/store/generation.store';

export function GenerationButton({ ...props }: ButtonProps) {
  const open = useGenerationStore((state) => state.open);

  return (
    <Button {...props} px="xs" onClick={() => open()}>
      <Group spacing="xs">
        <IconBrush size={20} stroke={2.5} />
        <Text inherit>Create</Text>
      </Group>
    </Button>
  );
}
