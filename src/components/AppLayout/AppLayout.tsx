import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';
import { NotFound } from '~/components/AppLayout/NotFound';
import { SubNav2 } from '~/components/AppLayout/SubNav';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { Announcements } from '~/components/Announcements/Announcements';
import { ScrollAreaProps } from '~/components/ScrollArea/ScrollArea';
import { AdhesiveAd } from '~/components/Ads/AdhesiveAd';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
  announcements,
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
  announcements?: boolean;
}) {
  return (
    <div className="flex h-full flex-1 flex-col">
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      {loading ? (
        <PageLoader />
      ) : notFound ? (
        <NotFound />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {left}
          <MainContent
            subNav={subNav}
            scrollable={scrollable}
            footer={footer}
            announcements={announcements}
          >
            {children}
          </MainContent>
          {right && (
            <aside className="scroll-area relative border-l border-gray-3 dark:border-dark-4">
              {right}
            </aside>
          )}
        </div>
      )}
      <AdhesiveFooter />
    </div>
  );
}

function AdhesiveFooter() {
  const currentUser = useCurrentUser();
  const router = useRouter();

  if (currentUser?.isPaidMember || router.asPath.includes('/moderator')) return null;
  return <AdhesiveAd />;
}

export function MainContent({
  children,
  subNav = <SubNav2 />,
  footer = <AppFooter />,
  scrollable = true,
  announcements,
  ...props
}: {
  children: React.ReactNode;
  subNav?: React.ReactNode | null;
  scrollable?: boolean;
  footer?: React.ReactNode | null;
  announcements?: boolean;
} & ScrollAreaProps) {
  return scrollable ? (
    <ScrollArea {...props}>
      <main className="flex-1">
        {subNav && <SubNav>{subNav}</SubNav>}
        {announcements && <Announcements />}
        {children}
      </main>
      {footer}
    </ScrollArea>
  ) : (
    <div className="no-scroll group flex flex-1 flex-col overflow-hidden">
      <main className="flex flex-1 flex-col overflow-hidden">
        {subNav && <SubNav>{subNav}</SubNav>}
        {children}
      </main>
      {footer}
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
