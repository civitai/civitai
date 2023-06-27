import { Button, Group, Text, Tooltip } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { useGenerationStore } from '~/store/generation.store';

export function GenerateButton({ iconOnly }: Props) {
  const toggleGenerationDrawer = useGenerationStore((state) => state.toggleDrawer);

  const button = (
    <Button
      variant="filled"
      sx={iconOnly ? { paddingRight: 0, paddingLeft: 0, width: 36 } : { flex: 1 }}
      // TODO.briant: Send generation data to the drawer
      onClick={toggleGenerationDrawer}
    >
      {iconOnly ? (
        <IconBrush size={24} />
      ) : (
        <Group spacing={8} noWrap>
          <IconBrush size={20} />
          <Text inherit inline>
            Create
          </Text>
        </Group>
      )}
    </Button>
  );

  return iconOnly ? (
    <Tooltip label="Start Generating" withArrow>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
type Props = { iconOnly?: boolean };
