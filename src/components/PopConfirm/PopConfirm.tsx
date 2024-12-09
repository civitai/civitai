import { Button, Group, Popover, PopoverProps, Stack } from '@mantine/core';
import React, { useState } from 'react';

export function PopConfirm({
  children,
  enabled = true,
  message = 'Are you sure?',
  onConfirm,
  onCancel,
  ...popoverProps
}: {
  children: React.ReactElement;
  message?: React.ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
  enabled?: boolean;
} & Omit<PopoverProps, 'opened' | 'onChange'>) {
  const [opened, setOpened] = useState(false);

  const handleCancel = () => {
    onCancel?.();
    setOpened(false);
  };

  const handleConfirm = () => {
    onConfirm?.();
    setOpened(false);
  };

  if (!enabled) return children;

  return (
    <Popover {...popoverProps} opened={opened} onChange={setOpened}>
      <Popover.Target>
        {React.cloneElement(children, { onClick: () => setOpened((o) => !o) })}
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          {message}
          <Group spacing={8} position="right">
            <Button variant="outline" compact onClick={handleCancel}>
              No
            </Button>
            <Button compact onClick={handleConfirm}>
              Yes
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
