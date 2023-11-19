import { createStyles, useMantineTheme } from '@mantine/core';

import React, { ComponentType, cloneElement } from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type AppLayoutProps = {
  innerLayout?: (page: React.ReactNode) => React.ReactElement;
};

export function AppLayout({
  children,
  innerLayout,
}: { children: React.ReactNode } & AppLayoutProps) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;

  // TODO - return banned

  return (
    <div className={cx(`theme-${theme.colorScheme}`, classes.root)}>
      <AppHeader fixed={false} />
      <main className={classes.main}>{innerLayout ? innerLayout(children) : children}</main>
      <AppFooter fixed={false} />
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
}));

export function setPageOptions(Component: () => JSX.Element, options?: AppLayoutProps) {
  (Component as any).getLayout = (page: React.ReactElement) => (
    <AppLayout {...options}>{page}</AppLayout>
  );
  (Component as any).options = options;
}
