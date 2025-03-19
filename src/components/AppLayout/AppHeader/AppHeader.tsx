import { ActionIcon, Alert, Button, Divider, Grid, Header } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { ReactElement, RefObject, useRef, useState } from 'react';
import { BrowsingModeIcon } from '~/components/BrowsingMode/BrowsingMode';
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
import { AutocompleteSearch } from '../../AutocompleteSearch/AutocompleteSearch';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserMenu } from '~/components/AppLayout/AppHeader/UserMenu';
import { CreateMenu } from '~/components/AppLayout/AppHeader/CreateMenu';
import { useDomainColor } from '~/hooks/useDomainColor';

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

export function AppHeader({
  renderSearchComponent = defaultRenderSearchComponent,
  fixed = true,
}: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const features = useFeatureFlags();
  const searchRef = useRef<HTMLInputElement>(null);
  const isMuted = currentUser?.muted ?? false;
  const domain = useDomainColor();

  const [showSearch, setShowSearch] = useState(false);
  const onSearchDone = () => setShowSearch(false);

  return (
    <>
      <Header
        height={HEADER_HEIGHT}
        fixed={fixed}
        zIndex={199}
        className={clsx({
          ['border-green-8 border-b-[3px]']: domain === 'green',
          ['border-red-8 border-b-[3px]']: domain === 'red',
        })}
      >
        <div className={clsx('h-full', { ['hidden']: !showSearch })}>
          {renderSearchComponent({ onSearchDone, isMobile: true, ref: searchRef })}
        </div>

        <Grid
          className={clsx('flex h-full flex-nowrap items-center justify-between px-2 @md:px-4', {
            ['hidden']: showSearch,
          })}
          m={0}
          gutter="xs"
          align="center"
        >
          <Grid.Col span="auto" pl={0}>
            <div className="flex items-center gap-2.5">
              <Logo />
              <SupportButton />
              {/* Disabled until next event */}
              {/* <EventButton /> */}
            </div>
          </Grid.Col>
          <Grid.Col span={6} md={4} className="@max-md:hidden">
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
              {currentUser && features.canChangeBrowsingLevel && <BrowsingModeIcon />}
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
              <ActionIcon onClick={() => setShowSearch(true)}>
                <IconSearch />
              </ActionIcon>
              {currentUser && <CivitaiLinkPopover />}
              {currentUser && <NotificationBell />}
              {currentUser && features.chat && <ChatButton />}
              {/*{currentUser?.isModerator && <ModerationNav />}*/}
              {currentUser && <ImpersonateButton />}
              <UserMenu />
            </div>
          </Grid.Col>
        </Grid>
      </Header>
      {domain === 'red' && (
        <div className="bg-red-8 text-center text-sm text-white">Adults Only &ndash; 18+</div>
      )}
    </>
  );
}

type Props = {
  renderSearchComponent?: (opts: RenderSearchComponentProps) => ReactElement;
  fixed?: boolean;
};
export type RenderSearchComponentProps = {
  onSearchDone?: () => void;
  isMobile: boolean;
  ref?: RefObject<HTMLInputElement>;
};
