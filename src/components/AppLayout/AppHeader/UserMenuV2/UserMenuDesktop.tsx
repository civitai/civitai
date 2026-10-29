import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Menu, Text, UnstyledButton } from '@mantine/core';
import { IconChevronRight, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { createContext, useContext, useRef, useState } from 'react';
import {
  AccountSwitcher,
  BuzzBalances,
  UserMenuCtx,
  UserMenuFooter,
} from '~/components/AppLayout/AppHeader/UserMenu';
import { useGetCreator } from '~/components/AppLayout/AppHeader/hooks';
import { useBuyBuzz } from '~/components/Buzz/buzz.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isPinnable, type ResolvedMenuItem, type ResolvedMenuNode } from './resolveUserMenu';
import {
  ACCOUNT_CARD_FRAME,
  BadgeMuteCtx,
  canMuteBadge,
  isMuteKey,
  isPinKey,
  MenuItemLabel,
  MuteGlyph,
  PinGlyph,
  PROFILE_PIN,
  pinMoveDirection,
  useDragClickGuard,
  usePinActions,
  useTrackHeaderOpen,
  useTrackMenuOpen,
} from './UserMenuParts';
import { useResolvedUserMenu } from './useResolvedUserMenu';
import type { UserMenuShellProps } from './UserMenuV2';

/**
 * Flyouts are nested `Menu`s, not `Menu.Sub`: Mantine 7.17 ships the MenuSub files but never
 * attaches or exports them (8.0 does), so nesting and arrow keys are wired here.
 */
export function UserMenuDesktop({ open, setOpen, pins, trigger }: UserMenuShellProps) {
  const [switching, setSwitching] = useState(false);

  return (
    <Menu
      opened={open}
      onChange={(next) => {
        setOpen(next);
        if (!next) setSwitching(false);
      }}
      position="bottom-end"
      width={260}
      shadow="md"
      withinPortal
    >
      <Menu.Target>{trigger}</Menu.Target>
      <Menu.Dropdown className="flex max-h-[calc(100dvh-var(--header-height)-16px)] flex-col p-0">
        <UserMenuCtx.Provider value={{ handleClose: () => setOpen(false) }}>
          {switching ? (
            <AccountSwitcher onAccountClick={() => setSwitching(false)} />
          ) : (
            <>
              <DesktopBody pins={pins} />
              <UserMenuFooter onSwitchAccount={() => setSwitching(true)} />
            </>
          )}
        </UserMenuCtx.Provider>
      </Menu.Dropdown>
    </Menu>
  );
}

type Pins = UserMenuShellProps['pins'];

function DesktopBody({ pins }: { pins: Pins }) {
  const currentUser = useCurrentUser();
  const { signedIn, events, pinned, nodes } = useResolvedUserMenu({
    opened: true,
    pins: pins.pins,
    muted: pins.mutedBadges,
    mobile: false,
  });
  const { toggle, toggleMute, announce, region } = usePinActions(pins);

  return (
    <BadgeMuteCtx.Provider value={signedIn ? toggleMute : undefined}>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 scrollbar-thin">
        {region}
        {currentUser && (
          <DesktopHeaderRows
            pinned={pins.pins.includes(PROFILE_PIN.id)}
            onTogglePin={signedIn ? () => toggle(PROFILE_PIN) : undefined}
          />
        )}
        {events.map((item, i) => (
          <DesktopItem key={`event-${i}`} item={item} />
        ))}
        {currentUser && (
          <PinnedList pinned={pinned} pins={pins} onToggle={toggle} announce={announce} />
        )}
        <Menu.Divider />
        <DesktopNodes nodes={nodes} pins={pins} onToggle={signedIn ? toggle : undefined} />
      </div>
    </BadgeMuteCtx.Provider>
  );
}

export function PinnedList({
  pinned,
  pins,
  onToggle,
  announce,
}: {
  pinned: ResolvedMenuItem[];
  pins: Pins;
  onToggle: (item: ResolvedMenuItem) => void;
  announce: (text: string) => void;
}) {
  const guard = useDragClickGuard();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  if (!pinned.length)
    return (
      <Text size="xs" c="dimmed" px="sm" py={6}>
        Hover any item and click the pin to keep it here.
      </Text>
    );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    guard.onDragSettled();
    if (over && active.id !== over.id)
      pins.move(active.id as ResolvedMenuItem['id'], over.id as ResolvedMenuItem['id']);
  };

  const moveByKeyboard = (item: ResolvedMenuItem, direction: number, row: HTMLElement) => {
    const index = pinned.findIndex((x) => x.id === item.id);
    const over = pinned[index + direction];
    if (!over) return;
    pins.move(item.id, over.id);
    announce(`Moved ${item.label} ${direction < 0 ? 'up' : 'down'}`);
    // Mantine's own arrow handling moves focus to the neighbor after ours; put it back.
    window.requestAnimationFrame(() => row.focus());
  };

  return (
    <>
      <Menu.Label>Pinned</Menu.Label>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={guard.onDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={guard.onDragSettled}
      >
        <SortableContext items={pinned.map((x) => x.id)} strategy={verticalListSortingStrategy}>
          {pinned.map((item) => (
            <SortablePinnedItem
              key={item.id}
              item={item}
              onToggle={onToggle}
              onMove={moveByKeyboard}
            />
          ))}
        </SortableContext>
      </DndContext>
    </>
  );
}

function SortablePinnedItem({
  item,
  onToggle,
  onMove,
}: {
  item: ResolvedMenuItem;
  onToggle: (item: ResolvedMenuItem) => void;
  onMove: (item: ResolvedMenuItem, direction: number, row: HTMLElement) => void;
}) {
  // Pointer listeners only: dnd-kit's `attributes` would replace the row's menuitem role.
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  return (
    <DesktopItem
      item={item}
      pinned
      fromPins
      onToggle={onToggle}
      rowRef={setNodeRef}
      rowProps={{
        ...listeners,
        style: {
          transform: CSS.Transform.toString(transform),
          transition,
          zIndex: isDragging ? 1 : undefined,
          position: 'relative',
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
          const direction = pinMoveDirection(event);
          if (direction) onMove(item, direction, event.currentTarget);
        },
      }}
    />
  );
}

export function DesktopNodes({
  nodes,
  pins,
  onToggle,
}: {
  nodes: ResolvedMenuNode[];
  pins: Pins;
  onToggle?: (item: ResolvedMenuItem) => void;
}) {
  // One flyout per level: opening a group closes its siblings at once, instead of each on its own timer.
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  return (
    <>
      {nodes.map((node) =>
        node.kind === 'item' ? (
          <DesktopItem
            key={node.item.id}
            item={node.item}
            pinned={pins.pins.includes(node.item.id)}
            onToggle={onToggle}
          />
        ) : (
          <DesktopGroup
            key={node.id}
            node={node}
            pins={pins}
            onToggle={onToggle}
            opened={openGroup === node.id}
            setOpened={(next) =>
              setOpenGroup((current) => (next ? node.id : current === node.id ? null : current))
            }
          />
        )
      )}
    </>
  );
}

const FlyoutCtx = createContext<{ closeToRow: () => void } | null>(null);

const HOVER_OPEN_MS = 80;
const HOVER_CLOSE_MS = 180;

// Group rows are plain buttons, so Mantine's arrow navigation does not reach them.
function focusSibling(row: HTMLElement, step: number) {
  const level = row.closest('[data-menu-dropdown]');
  if (!level) return;
  const rows = Array.from(
    level.querySelectorAll<HTMLElement>('[data-menu-item]:not([data-disabled])')
  ).filter((el) => el.closest('[data-menu-dropdown]') === level);
  const index = rows.indexOf(row);
  rows[(index + step + rows.length) % rows.length]?.focus();
}

function DesktopGroup({
  node,
  pins,
  onToggle,
  opened,
  setOpened,
}: {
  node: Extract<ResolvedMenuNode, { kind: 'group' }>;
  pins: Pins;
  onToggle?: (item: ResolvedMenuItem) => void;
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const timer = useRef<number>();
  const row = useRef<HTMLButtonElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);

  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  // The flyout mounts a frame or two after it opens; wait for its first row.
  const focusFirst = (tries = 10) =>
    window.requestAnimationFrame(() => {
      const first = dropdown.current?.querySelector<HTMLElement>(
        '[data-menu-item]:not([data-disabled])'
      );
      if (first) first.focus();
      else if (tries > 0) focusFirst(tries - 1);
    });
  const closeToRow = () => {
    window.clearTimeout(timer.current);
    setOpened(false);
    row.current?.focus();
  };

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      position="left-start"
      offset={4}
      width="max-content"
      shadow="md"
      // Inside the parent's dropdown, so a click in the flyout is not a click outside the menu;
      // fixed, so the parent's scroll box does not clip it.
      withinPortal={false}
      floatingStrategy="fixed"
      // Focus moves in only from the keyboard; a hover must not steal it.
      trapFocus={false}
      returnFocus={false}
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <UnstyledButton
          ref={row}
          data-menu-item
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={opened}
          className={clsx(
            'flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left hover:bg-gray-1 focus-visible:bg-gray-1 dark:hover:bg-dark-5 dark:focus-visible:bg-dark-5',
            { ['bg-gray-1 dark:bg-dark-5']: opened }
          )}
          onMouseEnter={() => later(() => setOpened(true), HOVER_OPEN_MS)}
          onMouseLeave={() => later(() => setOpened(false), HOVER_CLOSE_MS)}
          onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => {
            const key = event.key;
            // Stopped so the parent dropdown, which also handles arrows, does not move focus too.
            if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'Enter', ' '].includes(key))
              event.stopPropagation();
            if (key === 'ArrowDown' || key === 'ArrowUp') {
              event.preventDefault();
              focusSibling(event.currentTarget, key === 'ArrowDown' ? 1 : -1);
            } else if (key === 'ArrowRight' || key === 'Enter' || key === ' ') {
              event.preventDefault();
              setOpened(true);
              focusFirst();
            }
          }}
        >
          <node.icon size={18} stroke={1.5} />
          <MenuItemLabel item={{ label: node.label, icon: node.icon, badge: node.badge }} />
          <IconChevronRight size={14} className="ml-auto" />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown
        ref={dropdown}
        className="min-w-[240px] max-w-[22rem] p-1"
        onMouseEnter={() => window.clearTimeout(timer.current)}
        onMouseLeave={() => later(() => setOpened(false), HOVER_CLOSE_MS)}
      >
        <FlyoutCtx.Provider value={{ closeToRow }}>
          <DesktopNodes nodes={node.children} pins={pins} onToggle={onToggle} />
        </FlyoutCtx.Provider>
      </Menu.Dropdown>
    </Menu>
  );
}

