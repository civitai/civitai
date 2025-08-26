import React from 'react';
import { ActionIcon, Badge, Tooltip } from '@mantine/core';
import { IconAdjustments } from '@tabler/icons-react';
import useAdLayerStore from './hooks/useAdLayerStore';

export const AdControlButton: React.FC = () => {
  const { togglePanel, blocks } = useAdLayerStore();

  return (
    <Tooltip label="Manage Ad Layout" position="left">
      <ActionIcon
        className="fixed bottom-4 right-4 z-[9998] shadow-lg"
        size="xl"
        radius="xl"
        variant="filled"
        color="blue"
        onClick={togglePanel}
      >
        <div className="relative">
          <IconAdjustments size={24} />
          {blocks.length > 0 && (
            <Badge
              size="xs"
              color="red"
              className="absolute -right-2 -top-2"
              circle
            >
              {blocks.length}
            </Badge>
          )}
        </div>
      </ActionIcon>
    </Tooltip>
  );
};