import clsx from 'clsx';
import React, { useRef, useState } from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { SubNav2 } from '~/components/AppLayout/SubNav';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

export function AppLayout({
  children,
  renderSearchComponent,
  subNav = <SubNav2 />,
  left,
  right,
}: // scrollable = true
{
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
  subNav?: React.ReactNode | null;
  left?: React.ReactNode;
  right?: React.ReactNode;
  // scrollable?: boolean;
}) {
  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <div className="flex flex-1 overflow-hidden">
        {left && <aside className="relative h-full">{left}</aside>}
        <ScrollArea>
          <main>
            {subNav && <SubNav>{subNav}</SubNav>}
            {children}
          </main>
          <AppFooter />
        </ScrollArea>
        {right && <aside className="relative h-full">{right}</aside>}
      </div>
    </>
  );
}

function SubNav({
  children,
  className,
  ...props
}: { children: React.ReactNode } & React.HTMLProps<HTMLDivElement>) {
  const lastScrollRef = useRef(0);
  // const upScrollRef = useRef(0);
  // const downScrollRef = useRef(0);
  const scrollRef = useScrollAreaRef({
    onScroll: (node) => {
      const showNav = getShouldShowSubNav(node, lastScrollRef.current);
      // if(node.scrollTop > lastScrollRef.current) downScrollRef.current = node.scrollTop;
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
