import { AppShell } from '@mantine/core';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';

export function AppLayout({ children, showNavbar }: Props) {
  return (
    <>
      <AppShell
        padding="md"
        header={<AppHeader />}
        footer={<AppFooter />}
        navbar={showNavbar ? <SideNavigation /> : undefined}
        styles={{
          main: {
            paddingLeft: 0,
            paddingRight: 0,
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
