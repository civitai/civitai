import { Badge, Text, TextInput } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { NextLink } from '~/components/NextLink/NextLink';
import type { AccountSection } from '~/components/Account/account-sections';
import {
  accountSectionGroups,
  accountSections,
  getAccountSectionHref,
  resolveLegacyAnchor,
  searchAccountSections,
} from '~/components/Account/account-sections';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';

function useLegacyAnchorRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;

    const redirect = () => {
      const section = resolveLegacyAnchor(window.location.hash);
      if (!section) return;
      // Read the query off the URL rather than `router.query`: that one carries the route's own
      // `section` param and goes stale inside this closure.
      const query = Object.fromEntries(new URLSearchParams(window.location.search).entries());
      router.replace({ pathname: getAccountSectionHref(section), query });
    };

    redirect();
    // A link to `/user/account#creator-score` from a page already on `/user/account` changes only
    // the fragment, so the browser navigates within the same document and nothing remounts. Mount
    // alone would leave those in-app anchors dead while the same URL worked on a cold load.
    window.addEventListener('hashchange', redirect);
    return () => window.removeEventListener('hashchange', redirect);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);
}

/**
 * The subnav is `sticky top-0` inside the scroll area and hides by translating itself off screen,
 * so it keeps its layout box either way. A fixed sticky offset for the rail therefore leaves a gap
 * the height of the subnav once it retracts. Track where its bottom edge actually is instead.
 */
function useStickyTop() {
  const [top, setTop] = useState(0);
  const frame = useRef<number>();

  const measure = useCallback((node: HTMLElement) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const subnav = node.querySelector<HTMLElement>('[data-subnav]');
      if (!subnav) return setTop(0);
      const offset = subnav.getBoundingClientRect().bottom - node.getBoundingClientRect().top;
      setTop(Math.max(0, Math.round(offset)));
    });
  }, []);

  const ref = useScrollAreaRef({ onScroll: measure });

  useEffect(() => {
    if (ref?.current) measure(ref.current);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [ref, measure]);

  return top;
}

function SectionLink({ section, active }: { section: AccountSection; active: boolean }) {
  const Icon = section.icon;
  return (
    <NextLink
      href={getAccountSectionHref(section)}
      className={clsx(
        'flex items-center gap-2.5 rounded px-3 py-2 text-sm no-underline transition-colors',
        active
          ? 'bg-blue-1 font-semibold text-dark-9 dark:bg-blue-8/25 dark:text-white'
          : 'font-medium text-dark-7 hover:bg-gray-1 dark:text-gray-4 dark:hover:bg-dark-5'
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon size={18} className={active ? 'text-blue-6' : 'text-gray-6 dark:text-dark-2'} />
      <span className="flex-1">{section.label}</span>
    </NextLink>
  );
}

function AccountNav({ activeId }: { activeId: string }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchAccountSections(query), [query]);

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Account settings">
      <TextInput
        size="sm"
        placeholder="Find a setting"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        leftSection={<IconSearch size={15} />}
        mb={4}
      />
      {matches.length === 0 && (
        <Text size="sm" c="dimmed" px="sm" py="xs">
          Nothing matches “{query}”.
        </Text>
      )}
      {accountSectionGroups.map((group) => {
        const sections = matches.filter((section) => section.group === group.id);
        if (!sections.length) return null;
        return (
          <React.Fragment key={group.id}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" pt="sm" pb={4}>
              {group.label}
            </Text>
            {sections.map((section) => (
              <SectionLink key={section.id} section={section} active={section.id === activeId} />
            ))}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function MobileIndex() {
  const currentUser = useCurrentUser();
  const { data: buzz } = useQueryBuzz();
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchAccountSections(query), [query]);

  return (
    <div className="flex flex-col gap-4">
      {currentUser && (
        <NextLink
          href={`/user/${currentUser.username}`}
          className="flex items-center gap-3 rounded-md border border-gray-3 bg-white p-3 no-underline dark:border-dark-4 dark:bg-dark-6"
        >
          <UserAvatar user={currentUser} size="md" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <Text size="sm" fw={700}>
                {currentUser.username}
              </Text>
              <Badge size="xs" color={currentUser.tier ? 'yellow' : 'gray'} tt="capitalize">
                {currentUser.tier ?? 'Free'}
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <CurrencyIcon currency="BUZZ" size={12} />
              <Text size="xs" c="dimmed">
                {(buzz?.total ?? 0).toLocaleString()} Buzz
              </Text>
            </div>
          </div>
          <IconChevronRight size={16} className="text-gray-6 dark:text-dark-2" />
        </NextLink>
      )}

      <TextInput
        placeholder="Find a setting"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        leftSection={<IconSearch size={15} />}
      />

      {matches.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing matches “{query}”.
        </Text>
      )}

      {accountSectionGroups.map((group) => {
        const sections = matches.filter(
          (section) => section.group === group.id && section.path !== ''
        );
        if (!sections.length) return null;
        return (
          <div key={group.id} className="flex flex-col gap-1.5">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              {group.label}
            </Text>
            <div className="overflow-hidden rounded-md border border-gray-3 dark:border-dark-4">
              {sections.map((section, index) => {
                const Icon = section.icon;
                return (
                  <NextLink
                    key={section.id}
                    href={getAccountSectionHref(section)}
                    className={clsx(
                      'flex items-center gap-3 bg-white px-3.5 py-3 text-sm font-medium text-dark-9 no-underline dark:bg-dark-6 dark:text-gray-0',
                      index > 0 && 'border-t border-gray-3 dark:border-dark-4'
                    )}
                  >
                    <Icon size={18} className="text-gray-6 dark:text-dark-2" />
                    <span className="flex-1">{section.label}</span>
                    <IconChevronRight size={16} className="text-gray-6 dark:text-dark-2" />
                  </NextLink>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AccountLayout({
  section,
  title,
  children,
}: {
  section: AccountSection;
  title: string;
  children: React.ReactNode;
}) {
  useLegacyAnchorRedirect();
  const stickyTop = useStickyTop();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const isIndex = !section.path;

  if (isMobile) {
    return (
      <div className="mx-auto flex w-full max-w-[1020px] flex-col px-4 py-4">
        {isIndex ? (
          <>
            <Text component="h1" className="mb-4 text-xl font-bold">
              Manage account
            </Text>
            <MobileIndex />
          </>
        ) : (
          <>
            <NextLink
              href="/user/account"
              className="mb-2 inline-flex items-center gap-1 text-sm text-blue-6 no-underline"
            >
              <IconChevronLeft size={16} />
              Manage account
            </NextLink>
            <Text component="h1" className="mb-4 text-xl font-bold">
              {title}
            </Text>
            <div className="flex flex-col gap-4">{children}</div>
          </>
        )}
      </div>
    );
  }

  // 260 rail + 40 gap + 720 content. Past ~720 a row's control drifts far enough from its label
  // that the pair stops reading as one thing — the same problem that killed the two-column layout.
  return (
    <div className="mx-auto flex w-full max-w-[1020px] gap-10 px-4 py-6 md:px-8">
      <aside className="w-[260px] shrink-0">
        <div className="sticky" style={{ top: stickyTop }}>
          <AccountNav activeId={section.id} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <Text component="h1" className="mb-5 text-2xl font-bold leading-tight">
          {title}
        </Text>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}
