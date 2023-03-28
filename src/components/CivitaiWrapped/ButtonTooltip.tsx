import { Box, Tooltip, TooltipProps } from '@mantine/core';

export function ButtonTooltip({ children, ...props }: TooltipProps) {
  return (
    <Tooltip {...props}>
      <Box>{children}</Box>
    </Tooltip>
  );
}
