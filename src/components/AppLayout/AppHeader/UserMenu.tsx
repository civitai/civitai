import {
  Avatar,
  Badge,
  Button,
  Divider,
  Popover,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
  getPrimaryShade,
  useMantineColorScheme,
} from '@mantine/core';
import { CountIndicator } from '~/components/AppLayout/AppHeader/CountIndicator';
import { useHotkeys } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowsExchange,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconLogout,
  IconLogout2,
  IconMoonStars,
  IconScreenShare,
  IconSettings,
  IconSun,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import type { LinkProps } from 'next/link';
import { useRouter } from 'next/router';
import React, {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useGetEdgeUrl } from '~/client-utils/cf-images-utils';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import {
  useGetActionMenuItems,
  useGetCreator,
  useGetMenuItems,
} from '~/components/AppLayout/AppHeader/hooks';
import { BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { Burger } from '~/components/Burger/Burger';
import { useBuyBuzz } from '~/components/Buzz/buzz.utils';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import {
  type CivitaiAccount,
  useAccountContext,
} from '~/components/CivitaiWrapped/AccountProvider';
import { openCivitaiLinkDialog } from '~/components/CivitaiLink/CivitaiLinkPopover';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { useSupportOption } from '~/components/SupportButton/SupportButton';
import { HeaderUserBuzz } from '~/components/AppLayout/AppHeader/HeaderUserBuzz';
import { UserBuzz } from '~/components/User/UserBuzz';
import { Username } from '~/components/User/Username';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getInitials } from '~/utils/string-helpers';

export const UserMenuCtx = createContext<{ handleClose: () => void }>({
  handleClose: () => undefined,
});
function useUserMenuContext() {
  return useContext(UserMenuCtx);
}

// ssr: false: rendered on the server, the lazy chunk was not ready at hydration and React
// reported a mismatch.
const UserMenuV2 = dynamic(() => import('~/components/AppLayout/AppHeader/UserMenuV2/UserMenuV2'), {
  ssr: false,
  loading: () => <UserMenuTrigger open={false} />,
});

export function UserMenu() {
  const features = useFeatureFlags();
  return features.userMenuV2 ? <UserMenuV2 /> : <LegacyUserMenu />;
}

/** `badge` is the count label (e.g. "5", "99+"); it is drawn exactly like the bell's and chat's. */
export const UserMenuTrigger = forwardRef<
  HTMLButtonElement,
  { open: boolean; badge?: string; className?: string; onClick?: () => void }
>(function UserMenuTrigger({ open, badge, className, ...props }, ref) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const creator = useGetCreator();

  return (
    <UnstyledButton
      ref={ref}
      aria-label={currentUser ? `Account menu${badge ? `, ${badge} waiting for you` : ''}` : 'Menu'}
      className={clsx(
        'flex items-center rounded-[var(--mantine-radius-default)] hover:bg-gray-1 @md:rounded-[32px] dark:hover:bg-dark-5',
        { ['bg-gray-1 dark:bg-dark-5']: open },
        className
      )}
      type="button"
      {...props}
    >
      <div
        className={clsx('flex items-center gap-2', {
          ['hidden']: !currentUser,
          ['@max-md:hidden']: !features.buzzSpendPop,
        })}
      >
        <div className="@max-md:hidden">
          <CountIndicator label={badge} disabled={!badge}>
            <UserAvatar user={creator ?? currentUser} size="md" withHoverCard={false} />
          </CountIndicator>
        </div>
        {features.buzz && currentUser && <HeaderUserBuzz />}
      </div>
      <div className={clsx({ ['@md:hidden']: !!currentUser })}>
        <CountIndicator label={badge} disabled={!badge}>
          <Burger opened={open} />
        </CountIndicator>
      </div>
    </UnstyledButton>
  );
});

function LegacyUserMenu() {
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const [open, setOpen] = useState(false);

  return (
    <Popover width={isMobile ? '100%' : 260} position="bottom-end" opened={open} onChange={setOpen}>
      <Popover.Target>
        <UserMenuTrigger open={open} onClick={() => setOpen((o) => !o)} />
      </Popover.Target>
      <Popover.Dropdown className="flex flex-col p-0 @max-md:mt-2 @max-md:h-[calc(100%-var(--header-height))]">
        <UserMenuCtx.Provider value={{ handleClose: () => setOpen(false) }}>
          <PopoverContent />
        </UserMenuCtx.Provider>
      </Popover.Dropdown>
    </Popover>
  );
}