export function DesktopItem({
  item,
  pinned = false,
  fromPins = false,
  onToggle,
  rowRef,
  rowProps,
}: {
  item: Omit<ResolvedMenuItem, 'id'> & { id?: ResolvedMenuItem['id'] };
  pinned?: boolean;
  fromPins?: boolean;
  onToggle?: (item: ResolvedMenuItem) => void;
  rowRef?: (node: HTMLElement | null) => void;
  rowProps?: Record<string, unknown> & {
    onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
}) {
  const { handleClose } = useContext(UserMenuCtx);
  const flyout = useContext(FlyoutCtx);
  const trackOpen = useTrackMenuOpen('desktop');
  const toggleMute = useContext(BadgeMuteCtx);
  const id = item.id;
  const canPin = !!onToggle && !!id && isPinnable(id);
  const canMute = canMuteBadge(item, toggleMute);
  const toggle = () => canPin && onToggle({ ...item, id });
  const mute = () => canMute && id && toggleMute?.({ ...item, id });

  const common = {
    ref: rowRef,
    ...rowProps,
    className: 'group',
    leftSection: <item.icon size={18} stroke={1.5} color={item.color} />,
    rightSection:
      canPin || canMute ? (
        <span className="flex items-center">
          {canMute && (
            <span
              // Not its own tab stop either: `M` mutes the count from the keyboard.
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                mute();
              }}
              className="flex cursor-pointer items-center p-0.5"
              title={item.badgeMuted ? 'Unmute count' : 'Mute count'}
            >
              <MuteGlyph muted={!!item.badgeMuted} />
            </span>
          )}
          {canPin && (
            <span
              // Not its own tab stop: the row is the menu item, and `P` pins it from the keyboard.
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggle();
              }}
              className="flex cursor-pointer items-center p-0.5"
              title={pinned ? 'Unpin' : 'Pin'}
            >
              <PinGlyph pinned={pinned} />
            </span>
          )}
        </span>
      ) : undefined,
    'aria-keyshortcuts': [canPin && 'P', canMute && 'M'].filter(Boolean).join(' ') || undefined,
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      rowProps?.onKeyDown?.(event);
      if (canPin && isPinKey(event)) {
        event.preventDefault();
        toggle();
      } else if (canMute && isMuteKey(event)) {
        event.preventDefault();
        mute();
      } else if (flyout && event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        flyout.closeToRow();
      }
    },
    // An item in a flyout closes only the flyout's own menu; close the whole thing.
    onClick: (event: React.MouseEvent) => {
      if (event.defaultPrevented) return;
      trackOpen(id, fromPins);
      item.onClick?.();
      handleClose();
    },
    children: <MenuItemLabel item={item} />,
  };

  if (item.href && item.external)
    return (
      <Menu.Item
        {...common}
        component="a"
        href={item.href}
        target="_blank"
        rel="nofollow noreferrer"
      />
    );
  if (item.href)
    return (
      <Menu.Item {...common} component={NextLink} href={item.href} as={item.as} rel={item.rel} />
    );
  return <Menu.Item {...common} />;
}

