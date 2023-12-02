import { Box, createStyles, useMantineTheme } from '@mantine/core';
import React from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';

export function BaseLayout({ children }: { children: React.ReactNode }) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  return (
    <ContainerProvider
      className={cx(`theme-${theme.colorScheme}`, classes.root)}
      id="root"
      containerName="root"
      supportsContainerQuery={false}
    >
      {children}
    </ContainerProvider>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
}));