// function useOutsideClick<T extends HTMLElement>(callback: (event: Event) => void) {
//   const ref = useRef<T | null>(null);
//   const callbackRef = useRef<((event: Event) => void) | null>(null);
//   callbackRef.current = callback;

//   useEffect(() => {
//     const handleClick = (event: Event) => {
//       if (ref.current && !ref.current.contains(event.target as any)) {
//         callbackRef.current?.(event);
//       }
//     };

//     document.addEventListener('click', handleClick);

//     return () => {
//       document.removeEventListener('click', handleClick);
//     };
//   }, [ref]);

//   return ref;
// }

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
  const currentUser = useCurrentUser();
  const creator = useGetCreator();

  const { handleClose } = useUserMenuContext();
  const menuItems = useGetMenuItems();
  const actionItems = useGetActionMenuItems();

  const groups = menuItems.filter((x) => x.visible);

  return (
    <>
      <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin">
        {currentUser && (
          <MenuItemButton className="flex items-center justify-between" onClick={onAccountClick}>
            <UserAvatar user={creator ?? currentUser} withUsername withHoverCard={false} />
            <IconChevronRight />
          </MenuItemButton>
        )}
        {currentUser && <BuzzMenuItem />}
        <div className="@md:hidden">
          <UserMenuItems items={actionItems} />
          <PhoneHeaderShortcuts />
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
      <UserMenuFooter />
    </>
  );
}

