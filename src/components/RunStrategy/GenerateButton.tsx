import { Button, ButtonProps, Group, Text, Tooltip } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerateButton({
  iconOnly,
  modelVersionId,
  mode = 'replace',
  ...buttonProps
}: Props) {
  const opened = useGenerationStore((state) => state.opened);

  const button = (
    <Button
      variant="filled"
      sx={iconOnly ? { paddingRight: 0, paddingLeft: 0, width: 36 } : { flex: 1 }}
      onClick={() => {
        if (mode === 'toggle' && opened) return generationPanel.close();

        modelVersionId
          ? generationPanel.open({ type: 'modelVersion', id: modelVersionId })
          : generationPanel.open();
      }}
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
type Props = Omit<ButtonProps, 'onClick'> & {
  iconOnly?: boolean;
  modelVersionId?: number;
  mode?: 'toggle' | 'replace';
};
