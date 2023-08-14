import { Container, createStyles, Stack } from '@mantine/core';
import { createContext, Dispatch, SetStateAction, useContext, useMemo, useState } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';

const SIDEBAR_SIZE = 377;

// #region [ImageGuardContext]
type SearchLayoutState = {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
};

const SearchLayoutCtx = createContext<SearchLayoutState>({} as any);
export const useSearchLayoutCtx = () => {
  const context = useContext(SearchLayoutCtx);
  if (!context) throw new Error('useSearchLayoutIdx can only be used inside SearchLayoutCtx');
  return context;
};

const useStyles = createStyles((theme, _, getRef) => {
  const sidebarRef = getRef('sidebar');
  const contentRef = getRef('content');

  return {
    sidebar: {
      ref: sidebarRef,
      height: 'calc(100vh - 2 * var(--mantine-header-height, 50px))',
      position: 'fixed',
      left: -SIDEBAR_SIZE,
      top: 'var(--mantine-header-height,50px)',
      width: `${SIDEBAR_SIZE}px`,
      overflowY: 'auto',
      padding: theme.spacing.md,
      transition: 'transform 400ms ease',
    },

    content: {
      ref: contentRef,
      width: '100%',
      paddingLeft: 0,
      transition: 'padding-left 400ms ease',
    },

    sidebarOpen: {
      [`& .${sidebarRef}`]: {
        transform: `translate(${SIDEBAR_SIZE}px, 0)`,
      },
      [`& .${contentRef}`]: {
        paddingLeft: `${SIDEBAR_SIZE}px`,
      },
    },
  };
});

export function SearchLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const ctx = useMemo(() => ({ sidebarOpen, setSidebarOpen }), [sidebarOpen]);

  return (
    <AppLayout>
      <SearchLayoutCtx.Provider value={ctx}>{children}</SearchLayoutCtx.Provider>
    </AppLayout>
  );
}

SearchLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  const { classes, cx } = useStyles();
  const { sidebarOpen } = useSearchLayoutCtx();

  return (
    <Container fluid className={cx({ [classes.sidebarOpen]: sidebarOpen })}>
      {children}
    </Container>
  );
};

SearchLayout.Filters = function Filters({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();
  return <Stack className={classes.sidebar}>{children}</Stack>;
};

SearchLayout.Content = function Content({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();
  return <Stack className={classes.content}>{children}</Stack>;
};

export const useSearchLayoutStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
    columnGap: theme.spacing.md,
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
    marginTop: -theme.spacing.md,

    '& > *': {
      marginTop: theme.spacing.md,
    },
  },
}));
