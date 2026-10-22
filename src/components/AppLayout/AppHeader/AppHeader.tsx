import { Button, Divider, Grid } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ReactElement, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { BrowsingModeIcon } from '~/components/BrowsingMode/BrowsingMode';
import { ReadOnlyNotice } from '~/components/ReadOnlyNotice/ReadOnlyNotice';
import { ChatButton } from '~/components/Chat/ChatButton';
import { useChatEnabled } from '~/components/Chat/useChatEnabled';
import { CivitaiLinkPopover } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { Logo } from '~/components/Logo/Logo';
import { ImpersonateButton } from '~/components/Moderation/ImpersonateButton';
import { ModerationNav } from '~/components/Moderation/ModerationNav';
import { NotificationBell } from '~/components/Notifications/NotificationBell';
import { ResourceLoadDrain } from '~/components/ResourceLoad/resource-load.utils';
import { UploadTracker } from '~/components/Resource/UploadTracker';
import { SupportButton } from '~/components/SupportButton/SupportButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserMenu } from '~/components/AppLayout/AppHeader/UserMenu';
import { CreateMenu } from '~/components/AppLayout/AppHeader/CreateMenu';
import { YellowBuzzMigrationNotice } from '~/components/Alerts/YellowBuzzMigrationNotice';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ShellButton, ShellDivider, ShellLink } from '~/components/AppLayout/ShellDs/ShellDs';
import { HEADER_HEIGHT_PX } from '~/shared/constants/app-layout.constants';
import dynamic from 'next/dynamic';

const AutocompleteSearch = dynamic(
  () =>
    import('~/components/AutocompleteSearch/AutocompleteSearch').then((x) => x.AutocompleteSearch),
  { ssr: false }
);

function defaultRenderSearchComponent({ onSearchDone, isMobile, ref }: RenderSearchComponentProps) {
  if (isMobile) {
    return (
      <AutocompleteSearch
        variant="filled"
        onClear={onSearchDone}
        onSubmit={onSearchDone}
        rightSection={null}
        ref={ref}
      />
    );
  }

  return <AutocompleteSearch />;
}

