import { AppShell } from '@mantine/core';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';

export function AppLayout({ children, showNavbar }: Props) {
  return (
    <AppShell
      padding="md"
      header={
        <AppHeader
          links={
            [
              // { label: 'Models', url: '#' },
              // { label: 'Link 2', url: '#' },
            ]
          }
        />
      }
      navbar={showNavbar ? <SideNavigation /> : undefined}
    >
      {children}
      <AppFooter />
    </AppShell>
  );
}

type Props = {
  children: React.ReactNode;
  showNavbar?: boolean;
};
