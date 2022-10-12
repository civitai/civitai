import { AppShell } from '@mantine/core';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';

export function AppLayout({ children, showNavbar }: Props) {
  return (
    <AppShell
      padding="md"
      header={<AppHeader />}
      navbar={showNavbar ? <SideNavigation /> : undefined}
    >
      {children}
    </AppShell>
  );
}

type Props = {
  children: React.ReactNode;
  showNavbar?: boolean;
};
