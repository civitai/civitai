import { Group, Text } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { FloatingActionButton } from '~/components/FloatingActionButton/FloatingActionButton';
import {
  generationPanel,
  useGenerationPanelControls,
} from '~/components/ImageGeneration/GenerationPanel';

export function FloatingGenerationButton() {
  const opened = useGenerationPanelControls((state) => state.opened);

  return (
    <FloatingActionButton
      transition="pop"
      onClick={() => generationPanel.open()}
      mounted={!opened}
      px="xs"
    >
      <Group spacing="xs">
        <IconBrush size={20} stroke={2.5} />
        <Text inherit>Create</Text>
      </Group>
    </FloatingActionButton>
  );
}
