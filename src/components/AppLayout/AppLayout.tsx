import { AppShell, useMantineTheme } from '@mantine/core';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';

export function AppLayout({ children, showNavbar }: Props) {
  const { colorScheme } = useMantineTheme();
  return (
    <>
      <AppShell
        padding="md"
        header={<AppHeader />}
        footer={<AppFooter />}
        className={`theme-${colorScheme}`}
        navbar={showNavbar ? <SideNavigation /> : undefined}
        styles={{
          main: {
            paddingLeft: 0,
            paddingRight: 0,
            paddingBottom: 61,
            overflowX: 'hidden',
          },
        }}
      >
        {children}
      </AppShell>
    </>
  );
}

type Props = {
  children: React.ReactNode;
  showNavbar?: boolean;
};