export function AppHeader({ renderSearchComponent = defaultRenderSearchComponent }: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const features = useFeatureFlags();
  const ds = !!features.shellDesignSystemMarkup;
  // Gate on the user's resolved chat setting so the chat icon never flashes in
  // then out for users who have chat disabled. See useChatEnabled for details.
  const showChat = useChatEnabled();
  const searchWrapperRef = useRef<HTMLDivElement>(null);

  const [showSearch, setShowSearch] = useState(false);
  const onSearchDone = () => setShowSearch(false);

  // Finds the input in the DOM because a ref passed to the `dynamic` search component lands on
  // next/dynamic's own handle, not on the input. The category select inside the search is hidden at
  // this width, so take the first input that is shown. iOS Safari may still ignore a focus() made
  // outside the tap, which is why the close button below does not depend on it.
  useEffect(() => {
    if (!showSearch) return;
    const inputs = searchWrapperRef.current?.querySelectorAll('input') ?? [];
    Array.from(inputs)
      .find((input) => input.offsetParent !== null)
      ?.focus();
  }, [showSearch]);

  return (
    <header
      className={clsx('z-[199] border-b border-b-gray-2 dark:border-b-dark-5', {
        ['border-red-8 border-b-[3px]']: features.isRed,
      })}
      style={{ height: HEADER_HEIGHT_PX, borderBottomStyle: 'solid' }}
    >
      <div className={clsx('flex h-full items-center', { ['hidden']: !showSearch })}>
        <div ref={searchWrapperRef} className="h-full min-w-0 flex-1">
          {renderSearchComponent({ onSearchDone, isMobile: true })}
        </div>
        {/* A plain button: the design-system shell (flag ON) may not render Mantine roots, and the
            shell icon buttons top out below the 44px tap target. */}
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-dark-7 hover:bg-gray-1 dark:text-gray-4 dark:hover:bg-dark-5"
          onClick={onSearchDone}
          aria-label="Close search"
        >
          <IconX />
        </button>
      </div>

      <HeaderGrid
        ds={ds}
        className={clsx('flex h-full flex-nowrap items-center justify-between px-2 @md:px-4', {
          ['hidden']: showSearch,
        })}
      >
        <HeaderCol ds={ds} span="auto" first>
          <div className="flex items-center gap-2.5">
            <Logo />
            {!features.canWrite ? (
              <ReadOnlyNotice />
            ) : features.buzzSpendPop ? (
              // Hidden on phones for signed-in users to make room for the Buzz counter.
              <div className={clsx({ ['@max-md:hidden']: !!currentUser })}>
                <SupportButton />
              </div>
            ) : (
              <SupportButton />
            )}
            {/* Disabled until next event */}
            {/* <EventButton /> */}
          </div>
        </HeaderCol>
        <HeaderCol ds={ds} span="search" className="@max-md:hidden">
          {renderSearchComponent({ onSearchDone, isMobile: false })}
        </HeaderCol>
        <HeaderCol
          ds={ds}
          span="auto"
          className="flex items-center justify-end gap-3 @max-md:hidden"
        >
          <div className="flex items-center gap-3">
            <CreateMenu />
            {currentUser && (
              <>
                <UploadTracker />
                <CivitaiLinkPopover />
              </>
            )}
            {currentUser && features.resourceLoad && <ResourceLoadDrain />}
            {currentUser && features.canViewNsfw && <BrowsingModeIcon />}
            {currentUser && <NotificationBell />}
            {currentUser && showChat && <ChatButton />}
            {currentUser?.isModerator && <ModerationNav />}
            {currentUser && <ImpersonateButton />}
          </div>
          {!currentUser ? (
            ds ? (
              <ShellLink
                href={`/login?returnUrl=${router.asPath}`}
                rel="nofollow"
                variant="default"
                size="sm"
              >
                Sign In
              </ShellLink>
            ) : (
              <Button
                component={Link}
                href={`/login?returnUrl=${router.asPath}`}
                rel="nofollow"
                variant="default"
              >
                Sign In
              </Button>
            )
          ) : ds ? (
            <ShellDivider />
          ) : (
            <Divider orientation="vertical" />
          )}
          <YellowBuzzMigrationNotice>
            <UserMenu />
          </YellowBuzzMigrationNotice>
        </HeaderCol>
        <HeaderCol ds={ds} span="auto" className="flex items-center justify-end @md:hidden">
          <div className="flex items-center gap-1">
            <CreateMenu />
            {ds ? (
              <ShellButton
                variant="subtle-gray"
                icon="md"
                onClick={() => setShowSearch(true)}
                aria-label="Search"
              >
                <IconSearch />
              </ShellButton>
            ) : (
              <LegacyActionIcon
                variant="subtle"
                color="gray"
                onClick={() => setShowSearch(true)}
                aria-label="Search"
              >
                <IconSearch />
              </LegacyActionIcon>
            )}
            {currentUser && !features.buzzSpendPop && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            {currentUser && showChat && <ChatButton />}
            {/*{currentUser?.isModerator && <ModerationNav />}*/}
            {currentUser && <ImpersonateButton />}
            <UserMenu />
          </div>
        </HeaderCol>
      </HeaderGrid>
    </header>
  );
}

/*
 * The header row's `Grid`, and its flag-ON replacement as plain elements.
 *
 * `Grid` and each `Grid.Col` resolve styles per instance AND emit a `<style>` element of
 * per-instance custom properties (`--grid-gutter`, `--col-flex-basis`, …, with a media query for
 * the search column's responsive span) on every render. The ON branch writes the same
 * declarations Mantine's `Grid` stylesheet produces from those properties — gutter `xs`,
 * `align="center"`, `m={0}`, inner `flex-nowrap` — as static utilities.
 *
 * 🔴 `[@media(min-width:62em)]:` IS MANTINE'S `md` BREAKPOINT, NOT TAILWIND'S. `Grid` reads `theme.breakpoints`
 * (Mantine's default `md` = 62em, which this app's theme does not override). Tailwind's `md` and
 * the `@md:` container variant both come from `breakpoints.json` and switch at a different width,
 * so writing `md:` here would move the search column's width over a band of desktop widths.
 */
const GRID_GUTTER_HALF = 'p-[calc(var(--mantine-spacing-xs)/2)]';

function HeaderGrid({
  ds,
  className,
  children,
}: {
  ds: boolean;
  className: string;
  children: React.ReactNode;
}) {
  if (!ds)
    return (
      <Grid
        className={className}
        classNames={{ inner: 'flex-nowrap' }}
        m={0}
        gutter="xs"
        align="center"
      >
        {children}
      </Grid>
    );
  return (
    <div className={clsx(className, 'm-0 overflow-visible')}>
      <div className="m-[calc(var(--mantine-spacing-xs)/-2)] flex w-[calc(100%+var(--mantine-spacing-xs))] flex-nowrap items-center">
        {children}
      </div>
    </div>
  );
}

function HeaderCol({
  ds,
  span,
  first,
  className,
  children,
}: {
  ds: boolean;
  /** `auto` = `span="auto"`; `search` = `span={{ base: 6, md: 4 }}`. */
  span: 'auto' | 'search';
  /** The first column drops its leading gutter (`pl={0}`). */
  first?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (!ds)
    return (
      <Grid.Col
        span={span === 'search' ? { base: 6, md: 4 } : 'auto'}
        pl={first ? 0 : undefined}
        className={className}
      >
        {children}
      </Grid.Col>
    );
  return (
    <div
      className={clsx(
        'shrink-0',
        GRID_GUTTER_HALF,
        span === 'auto'
          ? 'max-w-full grow basis-0'
          : // Mantine computes these as `${100 / (12 / span)}%`, hence the long literal.
            'max-w-[50%] grow-0 basis-1/2 [@media(min-width:62em)]:max-w-[33.333333333333336%] [@media(min-width:62em)]:basis-[33.333333333333336%]',
        first && 'pl-0',
        className
      )}
    >
      {children}
    </div>
  );
}

type Props = {
  renderSearchComponent?: (opts: RenderSearchComponentProps) => ReactElement;
};
export type RenderSearchComponentProps = {
  onSearchDone?: (e?: React.SyntheticEvent<HTMLInputElement>) => void;
  isMobile: boolean;
  ref?: RefObject<HTMLInputElement>;
};
