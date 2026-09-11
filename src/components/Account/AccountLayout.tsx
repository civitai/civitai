import type { MantineSize } from '@mantine/core';
import { Badge, CloseButton, Text, TextInput } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';

import { NextLink } from '~/components/NextLink/NextLink';
import type { AccountSection } from '~/components/Account/account-sections';
import {
  accountSectionGroups,
  getAccountSectionHref,
  getOverviewHref,
  resolveLegacyAnchor,
  searchAccountSections,
} from '~/components/Account/account-sections';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useSubnavBottom } from '~/hooks/useSubnavBottom';
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

const RAIL_STICKY_GAP = 16;


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

function SettingSearchInput({
  value,
  onChange,
  size,
  mb,
}: {
  value: string;
  onChange: (value: string) => void;
  size?: MantineSize;
  mb?: number;
}) {
  return (
    <TextInput
      size={size}
      placeholder="Find a setting"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onChange('');
      }}
      leftSection={<IconSearch size={15} />}
      rightSection={
        value ? (
          <CloseButton
            size="sm"
            variant="transparent"
            aria-label="Clear search"
            onClick={() => onChange('')}
          />
        ) : null
      }
      mb={mb}
    />
  );
}

function AccountNav({ activeId }: { activeId: string }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchAccountSections(query), [query]);

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Account settings">
      <SettingSearchInput size="sm" value={query} onChange={setQuery} mb={4} />
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
  const availableBuzzTypes = useAvailableBuzz(['blue']);
  const { data: buzz } = useQueryBuzz(availableBuzzTypes);
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchAccountSections(query), [query]);

  return (
    <div className="flex flex-col gap-4">
      {currentUser && (
        <NextLink
          href={getOverviewHref()}
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

      <SettingSearchInput value={query} onChange={setQuery} />

      {matches.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing matches “{query}”.
        </Text>
      )}

      {accountSectionGroups.map((group) => {
        const sections = matches.filter((section) => section.group === group.id);
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
                    href={section.path ? getAccountSectionHref(section) : getOverviewHref()}
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
  isIndex,
  children,
}: {
  section: AccountSection;
  title: string;
  /** Whether the URL is the bare index, not whether the section happens to live there. */
  isIndex: boolean;
  children: React.ReactNode;
}) {
  useLegacyAnchorRedirect();
  const subnavBottom = useSubnavBottom();
  const isMobile = useIsMobile({ breakpoint: 'md' });

  if (isMobile) {
    if (isIndex)
      return (
        <div className="mx-auto flex w-full max-w-[1020px] flex-col p-4">
          <Text component="h1" className="mb-4 text-xl font-bold">
            Manage account
          </Text>
          <MobileIndex />
        </div>
      );

    return (
      // `-mt-3` cancels the subnav's own `mb-3` (see AppLayout). The bar pins flush to the subnav
      // once stuck, so without this it starts 12px lower and jumps up on the first scroll.
      <div className="mx-auto -mt-3 flex w-full max-w-[1020px] flex-col">
        <div
          // Pinned to the same edge the desktop rail tracks, so it follows the subnav up as that
          // retracts rather than leaving a gap or hiding under it.
          className="sticky z-10 flex items-center gap-3 border-b border-gray-3 bg-white px-4 py-3 dark:border-dark-4 dark:bg-dark-6"
          style={{ top: subnavBottom }}
        >
          <NextLink
            href="/user/account"
            aria-label="Manage account"
            className="flex text-dark-9 dark:text-gray-0"
          >
            <IconChevronLeft size={22} />
          </NextLink>
          <Text component="h1" className="text-base font-semibold">
            {title}
          </Text>
        </div>
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </div>
    );
  }

  // 260 rail + 40 gap + 720 content. Past ~720 a row's control drifts far enough from its label
  // that the pair stops reading as one thing — the same problem that killed the two-column layout.
  return (
    <div className="mx-auto flex w-full max-w-[1020px] gap-10 px-4 py-6 md:px-8">
      <aside className="w-[260px] shrink-0">
        <div className="sticky" style={{ top: subnavBottom + RAIL_STICKY_GAP }}>
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
