import { Container, createStyles, Stack } from '@mantine/core';
import { AppLayout } from '~/components/AppLayout/AppLayout';

const SIDEBAR_SIZE = 320;

const useStyles = createStyles((theme, _, getRef) => {
  const sidebarRef = getRef('sidebar');
  const contentRef = getRef('content');

  return {
    sidebar: {
      ref: sidebarRef,
      height: 'calc(100vh - 2 * var(--mantine-header-height, 50px))',
      position: 'fixed',
      top: 'var(--mantine-header-height, 50px)',
      width: `${SIDEBAR_SIZE}px`,
      overflowY: 'auto',
      padding: theme.spacing.md,
      transition: 'transform 200ms ease',
      zIndex: 1,
      background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],

      [theme.fn.smallerThan('sm')]: {
        display: 'none',
      },
    },

    content: {
      ref: contentRef,
      width: '100%',
      paddingLeft: `${SIDEBAR_SIZE}px`,

      [theme.fn.smallerThan('sm')]: {
        paddingLeft: '0',
      },
    },
  };
});

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  return <AppLayout>{children}</AppLayout>;
}

SidebarLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  return (
    <Container fluid p={0}>
      {children}
    </Container>
  );
};

SidebarLayout.Sidebar = function Sidebar({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();

  return <Stack className={classes.sidebar}>{children}</Stack>;
};

SidebarLayout.Content = function Content({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();
  return <Stack className={classes.content}>{children}</Stack>;
};
