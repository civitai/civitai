import type { DragEndEvent } from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Divider, Popover, Text, UnstyledButton } from '@mantine/core';
import {
  IconArrowsSort,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconGripVertical,
} from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  AccountSwitcher,
  BuzzMenuItem,
  MenuItemButton,
  MenuItemLink,
  UserMenuCtx,
  UserMenuFooter,
} from '~/components/AppLayout/AppHeader/UserMenu';
import { useGetCreator } from '~/components/AppLayout/AppHeader/hooks';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import { BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isPinnable, type ResolvedMenuItem, type ResolvedMenuNode } from './resolveUserMenu';
import {
  BadgeMuteCtx,
  canMuteBadge,
  MenuItemLabel,
  MuteGlyph,
  PinGlyph,
  PROFILE_PIN,
  useDragClickGuard,
  usePinActions,
  useTrackHeaderOpen,
  useTrackMenuOpen,
} from './UserMenuParts';
import type { PinTarget } from './UserMenuParts';
import { useSwipeBack } from './swipeBack';
import { useResolvedUserMenu } from './useResolvedUserMenu';
import type { UserMenuShellProps } from './UserMenuV2';
import classes from './UserMenuMobile.module.scss';

const ROW = 'flex items-center gap-2.5 rounded-lg px-4 py-3 hover:bg-gray-1 hover:dark:bg-dark-4';

type Pins = UserMenuShellProps['pins'];
type GroupNode = Extract<ResolvedMenuNode, { kind: 'group' }>;

export function UserMenuMobile({ open, setOpen, pins, trigger }: UserMenuShellProps) {
  return (
    <Popover
      width="100%"
      position="bottom-end"
      opened={open}
      onChange={setOpen}
      withinPortal
      // The header's own 199, which the sheet does not overlap, and below the modals (200+) and dialogs that open over the menu.
      zIndex={199}
      // The sheet covers the page, so Tab stays in it; Escape is handled inside the body.
      trapFocus
      returnFocus
      // Escape steps back a panel first; the body handles it.
      closeOnEscape={false}
    >
      <Popover.Target>
        {/* Popover.Target does not toggle on click; Menu.Target does, on desktop. */}
        {React.cloneElement(trigger, { onClick: () => setOpen(!open) })}
      </Popover.Target>
      {/* A sheet from under the header to the screen edge: the `!` classes beat floating-ui's inline position, and the insets are the page's own (`#__next` pads the top, no one pads the bottom). */}
      <Popover.Dropdown className="!fixed !inset-x-0 !bottom-0 !top-[calc(var(--safe-area-inset-top)+var(--header-height))] flex !h-auto !w-full !max-w-none flex-col !rounded-none !border-x-0 !border-b-0 p-0 pb-[var(--safe-area-inset-bottom)]">
        <UserMenuCtx.Provider value={{ handleClose: () => setOpen(false) }}>
          {/* Portaled out of the page's `@container`, so the menu's `@md:` variants need their own. */}
          <div className="flex min-h-0 flex-1 flex-col @container">
            <MobileBody pins={pins} close={() => setOpen(false)} />
          </div>
        </UserMenuCtx.Provider>
      </Popover.Dropdown>
    </Popover>
  );
}

