import { Button, Group, Popover, PopoverProps, Stack } from '@mantine/core';
import React, { useState } from 'react';

export function PopConfirm({
  children,
  message = 'Are you sure?',
  onConfirm,
  onCancel,
  ...popoverProps
}: {
  children: React.ReactElement;
  message: React.ReactNode;
  onConfirm?: () => void;
  onCancel?: () => void;
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

  return (
    <Popover {...popoverProps} opened={opened} onChange={setOpened}>
      <Popover.Target>
        {React.cloneElement(children, { onClick: () => setOpened((o) => !o) })}
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          {message}
          <Group position="right">
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
