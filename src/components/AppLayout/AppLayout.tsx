import { ScrollAreaProps } from '@mantine/core';
import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { useGetAnnouncements } from '~/components/Announcements/AnnouncementsProvider';
import { Announcement } from '~/components/Announcements/Announcement';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { SubNav2 } from '~/components/AppLayout/SubNav';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useRouter } from 'next/router';

export function AppLayout({
  children,
  renderSearchComponent,
  subNav = <SubNav2 />,
  left,
  right,
  scrollable = true,
  footer = <AppFooter />,
  loading,
  notFound,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
  subNav?: React.ReactNode | null;
  left?: React.ReactNode;
  right?: React.ReactNode;

  scrollable?: boolean;
  footer?: React.ReactNode | null;
  loading?: boolean;
  notFound?: boolean;
}) {
  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      {loading ? (
        <PageLoader />
      ) : notFound ? (
        <NotFound />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {left && (
            <aside className="scroll-area relative border-r border-gray-3 dark:border-dark-4">
              {left}
            </aside>
          )}
          <MainContent subNav={subNav} scrollable={scrollable} footer={footer}>
            {children}
          </MainContent>
          {right && (
            <aside className="scroll-area relative border-l border-gray-3 dark:border-dark-4">
              {right}
            </aside>
          )}
        </div>
      )}
    </>
  );
}

export function MainContent({
  children,
  subNav = <SubNav2 />,
  footer = <AppFooter />,
  scrollable = true,
  ...props
}: {
  children: React.ReactNode;
  subNav?: React.ReactNode | null;
  scrollable?: boolean;
  footer?: React.ReactNode | null;
} & ScrollAreaProps) {
  return scrollable ? (
    <ScrollArea {...props}>
      <main className="flex-1">
        {subNav && <SubNav>{subNav}</SubNav>}
        <Announcements />
        {children}
      </main>
      {footer}
    </ScrollArea>
  ) : (
    <div className="flex flex-1 flex-col overflow-hidden">
      <main className="flex flex-1 flex-col overflow-hidden">
        {subNav && <SubNav>{subNav}</SubNav>}
        {children}
      </main>
      {footer}
    </div>
  );
}

function Announcements() {
  const router = useRouter();
  const { data } = useGetAnnouncements();
  if (!data.length || router.asPath.startsWith('/user/notifications')) return null;
  return (
    <div className="mb-3 ">
      <div className="container">
        <Announcement announcement={data[0]} />
      </div>
    </div>
  );
}

export function SubNav({
  children,
  className,
  visible,
  ...props
}: { children: React.ReactNode; visible?: boolean } & React.HTMLProps<HTMLDivElement>) {
  const lastScrollRef = useRef(0);
  const lastDirectionChangeRef = useRef(0);
  const lastScrollDirectionRef = useRef('up');
  const [showNav, setShowNav] = useState(true);
  useScrollAreaRef({
    onScroll: (node) => {
      const diff = node.scrollTop - lastScrollRef.current;
      const scrollDirection = diff > 0 ? 'down' : 'up';
      const lastScrollDirection = lastScrollDirectionRef.current;
      if (scrollDirection !== lastScrollDirection) {
        lastScrollDirectionRef.current = scrollDirection;
        lastDirectionChangeRef.current = node.scrollTop;
      }

      const lastDirectionChangeDiff = node.scrollTop - lastDirectionChangeRef.current;

      if (node.scrollTop < 100) setShowNav(true);
      else if (lastDirectionChangeDiff > 100) setShowNav(false);
      else if (lastDirectionChangeDiff < -100) setShowNav(true);

      lastScrollRef.current = node.scrollTop;
    },
  });

  useEffect(() => {
    if (visible) setShowNav(true);
  }, [visible]);

  return (
    <div
      {...props}
      className={clsx(
        'sticky inset-x-0 top-0 z-50 mb-3 bg-gray-1 shadow transition-transform dark:bg-dark-6',
        className
      )}
      style={!showNav ? { transform: 'translateY(-200%)' } : undefined}
    >
      {children}
    </div>
  );
}