function MobileBody({ pins, close }: { pins: Pins; close: () => void }) {
  const [path, setPath] = useState<GroupNode[]>([]);
  const [direction, setDirection] = useState<'in' | 'back'>('in');
  const [switching, setSwitching] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { signedIn, events, pinned, nodes } = useResolvedUserMenu({
    opened: true,
    pins: pins.pins,
    muted: pins.mutedBadges,
  });
  const pinActions = usePinActions(pins);
  const { announce, region } = pinActions;
  const toggleMute = signedIn ? pinActions.toggleMute : undefined;

  const focusFirst = () =>
    window.requestAnimationFrame(() =>
      container.current?.querySelector<HTMLElement>('[data-panel-row]')?.focus()
    );

  const enter = (group: GroupNode) => {
    setDirection('in');
    setPath((current) => [...current, group]);
    focusFirst();
  };
  const back = () => {
    const left = path[path.length - 1];
    setDirection('back');
    setPath((current) => current.slice(0, -1));
    window.requestAnimationFrame(() =>
      container.current?.querySelector<HTMLElement>(`[data-group-row="${left?.id}"]`)?.focus()
    );
  };

  const toggle = signedIn ? pinActions.toggle : undefined;

  // The current panel, re-read from the resolved tree so its badges stay live.
  const panel = path.reduce<GroupNode | undefined>(
    (parent, step) =>
      (parent ? parent.children : nodes).find(
        (node): node is GroupNode => node.kind === 'group' && node.id === step.id
      ),
    undefined
  );

  const swipe = useSwipeBack(back, path.length > 0);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // dnd-kit cancels a keyboard drag on this same Escape, from a listener on the document that a
    // stopped event never reaches.
    if (
      (event.target as HTMLElement).closest?.(
        '[aria-roledescription="sortable"][aria-pressed="true"]'
      )
    )
      return;
    event.stopPropagation();
    if (switching) setSwitching(false);
    else if (path.length) back();
    else close();
  };

  if (switching)
    return (
      <div className="flex flex-1 flex-col" onKeyDown={onKeyDown}>
        <AccountSwitcher onAccountClick={() => setSwitching(false)} />
      </div>
    );

  return (
    <BadgeMuteCtx.Provider value={toggleMute}>
      <div ref={container} className="flex flex-1 flex-col overflow-hidden" onKeyDown={onKeyDown}>
        {region}
        <div
          key={path.map((step) => step.id).join('/') || 'top'}
          className={clsx(
            'flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin',
            path.length || direction === 'back'
              ? classes[direction === 'in' ? 'panelIn' : 'panelBack']
              : undefined
          )}
          // A vertical pan still scrolls; the browser leaves the horizontal swipe to us.
          style={path.length ? { touchAction: 'pan-y' } : undefined}
          {...swipe}
        >
          {panel ? (
            <>
              <UnstyledButton className={ROW} onClick={back} data-panel-row>
                <IconChevronLeft />
                <span className="text-sm font-semibold leading-none">{panel.label}</span>
              </UnstyledButton>
              <Divider />
              <MobileNodes nodes={panel.children} pins={pins} onToggle={toggle} onEnter={enter} />
            </>
          ) : (
            <TopLevel
              signedIn={signedIn}
              events={events}
              pinned={pinned}
              nodes={nodes}
              pins={pins}
              onToggle={toggle}
              onEnter={enter}
              close={close}
              announce={announce}
            />
          )}
        </div>
        {!panel && (
          <UserMenuFooter
            onSwitchAccount={() => {
              // The top level remounts when the switcher closes; it should not replay a back slide.
              setDirection('in');
              setSwitching(true);
            }}
          />
        )}
      </div>
    </BadgeMuteCtx.Provider>
  );
}

function TopLevel({
  signedIn,
  events,
  pinned,
  nodes,
  pins,
  onToggle,
  onEnter,
  close,
  announce,
}: {
  signedIn: boolean;
  events: UserMenuItem[];
  pinned: ResolvedMenuItem[];
  nodes: ResolvedMenuNode[];
  pins: Pins;
  onToggle?: (item: PinTarget) => void;
  onEnter: (group: GroupNode) => void;
  close: () => void;
  announce: (text: string) => void;
}) {
  const currentUser = useCurrentUser();

  return (
    <>
      {currentUser && (
        <MobileHeaderRows
          pinned={pins.pins.includes(PROFILE_PIN.id)}
          onTogglePin={onToggle ? () => onToggle(PROFILE_PIN) : undefined}
        />
      )}
      {events.map((item, i) => (
        <MobileItem key={`event-${i}`} item={item} />
      ))}
      {signedIn && (
        <MobilePinned pinned={pinned} pins={pins} onToggle={onToggle} announce={announce} />
      )}
      <Divider />
      <MobileNodes nodes={nodes} pins={pins} onToggle={onToggle} onEnter={onEnter} />
      {currentUser && (
        <>
          <Divider />
          <div className="p-3">
            <BrowsingModeMenu closeMenu={close} compact />
          </div>
        </>
      )}
    </>
  );
}

