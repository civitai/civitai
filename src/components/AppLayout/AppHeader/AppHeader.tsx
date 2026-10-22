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
        <LegacyActionIcon
          className="shrink-0"
          size={44}
          onClick={onSearchDone}
          aria-label="Close search"
        >
          <IconX />
        </LegacyActionIcon>
      </div>

      <Grid
        className={clsx('flex h-full flex-nowrap items-center justify-between px-2 @md:px-4', {
          ['hidden']: showSearch,
        })}
        classNames={{ inner: 'flex-nowrap' }}
        m={0}
        gutter="xs"
        align="center"
      >
        <Grid.Col span="auto" pl={0}>
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
        </Grid.Col>
        <Grid.Col
          span={{
            base: 6,
            md: 4,
          }}
          className="@max-md:hidden"
        >
          {renderSearchComponent({ onSearchDone, isMobile: false })}
        </Grid.Col>
        <Grid.Col span="auto" className="flex items-center justify-end gap-3 @max-md:hidden">
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
            <Button
              component={Link}
              href={`/login?returnUrl=${router.asPath}`}
              rel="nofollow"
              variant="default"
            >
              Sign In
            </Button>
          ) : (
            <Divider orientation="vertical" />
          )}
          <YellowBuzzMigrationNotice>
            <UserMenu />
          </YellowBuzzMigrationNotice>
        </Grid.Col>
        <Grid.Col span="auto" className="flex items-center justify-end @md:hidden">
          <div className="flex items-center gap-1">
            <CreateMenu />
            <LegacyActionIcon
              variant="subtle"
              color="gray"
              onClick={() => setShowSearch(true)}
              aria-label="Search"
            >
              <IconSearch />
            </LegacyActionIcon>
            {currentUser && !features.buzzSpendPop && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            {currentUser && showChat && <ChatButton />}
            {/*{currentUser?.isModerator && <ModerationNav />}*/}
            {currentUser && <ImpersonateButton />}
            <UserMenu />
          </div>
        </Grid.Col>
      </Grid>
    </header>
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
