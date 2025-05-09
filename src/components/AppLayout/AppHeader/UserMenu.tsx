import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Divider,
  Popover,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconLogout,
  IconLogout2,
  IconMoonStars,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { LinkProps } from 'next/link';
import { useRouter } from 'next/router';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useGetEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  useGetActionMenuItems,
  useGetCreator,
  useGetMenuItems,
  UserMenuItem,
} from '~/components/AppLayout/AppHeader/hooks';
import { BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { Burger } from '~/components/Burger/Burger';
import { useBuyBuzz } from '~/components/Buzz/buzz.utils';
import {
  type CivitaiAccount,
  useAccountContext,
} from '~/components/CivitaiWrapped/AccountProvider';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserBuzz } from '~/components/User/UserBuzz';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getInitials } from '~/utils/string-helpers';

const UserMenuCtx = createContext<{ handleClose: () => void }>({ handleClose: () => undefined });
function useUserMenuContext() {
  return useContext(UserMenuCtx);
}

export function UserMenu() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const creator = useGetCreator();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const [open, setOpen] = useState(false);

  return (
    <Popover width={isMobile ? '100%' : 260} position="bottom-end" opened={open} onChange={setOpen}>
      <Popover.Target>
        <UnstyledButton
          className="flex items-center @md:rounded-[32px]"
          type="button"
          onClick={() => setOpen((o) => !o)}
        >
          <div
            className={clsx('flex items-center gap-2 @max-md:hidden', {
              ['hidden']: !currentUser,
            })}
          >
            <UserAvatar user={creator ?? currentUser} size="md" />
            {features.buzz && currentUser && <UserBuzz pr="sm" />}
          </div>
          <Burger opened={open} className={clsx({ ['@md:hidden']: !!currentUser })} />
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown className="flex flex-col p-0 @max-md:mt-2 @max-md:h-[calc(100%-var(--header-height))]">
        <UserMenuCtx.Provider value={{ handleClose: () => setOpen(false) }}>
          <PopoverContent />
        </UserMenuCtx.Provider>
      </Popover.Dropdown>
    </Popover>
  );
}

function useOutsideClick<T extends HTMLElement>(callback: (event: Event) => void) {
  const ref = useRef<T | null>(null);
  const callbackRef = useRef<((event: Event) => void) | null>(null);
  callbackRef.current = callback;

  useEffect(() => {
    const handleClick = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as any)) {
        callbackRef.current?.(event);
      }
    };

    document.addEventListener('click', handleClick);

    return () => {
      document.removeEventListener('click', handleClick);
    };
  }, [ref]);

  return ref;
}

function PopoverContent() {
  const { handleClose } = useUserMenuContext();
  const [accountSwitching, setAccountSwitching] = useState(false);
  function handleToggleAccountSwitching() {
    setAccountSwitching((o) => !o);
  }
  useHotkeys([['Escape', handleClose]]);

  return (
    <div
      // ref={ref}
      className="flex h-full flex-1 flex-col @md:max-h-[calc(90vh-var(--header-height))]"
    >
      {accountSwitching ? (
        <AccountSwitcher onAccountClick={handleToggleAccountSwitching} />
      ) : (
        <UserMenuContent onAccountClick={handleToggleAccountSwitching} />
      )}
    </div>
  );
}

