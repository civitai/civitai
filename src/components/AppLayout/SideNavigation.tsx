import { Navbar } from '@mantine/core';

export function SideNavigation({ children }: Props) {
  return (
    <Navbar width={{ base: 300 }} p="sm">
      {children}
    </Navbar>
  );
}

type Props = {
  children?: React.ReactNode;
};
