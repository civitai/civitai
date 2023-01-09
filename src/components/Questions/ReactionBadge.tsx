import { Button, ButtonProps, Tooltip } from '@mantine/core';
import React from 'react';

export function ReactionBadge({
  color,
  tooltip,
  ...props
}: ButtonProps & { onClick?: React.MouseEventHandler; tooltip?: React.ReactNode }) {
  const button = (
    <Button variant="light" color={color ?? 'gray'} size="xs" radius="lg" {...props} />
  );
  return !tooltip ? (
    button
  ) : (
    <Tooltip label={tooltip} withArrow withinPortal openDelay={200} color="dark">
      {button}
    </Tooltip>
  );
}