export function MobileHeaderRows({
  pinned = false,
  onTogglePin,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const currentUser = useCurrentUser();
  const creator = useGetCreator();
  const { handleClose } = useContext(UserMenuCtx);
  const trackHeader = useTrackHeaderOpen('mobile');
  if (!currentUser) return null;

  return (
    <div className="flex items-center gap-1 pr-1">
      <MenuItemLink
        href={`/user/${currentUser.username}`}
        className="min-w-0 rounded-lg !pr-2"
        onClick={() => {
          trackHeader('profile');
          handleClose();
        }}
        data-panel-row
      >
        {/* Clips the name sideways only: an avatar frame reaches past the avatar's box, top and bottom too. */}
        <div className="-ml-2 min-w-0 overflow-x-clip pl-2">
          <UserAvatar user={creator ?? currentUser} withUsername withHoverCard={false} />
        </div>
      </MenuItemLink>
      <div className="ml-auto">
        <BuzzMenuItem compact onOpen={() => trackHeader('buzz-dashboard')} />
      </div>
      {onTogglePin && (
        <LegacyActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          className="shrink-0"
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${PROFILE_PIN.label}`}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <PinGlyph pinned={pinned} touch />
        </LegacyActionIcon>
      )}
    </div>
  );
}

export function MobilePinned({
  pinned,
  pins,
  onToggle,
  announce,
}: {
  pinned: ResolvedMenuItem[];
  pins: Pins;
  onToggle?: (item: ResolvedMenuItem) => void;
  announce: (text: string) => void;
}) {
  const guard = useDragClickGuard();
  const [reordering, setReordering] = useState(false);
  // No PointerSensor: a finger emits pointer events too, so it would start a drag on any swipe.
  // Reordering drags by a handle that opts out of scrolling, so a touch needs no hold first.
  // The keyboard sensor takes Enter and Space from any row it can reach, so only the handles get it.
  const keyboard = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: reordering ? { distance: 4 } : { delay: 250, tolerance: 6 },
    }),
    reordering ? keyboard : undefined
  );

  useEffect(() => {
    if (!pinned.length) setReordering(false);
  }, [pinned.length]);

  if (!pinned.length)
    return (
      <Text size="xs" c="dimmed" px="md" py={6}>
        Tap the pin on any item to keep it here.
      </Text>
    );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    guard.onDragSettled();
    if (!over || active.id === over.id) return;
    pins.move(active.id as ResolvedMenuItem['id'], over.id as ResolvedMenuItem['id']);
    const item = pinned.find((x) => x.id === active.id);
    if (item) announce(`Moved ${item.label}`);
  };

  // Holding a link opens iOS's preview instead of lifting the row, so a phone reorders in a mode.
  const canReorder = !!onToggle && pins.canEdit && pinned.length > 1;
  const finishReordering = () => {
    setReordering(false);
    pins.flush();
  };

  return (
    <>
      <div className="flex items-center justify-between pb-0.5 pl-4 pr-2 pt-2">
        <Text size="xs" c="dimmed" fw={600}>
          Pinned
        </Text>
        {(canReorder || reordering) && (
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            className="!h-8"
            leftSection={reordering ? <IconCheck size={16} /> : <IconArrowsSort size={16} />}
            aria-pressed={reordering}
            onClick={reordering ? finishReordering : () => setReordering(true)}
          >
            {reordering ? 'Done' : 'Reorder'}
          </Button>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={guard.onDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={guard.onDragSettled}
      >
        <SortableContext items={pinned.map((x) => x.id)} strategy={verticalListSortingStrategy}>
          {pinned.map((item) => (
            <SortableMobileItem
              key={item.id}
              item={item}
              onToggle={onToggle}
              reordering={reordering}
            />
          ))}
        </SortableContext>
      </DndContext>
    </>
  );
}

function SortableMobileItem({
  item,
  onToggle,
  reordering,
}: {
  item: ResolvedMenuItem;
  onToggle?: (item: ResolvedMenuItem) => void;
  reordering: boolean;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative',
    zIndex: isDragging ? 1 : undefined,
  } as const;

  if (reordering)
    return (
      <div ref={setNodeRef} style={style} className="flex items-center pr-2">
        <div className={clsx(ROW, 'min-w-0 flex-1 hover:bg-transparent')}>
          <item.icon stroke={1.5} color={item.color} />
          <MenuItemLabel item={item} />
        </div>
        <LegacyActionIcon
          ref={setActivatorNodeRef}
          size="lg"
          variant="subtle"
          color="gray"
          aria-label={`Reorder ${item.label}`}
          // The handle opts out of scrolling, so a finger on it drags the row instead.
          style={{ touchAction: 'none' }}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical />
        </LegacyActionIcon>
      </div>
    );

  return (
    <div ref={setNodeRef} {...listeners} style={{ ...style, touchAction: 'pan-y' }}>
      <MobileItem item={item} pinned fromPins onToggle={onToggle} />
    </div>
  );
}

function MobileNodes({
  nodes,
  pins,
  onToggle,
  onEnter,
}: {
  nodes: ResolvedMenuNode[];
  pins: Pins;
  onToggle?: (item: ResolvedMenuItem) => void;
  onEnter: (group: GroupNode) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'item' ? (
          <MobileItem
            key={node.item.id}
            item={node.item}
            pinned={pins.pins.includes(node.item.id)}
            onToggle={onToggle}
          />
        ) : (
          <UnstyledButton
            key={node.id}
            className={clsx(ROW, 'w-full')}
            onClick={() => onEnter(node)}
            data-group-row={node.id}
            data-panel-row
          >
            <node.icon stroke={1.5} />
            <MenuItemLabel item={{ label: node.label, icon: node.icon, badge: node.badge }} />
            <IconChevronRight className="ml-auto" size={18} />
          </UnstyledButton>
        )
      )}
    </>
  );
}

export function MobileItem({
  item,
  pinned = false,
  fromPins = false,
  onToggle,
}: {
  item: UserMenuItem & { badgeMuted?: boolean };
  pinned?: boolean;
  fromPins?: boolean;
  onToggle?: (item: ResolvedMenuItem) => void;
}) {
  const { handleClose } = useContext(UserMenuCtx);
  const toggleMute = useContext(BadgeMuteCtx);
  const trackOpen = useTrackMenuOpen('mobile');
  const { id } = item;
  // Replaces each row's own `handleClose` click handler, so it has to close the menu too.
  const open = () => {
    trackOpen(id, fromPins);
    handleClose();
  };
  const canPin = !!onToggle && !!id && isPinnable(id);
  const canMute = canMuteBadge(item, toggleMute);
  const content = (
    <>
      <item.icon stroke={1.5} color={item.color} />
      <MenuItemLabel item={item} />
    </>
  );

  const link = item.href ? (
    item.external ? (
      <a
        href={item.href}
        target="_blank"
        rel="nofollow noreferrer"
        className={clsx(ROW, { ['flex-1']: canPin || canMute })}
        onClick={open}
        data-panel-row
      >
        {content}
      </a>
    ) : (
      <MenuItemLink
        href={item.href}
        as={item.as}
        rel={item.rel}
        className={clsx('rounded-lg', { ['flex-1']: canPin || canMute })}
        onClick={open}
        data-panel-row
      >
        {content}
      </MenuItemLink>
    )
  ) : (
    <MenuItemButton
      onClick={() => {
        open();
        item.onClick?.();
      }}
      className={clsx('rounded-lg', { ['flex-1']: canPin || canMute })}
      data-panel-row
    >
      {content}
    </MenuItemButton>
  );

  if (!canPin && !canMute) return link;
  // A row, not one button: the pin and the mute are controls of their own, and a button cannot hold another.
  return (
    <div className="flex items-center pr-2">
      {link}
      {canMute && (
        <LegacyActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          aria-label={`Mute the count on ${item.label}`}
          aria-pressed={!!item.badgeMuted}
          onClick={() => id && toggleMute?.({ ...item, id })}
        >
          <MuteGlyph muted={!!item.badgeMuted} touch />
        </LegacyActionIcon>
      )}
      {canPin && (
        <LegacyActionIcon
          size="lg"
          variant="subtle"
          color="gray"
          aria-label={`${pinned ? 'Unpin' : 'Pin'} ${item.label}`}
          aria-pressed={pinned}
          onClick={() => onToggle({ ...item, id })}
        >
          <PinGlyph pinned={pinned} touch />
        </LegacyActionIcon>
      )}
    </div>
  );
}