export function DesktopHeaderRows({
  pinned = false,
  onTogglePin,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const currentUser = useCurrentUser();
  const creator = useGetCreator();
  const trackHeader = useTrackHeaderOpen('desktop');
  if (!currentUser) return null;

  return (
    <div data-account-card className={clsx(ACCOUNT_CARD_FRAME, 'm-1 flex flex-col gap-1 p-1')}>
      <Menu.Item
        component={NextLink}
        href={`/user/${currentUser.username}`}
        className="group rounded-lg"
        aria-keyshortcuts={onTogglePin ? 'P' : undefined}
        rightSection={
          onTogglePin ? (
            <span
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin();
              }}
              className="flex cursor-pointer items-center p-0.5"
              title={pinned ? 'Unpin' : 'Pin'}
            >
              <PinGlyph pinned={pinned} />
            </span>
          ) : undefined
        }
        onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
          if (onTogglePin && isPinKey(event)) {
            event.preventDefault();
            onTogglePin();
          }
        }}
        onClick={() => trackHeader('profile')}
      >
        <UserAvatar user={creator ?? currentUser} withUsername withHoverCard={false} />
      </Menu.Item>
      <DesktopBuzzItem onOpen={() => trackHeader('buzz-dashboard')} />
    </div>
  );
}

function DesktopBuzzItem({ onOpen }: { onOpen: () => void }) {
  const features = useFeatureFlags();
  const onBuyBuzz = useBuyBuzz();
  if (!features.buzz) return null;

  return (
    <Menu.Item
      component={NextLink}
      href="/user/buzz-dashboard"
      // Buy Buzz below stops its click, so it is not counted as an open.
      onClick={onOpen}
      className="rounded-lg bg-blue-1 dark:bg-dark-7/60"
      rightSection={
        <LegacyActionIcon
          component="div"
          role="button"
          variant="light"
          color="blue"
          radius="md"
          size={24}
          aria-label="Buy Buzz"
          title="Buy Buzz"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            onBuyBuzz({});
          }}
        >
          <IconPlus size={16} />
        </LegacyActionIcon>
      }
    >
      <span className="flex items-center gap-1">
        <BuzzBalances
          animated={features.buzzSpendPop}
          iconSize={16}
          textSize="md"
          withAbbreviation
          withTooltip
        />
      </span>
    </Menu.Item>
  );
}
