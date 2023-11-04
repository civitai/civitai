import { Button, ButtonProps, Group, Text, Tooltip } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel } from '~/store/generation.store';

export function GenerateButton({ iconOnly, modelVersionId, ...buttonProps }: Props) {
  const button = (
    <Button
      variant="filled"
      sx={iconOnly ? { paddingRight: 0, paddingLeft: 0, width: 36 } : { flex: 1 }}
      onClick={() =>
        modelVersionId
          ? generationPanel.open({ type: 'modelVersion', id: modelVersionId })
          : generationPanel.open()
      }
      {...buttonProps}
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
type Props = Omit<ButtonProps, 'onClick'> & { iconOnly?: boolean; modelVersionId?: number };