export function UserMenuFooter({ onSwitchAccount }: { onSwitchAccount?: () => void }) {
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const { toggleColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme('dark');
  const { logout } = useAccountContext();
  const { handleClose } = useUserMenuContext();

  return (
    <div className="flex gap-3 border-t border-gray-3 px-3 py-2 dark:border-dark-4">
      <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
        <LegacyActionIcon
          color="gray"
          variant="default"
          onClick={() => toggleColorScheme()}
          size="lg"
          className="flex-1"
        >
          {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoonStars size={18} />}
        </LegacyActionIcon>
      </Tooltip>
      {currentUser && (
        <>
          {onSwitchAccount && (
            <Tooltip label="Switch account">
              <LegacyActionIcon
                variant="default"
                color="gray"
                size="lg"
                onClick={onSwitchAccount}
                className="flex-1"
                aria-label="Switch account"
              >
                <IconArrowsExchange stroke={1.5} />
              </LegacyActionIcon>
            </Tooltip>
          )}
          <Tooltip label="Account settings">
            <LegacyActionIcon
              variant="default"
              color="gray"
              size="lg"
              onClick={handleClose}
              component={NextLink}
              href="/user/account"
              className="flex-1"
            >
              <IconSettings stroke={1.5} />
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Logout">
            <LegacyActionIcon
              variant="default"
              color="gray"
              onClick={() => logout()}
              size="lg"
              className="flex-1"
            >
              <IconLogout
                stroke={1.5}
                color={theme.colors.red[getPrimaryShade(theme, colorScheme)]}
              />
            </LegacyActionIcon>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function PhoneHeaderShortcuts() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const support = useSupportOption();
  const { handleClose } = useUserMenuContext();

  if (!currentUser || !features.buzzSpendPop) return null;

  const items: UserMenuItem[] = [
    { href: support.href, icon: support.icon, label: support.text, visible: features.canWrite },
    {
      icon: IconScreenShare,
      label: 'Civitai Link',
      onClick: () => {
        handleClose();
        openCivitaiLinkDialog();
      },
    },
  ];

  return <UserMenuItems items={items} />;
}

function UserMenuItems({ items }: { items: UserMenuItem[] }) {
  return (
    <>
      {items
        .filter((x) => !('visible' in x) || !!x.visible)
        .map((item, index) => {
          const content = (
            <>
              <item.icon stroke={1.5} color={item.color} />
              <span className="text-sm leading-none">{item.label}</span>
              {item.currency && <CurrencyIcon currency={Currency.BUZZ} size={16} />}
              {/* NEW first, then the count, both immediately after the label
                  rather than pushed to the right edge — the two badges read as
                  one group belonging to the entry. */}
              {(item.isNew || (!!item.newUntil && Date.now() < item.newUntil.getTime())) && (
                <Badge color="green.8" variant="filled" size="sm" ml={4}>
                  NEW
                </Badge>
              )}
              <QueueCountBadge count={item.badge ?? 0} max={99} ml={4} />
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

export function AccountSwitcher({ onAccountClick }: { onAccountClick: () => void }) {
  const { accounts, swapAccount, removeAccount } = useAccountContext();
  const { handleClose } = useUserMenuContext();

  // Confirmed because this sits next to the switch target, so a mis-click is easy — and the roster is
  // DURABLE: an entry stays listed after its seamless-switch window lapses, so removing is the only way
  // to clear one short of signing out of every account on this browser.
  const handleRemoveAccount = (id: number, username?: string) =>
    openConfirmModal({
      title: 'Remove account',
      children: (
        <Text size="sm">
          Remove <b>{username ?? 'this account'}</b> from this browser? You can sign back in at any
          time — this does not delete the account.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => removeAccount(id),
    });

  return (
    <div className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin">
      <MenuItemButton onClick={onAccountClick}>
        <IconChevronLeft />
        <span className="text-sm leading-none">Back</span>
      </MenuItemButton>
      <Divider />
      {Object.entries(accounts).map(([k, v]) => (
        // Row, not a MenuItemButton: the remove control is a second button, and a button cannot be
        // nested inside one. The hover styling moves to the row so both halves light up together.
        <div key={k} className="flex items-center pr-2 hover:bg-gray-1 hover:dark:bg-dark-4">
          <UnstyledButton
            onClick={v.active ? undefined : () => swapAccount(v.id)}
            className={clsx(
              'flex flex-1 items-center justify-between gap-2.5 px-4 py-3 @md:px-3 @md:py-2.5',
              { ['cursor-auto']: v.active }
            )}
          >
            <div className="flex items-center gap-2">
              <CustomUserAvatar data={v} />
              <Username username={v.username} />
            </div>
            {v.active ? (
              <IconCircleCheck size={20} color="green" />
            ) : v.needsLogin ? (
              // Aged out of the seamless-switch window — clicking re-authenticates at the hub.
              <span className="text-xs opacity-60">Sign in</span>
            ) : null}
          </UnstyledButton>
          {!v.active && (
            <LegacyActionIcon
              size="sm"
              aria-label={`Remove ${v.username ?? 'this account'} from this browser`}
              onClick={() => handleRemoveAccount(v.id, v.username)}
            >
              <IconX size={16} />
            </LegacyActionIcon>
          )}
        </div>
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
        leftSection={<IconLogout stroke={1.5} size={18} />}
        loading={loggingOut}
        disabled={loggingOutAll}
        onClick={handleLogout}
      >
        {loggingOut ? 'Logging out...' : 'Logout'}
      </Button>
      <Button
        variant="default"
        leftSection={<IconLogout2 stroke={1.5} size={18} />}
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
  const colorScheme = useComputedColorScheme('dark');
  const { avatarUrl, email, username } = data;
  const imageUrl = useGetEdgeUrl(avatarUrl, { width: 96, optimized: true });
  const avatarBgColor = colorScheme === 'dark' ? 'rgba(255,255,255,0.31)' : 'rgba(0,0,0,0.31)';

  return (
    <Tooltip label={email}>
      <Avatar
        src={imageUrl}
        alt={email}
        radius="xl"
        size="sm"
        imageProps={{ loading: 'lazy', referrerPolicy: 'no-referrer' }}
        style={{ backgroundColor: avatarBgColor }}
      >
        {getInitials(username)}
      </Avatar>
    </Tooltip>
  );
}

export function MenuItemButton({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLButtonElement>) {
  const { handleClose } = useUserMenuContext();
  return (
    <UnstyledButton
      className={clsx(
        'flex items-center gap-2.5 px-4 py-3 hover:bg-gray-1 @md:px-3 @md:py-2.5 hover:dark:bg-dark-4',
        className
      )}
      onClick={handleClose}
      {...props}
    >
      {children}
    </UnstyledButton>
  );
}

export function MenuItemLink({
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

/** `onOpen` runs when the row itself is opened, not when Buy Buzz is pressed. */
export function BuzzMenuItem({ onOpen }: { onOpen?: () => void } = {}) {
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
      onClick={() => {
        onOpen?.();
        handleClose();
      }}
    >
      <div className="flex items-center gap-1" onClick={handleClose}>
        <BuzzBalances
          animated={features.buzzSpendPop}
          iconSize={16}
          textSize={isMobile ? 'sm' : 'md'}
          withAbbreviation={!isMobile}
          withTooltip={!isMobile}
        />
      </div>
      <Button
        component="div"
        variant="white"
        radius="xl"
        px={12}
        size="compact-xs"
        onClick={(e: React.MouseEvent) => {
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

type BuzzBalanceProps = Pick<
  React.ComponentProps<typeof UserBuzz>,
  'animated' | 'iconSize' | 'textSize' | 'withAbbreviation' | 'withTooltip'
>;

/**
 * Blue Buzz and the domain's own Buzz as separate balances, never summed. `labelled` draws them as one
 * strip on a single row, with an optional `action` at its end. When the row does not fit, the "Blue" and
 * "Yellow" labels go first, then the amounts abbreviate.
 */
export function BuzzBalances({
  labelled = false,
  href,
  onOpen,
  action,
  ...buzzProps
}: BuzzBalanceProps & {
  labelled?: boolean;
  /** `labelled` only: the balances open this page. */
  href?: string;
  onOpen?: () => void;
  /** `labelled` only: a control at the strip's end, outside the link. */
  action?: React.ReactNode;
}) {
  const [mainBuzzColor] = useAvailableBuzz();
  const types: BuzzSpendType[] = ['blue', mainBuzzColor];
  const stripRef = useRef<HTMLDivElement>(null);
  // 0: labels and full amounts, 1: no labels, 2: no labels and abbreviated amounts.
  const [fit, setFit] = useState(0);

  // Start over from the roomiest layout whenever the strip's width changes.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    let width = strip.clientWidth;
    const observer = new ResizeObserver(() => {
      if (strip.clientWidth === width) return;
      width = strip.clientWidth;
      setFit(0);
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);
  // A layout that overflows steps down to the next one; runs after every render so a growing balance
  // is caught too.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bounded: it only steps down while fit < 2
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip && strip.scrollWidth > strip.clientWidth && fit < 2) setFit(fit + 1);
  });

  if (!labelled)
    return (
      <>
        {types.map((type) => (
          <UserBuzz key={type} accountTypes={[type]} {...buzzProps} />
        ))}
      </>
    );

  const balances = (
    <>
      {types.map((type) => (
        <BuzzBalanceSegment
          key={type}
          type={type}
          showLabel={fit === 0}
          buzzProps={{ ...buzzProps, withAbbreviation: fit === 2 }}
        />
      ))}
    </>
  );

  return (
    <div
      ref={stripRef}
      className="flex flex-nowrap items-stretch overflow-hidden rounded-lg bg-blue-1 dark:bg-dark-7/60"
    >
      {href ? (
        <NextLink href={href} onClick={onOpen} className="flex min-w-0 flex-1">
          {balances}
        </NextLink>
      ) : (
        <div className="flex min-w-0 flex-1">{balances}</div>
      )}
      {action && <div className="flex shrink-0 items-center pr-2">{action}</div>}
    </div>
  );
}

function BuzzBalanceSegment({
  type,
  showLabel,
  buzzProps,
}: {
  type: BuzzSpendType;
  showLabel: boolean;
  buzzProps: BuzzBalanceProps;
}) {
  const {
    data: { total },
  } = useQueryBuzz([type]);
  const name = `${type} Buzz ${total.toLocaleString()}`;

  return (
    <div
      role="group"
      aria-label={name}
      title={name}
      data-buzz-balance={type}
      className="flex flex-[1_0_auto] items-center justify-between gap-3 whitespace-nowrap border-l border-gray-3 px-3 py-2 first:border-l-0 dark:border-dark-4"
    >
      {showLabel && (
        <Text size="xs" c="dimmed" tt="capitalize">
          {type}
        </Text>
      )}
      <UserBuzz accountTypes={[type]} {...buzzProps} />
    </div>
  );
}
