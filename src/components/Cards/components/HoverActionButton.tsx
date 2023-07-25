import React from 'react';
import { Box, ThemeIcon, ThemeIconProps } from '@mantine/core';

const HoverActionButton = ({ label, children, themeIconProps, ...props }: Props) => {
  return (
    <Box {...props}>
      <Box>
        <ThemeIcon {...themeIconProps}>{children}</ThemeIcon>
      </Box>
    </Box>
  );
};

type Props = {
  label: string;
  children: React.ReactNode;
  themeIconProps: ThemeIconProps;
};
export default HoverActionButton;
