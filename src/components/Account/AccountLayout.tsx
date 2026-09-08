import { Text, TextInput } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconSearch } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';

import { NextLink } from '~/components/NextLink/NextLink';
import type { AccountSection } from '~/components/Account/account-sections';
import {
  accountSectionGroups,
  accountSections,
  getAccountSectionHref,
  resolveLegacyAnchor,
  searchAccountSections,
} from '~/components/Account/account-sections';

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

function MobileSectionList() {
  return (
    <div className="flex flex-col gap-3 md:hidden">
      {accountSectionGroups.map((group) => {
        const sections = accountSections.filter((section) => section.group === group.id);
        return (
          <div key={group.id} className="flex flex-col">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" pb={6}>
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
  description,
  children,
}: {
  section: AccountSection;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  useLegacyAnchorRedirect();
  const isIndex = !section.path;

  return (
    <div className="mx-auto flex w-full max-w-[1180px] gap-10 px-4 py-6 md:px-8">
      <aside className="hidden w-[260px] shrink-0 md:block">
        <div className="sticky top-[76px]">
          <AccountNav activeId={section.id} />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {!isIndex && (
          <NextLink
            href="/user/account"
            className="mb-3 inline-flex items-center gap-1 text-sm text-blue-6 no-underline md:hidden"
          >
            <IconChevronLeft size={16} />
            Manage account
          </NextLink>
        )}

        <div className="mb-5 flex flex-col gap-1">
          <Text component="h1" className="text-2xl font-bold leading-tight">
            {title}
          </Text>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </div>

        <div className="flex flex-col gap-4">{children}</div>

        {isIndex && (
          <div className="mt-6">
            <MobileSectionList />
          </div>
        )}
      </div>
    </div>
  );
}
