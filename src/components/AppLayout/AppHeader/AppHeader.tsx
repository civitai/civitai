import { Button, Divider, Grid } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ReactElement, RefObject } from 'react';
import { useRef, useState } from 'react';
import { BrowsingModeIcon } from '~/components/BrowsingMode/BrowsingMode';
import { ReadOnlyNotice } from '~/components/ReadOnlyNotice/ReadOnlyNotice';
import { ChatButton } from '~/components/Chat/ChatButton';
import { CivitaiLinkPopover } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { Logo } from '~/components/Logo/Logo';
import { ImpersonateButton } from '~/components/Moderation/ImpersonateButton';
import { ModerationNav } from '~/components/Moderation/ModerationNav';
import { NotificationBell } from '~/components/Notifications/NotificationBell';
import { UploadTracker } from '~/components/Resource/UploadTracker';
import { SupportButton } from '~/components/SupportButton/SupportButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserMenu } from '~/components/AppLayout/AppHeader/UserMenu';
import { CreateMenu } from '~/components/AppLayout/AppHeader/CreateMenu';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import dynamic from 'next/dynamic';

const AutocompleteSearch = dynamic(
  () =>
    import('~/components/AutocompleteSearch/AutocompleteSearch').then((x) => x.AutocompleteSearch),
  { ssr: false }
);

const HEADER_HEIGHT = 60;

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
  const searchRef = useRef<HTMLInputElement>(null);
  const isMuted = currentUser?.muted ?? false;

  const [showSearch, setShowSearch] = useState(false);
  const onSearchDone = () => setShowSearch(false);

  return (
    <header
      className={clsx('z-[199] border-b border-b-gray-2 dark:border-b-dark-5', {
        ['border-green-8 border-b-[3px]']: features.isGreen,
        ['border-red-8 border-b-[3px]']: features.isRed,
      })}
      style={{ height: HEADER_HEIGHT, borderBottomStyle: 'solid' }}
    >
      <div className={clsx('h-full', { ['hidden']: !showSearch })}>
        {renderSearchComponent({ onSearchDone, isMobile: true, ref: searchRef })}
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
            {!features.canWrite ? <ReadOnlyNotice /> : <SupportButton />}
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
            {!isMuted && <CreateMenu />}
            {currentUser && (
              <>
                <UploadTracker />
                <CivitaiLinkPopover />
              </>
            )}
            {currentUser && features.canViewNsfw && <BrowsingModeIcon />}
            {currentUser && <NotificationBell />}
            {currentUser && features.chat && <ChatButton />}
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
          <UserMenu />
        </Grid.Col>
        <Grid.Col span="auto" className="flex items-center justify-end @md:hidden">
          <div className="flex items-center gap-1">
            {!isMuted && <CreateMenu />}
            <LegacyActionIcon variant="subtle" color="gray" onClick={() => setShowSearch(true)}>
              <IconSearch />
            </LegacyActionIcon>
            {currentUser && <CivitaiLinkPopover />}
            {currentUser && <NotificationBell />}
            {currentUser && features.chat && <ChatButton />}
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
  onSearchDone?: () => void;
  isMobile: boolean;
  ref?: RefObject<HTMLInputElement>;
};
