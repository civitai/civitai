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
  IconPlus,
} from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  AccountSwitcher,
  BuzzBalances,
  MenuItemButton,
  MenuItemLink,
  UserMenuCtx,
  UserMenuFooter,
} from '~/components/AppLayout/AppHeader/UserMenu';
import { MembershipTierBadge } from '~/components/Account/MembershipTierBadge';
import { useGetCreator } from '~/components/AppLayout/AppHeader/hooks';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import { BrowsingModeMenu } from '~/components/BrowsingMode/BrowsingMode';
import { useBuyBuzz } from '~/components/Buzz/buzz.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import { SupportChip } from '~/components/SupportButton/SupportButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
  const [direction, setDirection] = useState<'in' | 'back' | 'none'>('in');
  const [switching, setSwitching] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { signedIn, events, pinned, nodes } = useResolvedUserMenu({
    opened: true,
    pins: pins.pins,
    muted: pins.mutedBadges,
    mobile: true,
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
  // A swipe has already shown the level behind, so it lands without sliding in again.
  const back = ({ slide = true } = {}) => {
    const left = path[path.length - 1];
    setDirection(slide ? 'back' : 'none');
    setPath((current) => current.slice(0, -1));
    focusGroupRow(left?.id);
  };
  // After a swipe the level that is landing may not have committed yet, and the copy of it still
  // behind the panel is inert and cannot take focus.
  const focusGroupRow = (id: string | undefined, attempts = 3): number =>
    window.requestAnimationFrame(() => {
      const row = [
        ...(container.current?.querySelectorAll<HTMLElement>(`[data-group-row="${id}"]`) ?? []),
      ].find((candidate) => !candidate.closest('[inert]'));
      if (row) row.focus();
      else if (attempts > 1) focusGroupRow(id, attempts - 1);
    });

  const toggle = signedIn ? pinActions.toggle : undefined;

  // The panel `depth` levels down the path, re-read from the resolved tree so its badges stay live.
  const panelAt = (depth: number) =>
    path
      .slice(0, depth)
      .reduce<GroupNode | undefined>(
        (parent, step) =>
          (parent ? parent.children : nodes).find(
            (node): node is GroupNode => node.kind === 'group' && node.id === step.id
          ),
        undefined
      );
  const panel = panelAt(path.length);

  const swipe = useSwipeBack({ enabled: path.length > 0, onBack: () => back({ slide: false }) });

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

  const level = (shown: GroupNode | undefined) =>
    shown ? (
      <>
        <UnstyledButton className={ROW} onClick={() => back()} data-panel-row>
          <IconChevronLeft />
          <span className="text-sm font-semibold leading-none">{shown.label}</span>
        </UnstyledButton>
        <Divider />
        <MobileNodes nodes={shown.children} pins={pins} onToggle={toggle} onEnter={enter} />
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
    );

  if (switching)
    return (
      <div className="flex flex-1 flex-col" onKeyDown={onKeyDown}>
        <AccountSwitcher onAccountClick={() => setSwitching(false)} />
      </div>
    );

  return (
    <BadgeMuteCtx.Provider value={toggleMute}>
      <div
        ref={container}
        className="relative flex flex-1 flex-col overflow-hidden"
        onKeyDown={onKeyDown}
      >
        {region}
        <div
          key={path.map((step) => step.id).join('/') || 'top'}
          ref={swipe.ref}
          className={clsx(
            'flex flex-1 flex-col overflow-y-auto overflow-x-hidden p-1 scrollbar-thin',
            direction !== 'none' && (path.length || direction === 'back')
              ? classes[direction === 'in' ? 'panelIn' : 'panelBack']
              : undefined,
            // Opaque, so the level behind a dragged panel shows only where the panel has moved off it.
            path.length > 0 && 'relative z-10 bg-[var(--mantine-color-body)]'
          )}
          // A vertical pan still scrolls; the browser leaves the horizontal swipe to us.
          style={path.length ? { touchAction: 'pan-y' } : undefined}
          {...swipe.bind}
        >
          {level(panel)}
        </div>
        {swipe.dragging && (
          // Not a second menu: a picture of the level the swipe is going back to.
          <div
            ref={swipe.behindRef}
            aria-hidden
            {...{ inert: '' }}
            className="pointer-events-none absolute inset-0 flex flex-col"
          >
            <div className="flex flex-1 flex-col overflow-hidden p-1">
              {level(panelAt(path.length - 1))}
            </div>
            {path.length === 1 && <UserMenuFooter onSwitchAccount={() => undefined} />}
          </div>
        )}
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

/** The viewer's card at the top of the phone menu: who they are, their Buzz, and Buy Buzz. */
export function MobileHeaderRows({
  pinned = false,
  onTogglePin,
}: {
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const currentUser = useCurrentUser();
  const creator = useGetCreator();
  const features = useFeatureFlags();
  const onBuyBuzz = useBuyBuzz();
  const { handleClose } = useContext(UserMenuCtx);
  const trackHeader = useTrackHeaderOpen('mobile');
  if (!currentUser) return null;

  return (
    // Opening focuses the card itself, not its first link, so a tap does not light a focus ring on the name.
    <div
      tabIndex={-1}
      data-autofocus
      className="m-1 flex flex-col gap-3 rounded-xl bg-gray-1 p-2 outline-none dark:bg-dark-6"
    >
      <div className="flex items-center gap-1">
        <MenuItemLink
          href={`/user/${currentUser.username}`}
          className="min-w-0 flex-1 rounded-lg"
          onClick={() => {
            trackHeader('profile');
            handleClose();
          }}
          data-panel-row
        >
          {/* Clips the name sideways only: an avatar frame reaches past the avatar's box, top and bottom too.
              Username's drop shadow is for names over media; on this flat card it smudges the name. */}
          <div className="-ml-2 min-w-0 overflow-x-clip pl-2 [&_.mantine-Text-root]:filter-none">
            <UserAvatar
              user={creator ?? currentUser}
              size="lg"
              withUsername
              textSize="lg"
              subText={
                currentUser.tier ? <MembershipTierBadge tier={currentUser.tier} /> : undefined
              }
              withHoverCard={false}
            />
          </div>
        </MenuItemLink>
        {!currentUser.tier && <SupportChip onClick={handleClose} />}
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
      {features.buzz && (
        <>
          <NextLink
            href="/user/buzz-dashboard"
            className="block rounded-lg px-1"
            onClick={() => {
              trackHeader('buzz-dashboard');
              handleClose();
            }}
          >
            <BuzzBalances
              labelled
              animated={features.buzzSpendPop}
              iconSize={16}
              textSize="md"
              withAbbreviation={false}
            />
          </NextLink>
          <Button
            variant="light"
            radius="md"
            fullWidth
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              // The sheet covers the screen and holds focus, so it closes before the purchase opens.
              handleClose();
              onBuyBuzz({});
            }}
          >
            Buy Buzz
          </Button>
        </>
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

  const row = item.href ? (
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

  const link =
    item.redirectReason && item.href ? (
      <LoginRedirect reason={item.redirectReason} returnUrl={item.href}>
        {row}
      </LoginRedirect>
    ) : (
      row
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