function UserMenuContent({ onAccountClick }: { onAccountClick: () => void }) {
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const creator = useGetCreator();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const { logout } = useAccountContext();

  const { handleClose } = useUserMenuContext();
  const menuItems = useGetMenuItems();
  const actionItems = useGetActionMenuItems();

  const groups = menuItems.filter((x) => x.visible);

  return (
    <>
      <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin">
        {currentUser && (
          <MenuItemButton className="flex items-center justify-between" onClick={onAccountClick}>
            <UserAvatar user={creator ?? currentUser} withUsername />
            <IconChevronRight />
          </MenuItemButton>
        )}
        {currentUser && <BuzzMenuItem />}
        <div className="@md:hidden">
          <UserMenuItems items={actionItems} />
          <Divider />
        </div>
        {groups.map((group, i) => {
          return (
            <React.Fragment key={i}>
              {i !== 0 && i < groups.length && <Divider />}
              <UserMenuItems items={group.items} />
            </React.Fragment>
          );
        })}
        {currentUser && (
          <div className="@md:hidden">
            <Divider />
            <div className="p-3">
              <BrowsingModeMenu closeMenu={handleClose} />
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-3 border-t border-gray-3 px-3 py-2 dark:border-dark-4">
        <Tooltip label="Color scheme">
          <ActionIcon
            variant="default"
            onClick={() => toggleColorScheme()}
            size="lg"
            className="flex-1"
            sx={(theme) => ({
              color:
                theme.colorScheme === 'dark'
                  ? theme.colors.yellow[theme.fn.primaryShade()]
                  : theme.colors.blue[theme.fn.primaryShade()],
            })}
          >
            {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoonStars size={18} />}
          </ActionIcon>
        </Tooltip>
        {currentUser && (
          <>
            <Tooltip label="Account settings">
              <ActionIcon
                variant="default"
                size="lg"
                onClick={handleClose}
                component={NextLink}
                href="/user/account"
                className="flex-1"
              >
                <IconSettings stroke={1.5} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Logout">
              <ActionIcon variant="default" onClick={() => logout()} size="lg" className="flex-1">
                <IconLogout stroke={1.5} color={theme.colors.red[theme.fn.primaryShade()]} />
              </ActionIcon>
            </Tooltip>
          </>
        )}
      </div>
    </>
  );
}

function UserMenuItems({ items }: { items: UserMenuItem[] }) {
  return (
    <>
      {items
        .filter((x) => x.visible !== false)
        .map((item, index) => {
          const content = (
            <>
              <item.icon stroke={1.5} color={item.color} />
              <span className="text-sm leading-none">{item.label}</span>
              {item.currency && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
              {!!item.newUntil && Date.now() < item.newUntil.getTime() && (
                <Badge color="green.8" variant="filled" size="sm" ml={4}>
                  NEW
                </Badge>
              )}
            </>
          );
          const linkOrButton = item.href ? (
            <MenuItemLink href={item.href} rel={item.rel} as={item.as}>
              {content}
            </MenuItemLink>
          ) : (
            <MenuItemButton onClick={item.onClick}>{content}</MenuItemButton>
          );
          return item.redirectReason ? (
            <LoginRedirect key={index} reason={item.redirectReason} returnUrl={item.href}>
              {linkOrButton}
            </LoginRedirect>
          ) : (
            <React.Fragment key={index}>{linkOrButton}</React.Fragment>
          );
        })}
    </>
  );
}

function AccountSwitcher({ onAccountClick }: { onAccountClick: () => void }) {
  const { accounts, swapAccount } = useAccountContext();
  const { handleClose } = useUserMenuContext();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin">
      <MenuItemButton onClick={onAccountClick}>
        <IconChevronLeft />
        <span className="text-sm leading-none">Back</span>
      </MenuItemButton>
      <Divider />
      {Object.entries(accounts).map(([k, v]) => (
        <MenuItemButton
          key={k}
          onClick={v.active ? undefined : () => swapAccount(v.token)}
          className={clsx('flex items-center justify-between gap-2.5', {
            ['cursor-auto']: v.active,
          })}
        >
          <div className="flex items-center gap-2">
            <CustomUserAvatar data={v} />
            <Username username={v.username} />
          </div>
          {v.active && <IconCircleCheck size={20} color="green" />}
        </MenuItemButton>
      ))}
      <Divider />
      <div className="p-4 @md:p-1 @md:pt-2">
        <ActionButtons close={handleClose} />
      </div>
    </div>
  );
}

function ActionButtons({ close }: { close: () => void }) {
  const router = useRouter();
  const { logout, logoutAll } = useAccountContext();
  const [waiting, setWaiting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  const handleAdd = () => {
    setWaiting(true);
    router
      .push(
        getLoginLink({
          returnUrl: router.asPath,
          reason: 'switch-accounts',
        })
      )
      .then(() => {
        close();
        setWaiting(false);
      });
  };

  const handleLogout = () => {
    setLoggingOut(true);
    logout().catch((e) => {
      setLoggingOut(false);
      showErrorNotification({
        title: 'Error logging out',
        error: new Error(e.message),
      });
    });
  };
  const handleLogoutAll = () => {
    setLoggingOutAll(true);
    logoutAll().catch((e) => {
      setLoggingOutAll(false);
      showErrorNotification({
        title: 'Error logging out',
        error: new Error(e.message),
      });
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Button variant="light" loading={waiting} onClick={handleAdd}>
        {waiting ? 'Redirecting...' : 'Add Account'}
      </Button>
      <Button
        variant="default"
        leftIcon={<IconLogout stroke={1.5} size={18} />}
        loading={loggingOut}
        disabled={loggingOutAll}
        onClick={handleLogout}
      >
        {loggingOut ? 'Logging out...' : 'Logout'}
      </Button>
      <Button
        variant="default"
        leftIcon={<IconLogout2 stroke={1.5} size={18} />}
        loading={loggingOutAll}
        disabled={loggingOut}
        onClick={handleLogoutAll}
      >
        {loggingOutAll ? 'Logging out...' : 'Logout All'}
      </Button>
    </div>
  );
}

function CustomUserAvatar({ data }: { data: CivitaiAccount }) {
  const theme = useMantineTheme();
  const { avatarUrl, email, username } = data;
  const imageUrl = useGetEdgeUrl(avatarUrl, { width: 96 });
  const avatarBgColor =
    theme.colorScheme === 'dark' ? 'rgba(255,255,255,0.31)' : 'rgba(0,0,0,0.31)';

  return (
    <Tooltip label={email}>
      <Avatar
        src={imageUrl}
        alt={email}
        radius="xl"
        size="sm"
        imageProps={{ loading: 'lazy', referrerPolicy: 'no-referrer' }}
        sx={{ backgroundColor: avatarBgColor }}
      >
        {getInitials(username)}
      </Avatar>
    </Tooltip>
  );
}

function MenuItemButton({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLButtonElement>) {
  const { handleClose } = useUserMenuContext();
  return (
    <button
      className={clsx(
        'flex items-center gap-2.5 px-4 py-3 hover:bg-gray-1 @md:px-3 @md:py-2.5 hover:dark:bg-dark-4',
        className
      )}
      onClick={handleClose}
      {...props}
    >
      {children}
    </button>
  );
}

function MenuItemLink({
  children,
  className,
  ...props
}: LinkProps & { children: React.ReactNode; className?: string; rel?: string }) {
  const { handleClose } = useUserMenuContext();
  return (
    <NextLink
      className={clsx(
        'flex items-center gap-2.5 px-4 py-3 hover:bg-gray-1 @md:px-3 @md:py-2.5 hover:dark:bg-dark-4',
        className
      )}
      onClick={handleClose}
      {...props}
    >
      {children}
    </NextLink>
  );
}

function BuzzMenuItem() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const onBuyBuzz = useBuyBuzz();
  const { handleClose } = useUserMenuContext();

  if (!features.buzz) return null;
  if (!currentUser) return null;

  return (
    <MenuItemLink
      href="/user/buzz-dashboard"
      className="-mx-1 my-1 flex items-center justify-between bg-gray-2 dark:bg-dark-4"
    >
      <div className="flex items-center gap-1" onClick={handleClose}>
        <UserBuzz
          iconSize={16}
          textSize={isMobile ? 'sm' : 'md'}
          withAbbreviation={!isMobile}
          withTooltip={!isMobile}
          accountType="user"
        />
        <UserBuzz
          iconSize={16}
          textSize={isMobile ? 'sm' : 'md'}
          withAbbreviation={!isMobile}
          withTooltip={!isMobile}
          accountType="generation"
        />
      </div>
      <Button
        component="div"
        variant="white"
        radius="xl"
        px={12}
        size="compact-xs"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onBuyBuzz({});
        }}
      >
        Buy Buzz
      </Button>
    </MenuItemLink>
  );
}
