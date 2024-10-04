import clsx from 'clsx';
import React, { useRef, useState } from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { SubNav2 } from '~/components/AppLayout/SubNav';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

type AppLayoutProps = {
  innerLayout?: ({ children }: { children: React.ReactNode }) => React.ReactNode;
  withScrollArea?: boolean;
};

export function AppLayout({
  children,
  renderSearchComponent,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
}) {
  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <Main>{children}</Main>
    </>
  );
}

export function setPageOptions(Component: (...args: any) => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}

// function Main({
//   children,
//   left,
//   right,
//   subNav = <SubNav2 />,
// }: {
//   children: React.ReactNode;
//   left?: React.ReactNode;
//   right?: React.ReactNode;
//   subNav?: React.ReactNode;
// }) {
//   const main = (
//     <ScrollArea>
//       <main>
//         {subNav && <SubNav>{subNav}</SubNav>}
//         {children}
//       </main>
//       <AppFooter />
//     </ScrollArea>
//   );

//   if (left || right) {
//     return (
//       <div className="flex flex-1">
//         {left && <aside className="relative h-full">{left}</aside>}
//         {main}
//         {right && <aside className="relative h-full">{right}</aside>}
//       </div>
//     );
//   }

//   return main;
// }

function Main({
  children,
  subNav = <SubNav2 />,
}: {
  children: React.ReactNode;
  subNav?: React.ReactNode;
}) {
  return (
    <ScrollArea>
      <main>
        {subNav && <SubNav>{subNav}</SubNav>}
        {children}
      </main>
      <AppFooter />
    </ScrollArea>
  );
}

function SubNav({
  children,
  className,
  ...props
}: { children: React.ReactNode } & React.HTMLProps<HTMLDivElement>) {
  const lastScrollRef = useRef(0);
  const scrollRef = useScrollAreaRef({
    onScroll: (node) => {
      const showNav = getShouldShowSubNav(node, lastScrollRef.current);
      setShowNav(showNav);
      lastScrollRef.current = node.scrollTop;
    },
  });
  const [showNav, setShowNav] = useState(
    scrollRef?.current ? getShouldShowSubNav(scrollRef.current, lastScrollRef.current) : true
  );

  return (
    <div
      {...props}
      className={clsx(
        'sticky inset-x-0 top-0 z-50 bg-gray-1 shadow transition-transform dark:bg-dark-6',
        className
      )}
      style={!showNav ? { transform: 'translateY(-200%)' } : undefined}
    >
      {children}
    </div>
  );
}

function getShouldShowSubNav(node: HTMLElement, lastScrollTop: number) {
  if (node.scrollTop === 0) return true;
  if (node.scrollTop > lastScrollTop) {
    return false;
  }
  if (node.scrollTop <= lastScrollTop) {
    return true;
  }
}

/*
function UserProfileLayout() {
  return (
    <Main left={<ProfileSidebar username={username} />}>
      {children}
    </Main>
  )
}

innerLayout: <
*/
